'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import ChatInterface from '@/components/ChatInterface'
import { getCurrentUser, getPostAuthRedirectTarget } from '@/lib/auth'
import { getRepositories } from '@/lib/repositories'
import { Repository, User } from '@/types'

export default function InsightsPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [selectedRepoId, setSelectedRepoId] = useState<string | undefined>()
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
        const repos = getRepositories(currentUser.currentOrganizationId)
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
              </div>
            )}
          </div>
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
