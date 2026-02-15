'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { getCurrentUser, canIngestRepos, getPostAuthRedirectTarget } from '@/lib/auth'
import { getRepositories, addRepository, markRepositoryAsIngested } from '@/lib/repositories'
import { supabase } from '@/lib/supabase'
import { Repository, User } from '@/types'
import { Plus, GitBranch, CheckCircle2, Clock, Loader2 } from 'lucide-react'

export default function RepositoriesPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
  const [isIngesting, setIsIngesting] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newRepoName, setNewRepoName] = useState('')
  const [newRepoUrl, setNewRepoUrl] = useState('')
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
        setRepositories(getRepositories(currentUser.currentOrganizationId))
      } catch (error) {
        console.error('Error loading user:', error)
        router.replace('/login')
      } finally {
        setIsLoading(false)
      }
    }
    loadUser()
  }, [router])

  const handleIngest = async (repoId: string) => {
    setIsIngesting(repoId)
    try {
      const { data: authData } = await supabase.auth.getSession()
      const accessToken = authData.session?.access_token

      const response = await fetch('/api/ingest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          repositoryId: repoId,
          organizationId: user?.currentOrganizationId,
        }),
      })
      const data = await response.json()
      
      if (data.success) {
        markRepositoryAsIngested(repoId)
        setRepositories(getRepositories(user!.currentOrganizationId!))
      }
    } catch (error) {
      console.error('Ingestion failed:', error)
    } finally {
      setIsIngesting(null)
    }
  }

  const handleAddRepository = () => {
    if (!newRepoName.trim() || !newRepoUrl.trim() || !user) return
    
    addRepository(newRepoName, newRepoUrl, user.currentOrganizationId!)
    setRepositories(getRepositories(user.currentOrganizationId!))
    setNewRepoName('')
    setNewRepoUrl('')
    setShowAddForm(false)
  }

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

  const canIngest = canIngestRepos(user)

  return (
    <div className="flex h-screen bg-[#0a0a0a]">
      <Sidebar />
      <div className="flex-1 overflow-y-auto">
        <div className="p-8">
          <div className="flex items-center justify-between mb-8">
            <div>
              <h1 className="text-2xl font-semibold text-white mb-2">Repositories</h1>
              <p className="text-gray-400">Manage your connected repositories</p>
            </div>
            <button
              onClick={() => setShowAddForm(!showAddForm)}
              className="flex items-center gap-2 bg-[#6366f1] text-white rounded-lg px-4 py-2 hover:bg-[#5856eb] transition-colors"
            >
              <Plus className="w-5 h-5" />
              Add Repository
            </button>
          </div>

          {showAddForm && (
            <div className="mb-6 p-4 bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg">
              <h3 className="text-sm font-medium text-white mb-4">Add New Repository</h3>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Service Name"
                  value={newRepoName}
                  onChange={(e) => setNewRepoName(e.target.value)}
                  className="w-full bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#6366f1]"
                />
                <input
                  type="text"
                  placeholder="Repository URL"
                  value={newRepoUrl}
                  onChange={(e) => setNewRepoUrl(e.target.value)}
                  className="w-full bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#6366f1]"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleAddRepository}
                    className="flex-1 bg-[#6366f1] text-white rounded-lg px-4 py-2 hover:bg-[#5856eb] transition-colors"
                  >
                    Add
                  </button>
                  <button
                    onClick={() => {
                      setShowAddForm(false)
                      setNewRepoName('')
                      setNewRepoUrl('')
                    }}
                    className="flex-1 bg-[#1a1a1a] border border-[#1f1f1f] text-white rounded-lg px-4 py-2 hover:bg-[#1f1f1f] transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}

          {repositories.length === 0 ? (
            <div className="text-center py-12">
              <GitBranch className="w-12 h-12 text-gray-500 mx-auto mb-4" />
              <p className="text-gray-400 mb-4">No repositories connected yet</p>
              <button
                onClick={() => setShowAddForm(true)}
                className="bg-[#6366f1] text-white rounded-lg px-4 py-2 hover:bg-[#5856eb] transition-colors"
              >
                Add Your First Repository
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {repositories.map((repo) => (
                <div
                  key={repo.id}
                  className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <GitBranch className="w-5 h-5 text-gray-400" />
                        <h3 className="text-lg font-semibold text-white">
                          {repo.serviceName}
                        </h3>
                        {repo.isIngested ? (
                          <span className="px-2 py-1 text-xs font-medium text-green-400 bg-green-400/10 rounded flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            Ingested
                          </span>
                        ) : (
                          <span className="px-2 py-1 text-xs font-medium text-yellow-400 bg-yellow-400/10 rounded flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            Pending
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-400 mb-2">{repo.repoUrl}</p>
                      {repo.ingestedAt && (
                        <p className="text-xs text-gray-500">
                          Ingested: {new Date(repo.ingestedAt).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    <div className="ml-4">
                      {!repo.isIngested && canIngest && (
                        <button
                          onClick={() => handleIngest(repo.id)}
                          disabled={isIngesting === repo.id}
                          className="bg-[#6366f1] text-white rounded-lg px-4 py-2 hover:bg-[#5856eb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                        >
                          {isIngesting === repo.id ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              Ingesting...
                            </>
                          ) : (
                            'Ingest Repo'
                          )}
                        </button>
                      )}
                      {!canIngest && !repo.isIngested && (
                        <p className="text-xs text-gray-500 text-right">
                          Admin/PM required
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
