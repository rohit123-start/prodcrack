'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { getCurrentUser, getPostAuthRedirectTarget, signOut } from '@/lib/auth'
import { LogOut, User as UserIcon } from 'lucide-react'
import { User } from '@/types'

export default function SettingsPage() {
  const router = useRouter()
  const [user, setUser] = useState<User | null>(null)
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

        setUser(currentUser)
      } catch (error) {
        console.error('Error loading user:', error)
        router.replace('/login')
      } finally {
        setIsLoading(false)
      }
    }
    loadUser()
  }, [router])

  const handleLogout = async () => {
    await signOut()
    router.push('/login')
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

  return (
    <div className="flex h-screen bg-[#0a0a0a]">
      <Sidebar />
      <div className="flex-1 overflow-y-auto">
        <div className="p-8">
          <h1 className="text-2xl font-semibold text-white mb-8">Settings</h1>

          <div className="space-y-6">
            <div className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6">
              <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <UserIcon className="w-5 h-5" />
                Account Information
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Name
                  </label>
                  <p className="text-white">{user.name}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Email
                  </label>
                  <p className="text-white">{user.email}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Role
                  </label>
                  <p className="text-white capitalize">{(user.currentOrganizationRole || 'viewer').replace('_', ' ')}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">
                    Organization ID
                  </label>
                  <p className="text-white font-mono text-sm">{user.currentOrganizationId || '-'}</p>
                </div>
              </div>
            </div>

            <div className="bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg p-6">
              <h2 className="text-lg font-semibold text-white mb-4">Actions</h2>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-lg px-4 py-2 hover:bg-red-500/20 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign Out
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
