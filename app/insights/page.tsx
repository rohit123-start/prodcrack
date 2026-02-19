'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import ChatInterface from '@/components/ChatInterface'
import { getCurrentUser, getPostAuthRedirectTarget } from '@/lib/auth'
import { getRepositories } from '@/lib/repositories'
import { supabase } from '@/lib/supabase'
import { Repository, User } from '@/types'

type StakeholderSection = {
  summary: string
  metrics: Record<string, number>
  report: string[]
}

type StakeholderReports = {
  cto: StakeholderSection
  pm: StakeholderSection
  operations: StakeholderSection
}

export default function InsightsPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>()
  const [reportsByRepo, setReportsByRepo] = useState<Record<string, StakeholderReports>>({})
  const [isGeneratingReport, setIsGeneratingReport] = useState(false)
  const [reportError, setReportError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const loadUser = async () => {
      try {
        const target = await getPostAuthRedirectTarget()
        if (target !== '/dashboard') {
          router.replace(target)
          return
        }

        const currentUser = await getCurrentUser()
        if (!currentUser) {
          router.replace('/onboarding')
          return
        }

        if (!currentUser.currentOrganizationId) {
          router.replace('/onboarding')
          return
        }

        setUser(currentUser)
        const repos = await getRepositories(currentUser.currentOrganizationId)
        setRepositories(repos)
        // Auto-select first ingested repo if available
        const ingestedRepo = repos.find(r => r.isIngested)
        if (ingestedRepo) {
          setSelectedRepoId(ingestedRepo.id)
        }
      } catch (error) {
        console.error('Error loading user:', error)
        router.replace('/login')
      } finally {
        setIsLoading(false)
      }
    }
    loadUser()
  }, [router])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return null
  }

  const ingestedRepos = repositories.filter(r => r.isIngested)
  const selectedReports = selectedRepoId ? reportsByRepo[selectedRepoId] : null

  const formatMetricLabel = (key: string) =>
    key
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')

  const sectionTitle: Record<keyof StakeholderReports, string> = {
    cto: 'CTO Report',
    pm: 'PM Report',
    operations: 'Operations Report',
  }

  const handleGenerateReports = async () => {
    if (!selectedRepoId) {
      setReportError('Select a repository to generate reports.')
      return
    }
    setIsGeneratingReport(true)
    setReportError(null)
    try {
      const { data: authData } = await supabase.auth.getSession()
      const accessToken = authData.session?.access_token
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ repositoryId: selectedRepoId }),
      })
      const data = await response.json()
      if (!data.success || !data.reports) {
        setReportError(data.message || 'Failed to generate reports')
        return
      }
      setReportsByRepo((prev) => ({ ...prev, [selectedRepoId]: data.reports as StakeholderReports }))
    } catch (error) {
      console.error('Generate reports failed:', error)
      setReportError('Failed to generate reports')
    } finally {
      setIsGeneratingReport(false)
    }
  }

  return (
    <div className="flex h-screen bg-[#0a0a0a]">
      <Sidebar />
      <div className="flex-1 flex flex-col">
        <div className="border-b border-[#1f1f1f] p-4 bg-[#0f0f0f]">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-white mb-1">Product Insights</h1>
              <p className="text-sm text-gray-400">Ask questions about your product</p>
            </div>
            {ingestedRepos.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-400">Repository:</label>
                <select
                  value={selectedRepoId || ''}
                  onChange={(e) => setSelectedRepoId(e.target.value || undefined)}
                  className="bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-[#6366f1]"
                >
                  <option value="">All Repositories</option>
                  {ingestedRepos.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.serviceName}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleGenerateReports}
                  disabled={isGeneratingReport || !selectedRepoId}
                  className="bg-[#6366f1] text-white rounded-lg px-3 py-1.5 text-sm hover:bg-[#5856eb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isGeneratingReport ? 'Generating...' : 'Generate Reports'}
                </button>
              </div>
            )}
          </div>
          {reportError && (
            <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {reportError}
            </div>
          )}
          {selectedRepoId && selectedReports && (
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {(Object.keys(selectedReports) as Array<keyof StakeholderReports>).map((key) => {
                const section = selectedReports[key]
                return (
                  <div key={key} className="rounded-lg border border-[#1f1f1f] bg-[#121212] p-4">
                    <h3 className="text-sm font-semibold text-white mb-2">{sectionTitle[key]}</h3>
                    <p className="text-xs text-gray-300 mb-3">{section.summary}</p>
                    <div className="space-y-1 mb-3">
                      {Object.entries(section.metrics).map(([metric, value]) => (
                        <div key={metric} className="flex items-center justify-between text-xs">
                          <span className="text-gray-400">{formatMetricLabel(metric)}</span>
                          <span className="text-white font-medium">{value}</span>
                        </div>
                      ))}
                    </div>
                    <div className="space-y-1">
                      {section.report.map((line, index) => (
                        <p key={`${key}_${index}`} className="text-xs text-gray-300">
                          {line}
                        </p>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          {selectedRepoId && !selectedReports && (
            <p className="mt-3 text-xs text-gray-500">
              Generate reports to view CTO, PM, and Operations summaries from ingested API flow data.
            </p>
          )}
        </div>
        <div className="flex-1">
          {ingestedRepos.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-gray-400 mb-2">No ingested repositories yet</p>
                <p className="text-sm text-gray-500">
                  Ingest a repository first to start asking questions
                </p>
              </div>
            </div>
          ) : (
            <ChatInterface repositoryId={selectedRepoId} />
          )}
        </div>
      </div>
    </div>
  )
}
