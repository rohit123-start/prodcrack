'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { completeOnboarding, getAuthUserBasic, getPostAuthRedirectTarget } from '@/lib/auth'
import { OrgMemberRole } from '@/types'
import { Loader2 } from 'lucide-react'

export default function OnboardingPage() {
  const router = useRouter()
  const [authEmail, setAuthEmail] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [step, setStep] = useState<1 | 2>(1)
  const [name, setName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [role, setRole] = useState<OrgMemberRole>('admin')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const bootstrap = async () => {
      try {
        const target = await getPostAuthRedirectTarget()
        if (target === '/login') {
          router.replace('/login')
          return
        }
        if (target === '/dashboard') {
          router.replace('/dashboard')
          return
        }

        const authUser = await getAuthUserBasic()
        if (authUser) {
          setAuthEmail(authUser.email || '')
          const inferredName =
            authUser.user_metadata?.full_name ||
            authUser.user_metadata?.name ||
            (authUser.email ? authUser.email.split('@')[0] : '')
          setName(inferredName)
        }
      } catch (error) {
        console.error('Error bootstrapping onboarding:', error)
        setError('Could not load onboarding state.')
      } finally {
        setIsLoading(false)
      }
    }

    bootstrap()
  }, [router])

  const goNext = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    setError(null)
    setStep(2)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!organizationName.trim()) {
      setError('Organization name is required')
      return
    }
    if (!role) {
      setError('Role is required')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const { error: onboardingError } = await completeOnboarding({
        name,
        organizationName,
        role,
      })
      if (onboardingError) {
        throw new Error('Failed to complete onboarding')
      }
      router.replace('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setIsSubmitting(false)
    }
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

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
      <div className="w-full max-w-md p-8 bg-[#0f0f0f] border border-[#1f1f1f] rounded-lg">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-white mb-2">Welcome to ProductGPT</h1>
          <p className="text-gray-400">Step {step} of 2</p>
          {authEmail && <p className="text-xs text-gray-500 mt-2">{authEmail}</p>}
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {step === 1 ? (
          <form onSubmit={goNext} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Enter your name"
                className="w-full bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#6366f1]"
                required
              />
            </div>
            <button
              type="submit"
              className="w-full bg-[#6366f1] text-white rounded-lg px-4 py-2 hover:bg-[#5856eb] transition-colors"
            >
              Continue
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Organization</label>
              <input
                type="text"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                placeholder="Enter your organization name"
                className="w-full bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#6366f1]"
                disabled={isSubmitting}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as OrgMemberRole)}
                className="w-full bg-[#1a1a1a] border border-[#1f1f1f] rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-[#6366f1]"
                disabled={isSubmitting}
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
              <p className="mt-2 text-xs text-gray-500">
                You will be assigned as <span className="font-medium">admin</span> for the organization you create.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="w-1/2 bg-[#1a1a1a] border border-[#1f1f1f] text-white rounded-lg px-4 py-2 hover:bg-[#232323] transition-colors"
                disabled={isSubmitting}
              >
                Back
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !organizationName.trim()}
                className="w-1/2 bg-[#6366f1] text-white rounded-lg px-4 py-2 hover:bg-[#5856eb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Complete Setup'
                )}
              </button>
            </div>
          </form>
        )}

        <div className="mt-6 pt-6 border-t border-[#1f1f1f]">
          <p className="text-xs text-gray-500 text-center">
            You&apos;ll be able to connect repositories and start asking questions after setup
          </p>
        </div>
      </div>
    </div>
  )
}
