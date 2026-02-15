import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { generateMockContextBlocks } from '@/lib/context-engine'
import { getRepositoryById, markRepositoryAsIngested } from '@/lib/repositories'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { repositoryId, organizationId } = body

    if (!repositoryId || !organizationId) {
      return NextResponse.json(
        { success: false, message: 'Repository ID and organization ID are required' },
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
        { success: false, message: 'Server auth configuration missing' },
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

    const repository = getRepositoryById(repositoryId)
    if (!repository || repository.organizationId !== organizationId) {
      return NextResponse.json(
        { success: false, message: 'Repository not found in organization' },
        { status: 404 }
      )
    }

    const { data: membership, error: membershipError } = await supabase
      .from('organization_members')
      .select('role')
      .eq('user_id', authData.user.id)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (membershipError || !membership || membership.role !== 'admin') {
      return NextResponse.json(
        { success: false, message: 'Only organization admins can ingest repositories' },
        { status: 403 }
      )
    }

    // Simulate ingestion delay
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Generate mock context blocks
    const contextBlocks = generateMockContextBlocks(repositoryId)
    
    // Mark repository as ingested
    markRepositoryAsIngested(repositoryId)

    return NextResponse.json({
      success: true,
      message: 'Repository ingested successfully',
      contextBlocksCreated: contextBlocks.length,
    })
  } catch (error) {
    console.error('Ingestion error:', error)
    return NextResponse.json(
      { success: false, message: 'Ingestion failed' },
      { status: 500 }
    )
  }
}
