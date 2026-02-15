'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getPostAuthRedirectTarget } from '@/lib/auth'

export default function AuthCallbackPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string>('Completing sign in...')

  useEffect(() => {
    const processCallback = async () => {
      const errorParam = searchParams.get('error')
      if (errorParam) {
        setError('Authentication failed. Please try again.')
        router.replace('/login')
        return
      }

      setStatus('Checking your workspace...')
      const target = await getPostAuthRedirectTarget()
      router.replace(target)
    }

    processCallback().catch((err) => {
      console.error('Callback error:', err)
      setError('Could not complete sign in.')
      setTimeout(() => router.replace('/login'), 1200)
    })
  }, [router, searchParams])


  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
        <div className="text-center">
          <div className="mb-4 text-red-400">{error}</div>
          <p className="text-sm text-gray-400">Redirecting to login...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-[#6366f1] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="text-gray-400">{status}</p>
      </div>
    </div>
  )
}
