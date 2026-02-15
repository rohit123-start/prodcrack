'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { getCurrentUser, getPostAuthRedirectTarget } from '@/lib/auth'
import { getRepositories } from '@/lib/repositories'
import { Repository, User } from '@/types'
import { GitBranch, CheckCircle2, Clock } from 'lucide-react'

export default function DashboardPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
  const [repositories, setRepositories] = useState<Repository[]>([])
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

  const ingestedCount = repositories.filter(r => r.isIngested).length
  const totalCount = repositories.length
  const isOrgAdmin = user.currentOrganizationRole === 'admin'

  return (
    <div className="flex h-screen bg-[#0a0a0a]">
      <Sidebar />
      <div className="flex-1 overflow-y-auto">
        <div className="p-8">
          <div className="mb-8">
            <h1 className="text-2xl font-semibold text-white mb-2">
              Welcome back, {user.name}
            </h1>
            <p className="text-gray-400">
              {user.currentOrganizationId} • {user.currentOrganizationRole}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-400">Repositories</h3>
                <GitBranch className="w-5 h-5 text-gray-500" />
              </div>
              <p className="text-2xl font-semibold text-white">{totalCount}</p>
            </div>

            <div className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-400">Ingested</h3>
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              </div>
              <p className="text-2xl font-semibold text-white">{ingestedCount}</p>
            </div>

            <div className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-400">Pending</h3>
                <Clock className="w-5 h-5 text-yellow-500" />
              </div>
              <p className="text-2xl font-semibold text-white">
                {totalCount - ingestedCount}
              </p>
            </div>
          </div>

          <div className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Recent Repositories</h2>
            {repositories.length === 0 ? (
              <p className="text-gray-400">No repositories yet. Add one from the Repositories page.</p>
            ) : (
              <div className="space-y-3">
                {repositories.map((repo) => (
                  <div
                    key={repo.id}
                    className="flex items-center justify-between p-4 bg-[#1a1a1a] rounded-lg border border-[#1f1f1f]"
                  >
                    <div>
                      <h3 className="font-medium text-white">{repo.serviceName}</h3>
                      <p className="text-sm text-gray-400">{repo.repoUrl}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {repo.isIngested ? (
                        <span className="px-2 py-1 text-xs font-medium text-green-400 bg-green-400/10 rounded">
                          Ingested
                        </span>
                      ) : (
                        <span className="px-2 py-1 text-xs font-medium text-yellow-400 bg-yellow-400/10 rounded">
                          Pending
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {isOrgAdmin && (
            <div className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6 mt-6">
              <h2 className="text-lg font-semibold text-white mb-2">Admin Controls</h2>
              <p className="text-sm text-gray-400">
                You can manage organization settings, invite users, update member roles, and handle billing.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
