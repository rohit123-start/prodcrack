import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { runIngestionAgent } from '@/lib/agents/ingestion-agent'

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Use POST /api/ingest with repositoryId and organizationId to start ingestion.',
  })
}

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

    const supabase = getSupabaseAdmin()
    const authUser = await getUserFromBearerToken(accessToken)
    if (!authUser) {
      return NextResponse.json(
        { success: false, message: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { data: repository, error: repositoryError } = await supabase
      .from('repositories')
      .select('*')
      .eq('id', repositoryId)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (repositoryError || !repository) {
      return NextResponse.json(
        { success: false, message: 'Repository not found in organization' },
        { status: 404 }
      )
    }

    if (repository.is_ingested) {
      return NextResponse.json(
        { success: false, message: 'Repository already ingested' },
        { status: 409 }
      )
    }

    const { data: membership, error: membershipError } = await supabase
      .from('organization_members')
      .select('role')
      .eq('user_id', authUser.id)
      .eq('organization_id', organizationId)
      .maybeSingle()

    if (membershipError || !membership || membership.role !== 'admin') {
      return NextResponse.json(
        { success: false, message: 'Only organization admins can ingest repositories' },
        { status: 403 }
      )
    }

    // Mark processing to support future async workers.
    const { error: processingError } = await supabase
      .from('repositories')
      .update({ status: 'ingesting' })
      .eq('id', repositoryId)
      .eq('organization_id', organizationId)

    if (processingError) {
      return NextResponse.json(
        { success: false, message: 'Failed to start ingestion' },
        { status: 500 }
      )
    }

    // STEP A+B: provider fetch + agentic extraction into product intelligence blocks.
    const ingestion = await runIngestionAgent({
      provider: repository.provider,
      repoUrl: repository.repo_url,
      serviceName: repository.service_name,
    })

    const contextBlocks = ingestion.blocks.map((block) => ({
      repository_id: repositoryId,
      type: block.type,
      title: block.title,
      description: block.description,
      content: block.content,
      keywords: block.keywords,
    }))

    // STEP C: insert context blocks.
    const { error: blocksError } = await supabase
      .from('product_context_blocks')
      .insert(contextBlocks)

    if (blocksError) {
      await supabase
        .from('repositories')
        .update({ status: 'failed' })
        .eq('id', repositoryId)
        .eq('organization_id', organizationId)

      return NextResponse.json(
        { success: false, message: blocksError.message || 'Failed to persist context blocks' },
        { status: 500 }
      )
    }

    // STEP D: mark ingested.
    const { error: completeError } = await supabase
      .from('repositories')
      .update({
        status: 'ingested',
        is_ingested: true,
        ingested_at: new Date().toISOString(),
      })
      .eq('id', repositoryId)
      .eq('organization_id', organizationId)

    if (completeError) {
      await supabase
        .from('repositories')
        .update({ status: 'failed' })
        .eq('id', repositoryId)
        .eq('organization_id', organizationId)

      return NextResponse.json(
        { success: false, message: completeError.message || 'Failed to finalize ingestion' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      message: 'Repository ingested successfully',
      contextBlocksCreated: contextBlocks.length,
      sourceFilesProcessed: ingestion.sourceFileCount,
      moduleChunksProcessed: ingestion.chunkCount,
    })
  } catch (error) {
    console.error('Ingestion error:', error)
    return NextResponse.json(
      { success: false, message: 'Ingestion failed' },
      { status: 500 }
    )
  }
}
