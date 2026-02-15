import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { RepoProvider } from '@/types'

function isValidProvider(provider: string): provider is RepoProvider {
  return provider === 'github' || provider === 'gitlab' || provider === 'bitbucket'
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { provider, serviceName, repoUrl, productId, organizationId } = body

    if (!provider || !serviceName || !repoUrl || !productId || !organizationId) {
      return NextResponse.json(
        { success: false, message: 'Missing required fields' },
        { status: 400 }
      )
    }

    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { success: false, message: 'Invalid provider' },
        { status: 400 }
      )
    }

    const authHeader = request.headers.get('authorization')
    const accessToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null

    if (!accessToken) {
      return NextResponse.json(
        { success: false, message: 'Missing access token' },
        { status: 401 }
      )
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json(
        { success: false, message: 'Server configuration missing' },
        { status: 500 }
      )
    }

    const supabase = createClient(supabaseUrl, serviceKey)

    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken)
    if (authError || !authData.user) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Guardrail: organization ownership + role check from organization_members.
    const { data: membership, error: membershipError } = await supabase
      .from('organization_members')
      .select('role')
      .eq('user_id', authData.user.id)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (membershipError || !membership) {
      return NextResponse.json(
        { success: false, message: 'No organization access' },
        { status: 403 }
      )
    }

    if (membership.role === 'viewer') {
      return NextResponse.json(
        { success: false, message: 'Viewer role cannot add repositories' },
        { status: 403 }
      )
    }

    const { data: repository, error: insertError } = await supabase
      .from('repositories')
      .insert({
        provider,
        service_name: serviceName,
        repo_url: repoUrl,
        product_id: productId,
        organization_id: organizationId,
        status: 'not_ingested',
        is_ingested: false,
      })
      .select('*')
      .single()

    if (insertError || !repository) {
      return NextResponse.json(
        { success: false, message: insertError?.message || 'Failed to add repository' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, repository })
  } catch (error) {
    console.error('Add repository error:', error)
    return NextResponse.json(
      { success: false, message: 'Failed to add repository' },
      { status: 500 }
    )
  }
}
