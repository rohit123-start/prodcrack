import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { runIngestionAgent } from '@/lib/agents/ingestion-agent'
import { LLMRequestError } from '@/lib/llm/openai'

function isRepoStatusEnumError(message?: string) {
  return Boolean(message && message.includes('enum repo_status'))
}

function isContextTypeEnumError(message?: string) {
  return Boolean(message && message.includes('enum context_type'))
}

async function updateRepositoryStatusWithFallback(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  repositoryId: string,
  organizationId: string,
  candidates: string[],
  extraFields: Record<string, unknown> = {}
) {
  let lastError: any = null
  for (const status of candidates) {
    const { error } = await supabase
      .from('repositories')
      .update({ status, ...extraFields })
      .eq('id', repositoryId)
      .eq('organization_id', organizationId)

    if (!error) return null
    lastError = error
    if (!isRepoStatusEnumError(error.message)) {
      return error
    }
  }
  return lastError
}

function mapBlocksToLegacyTypes(
  blocks: Array<{
    repository_id: string
    type: string
    title: string
    description: string
    content: string
    keywords: string[]
  }>
) {
  const typeMap: Record<string, string> = {
    architecture: 'feature',
    user_flow: 'flow',
    integration: 'feature',
    business_logic: 'feature',
  }
  return blocks.map((block) => ({
    ...block,
    type: typeMap[block.type] || block.type,
  }))
}

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
    const processingError = await updateRepositoryStatusWithFallback(
      supabase,
      repositoryId,
      organizationId,
      ['ingesting', 'processing']
    )

    if (processingError) {
      console.error('Failed to set processing status:', processingError)
      return NextResponse.json(
        { success: false, message: processingError.message || 'Failed to start ingestion' },
        { status: 500 }
      )
    }

    let ingestion
    try {
      // STEP A+B: provider fetch + agentic extraction into product intelligence blocks.
      ingestion = await runIngestionAgent({
        provider: repository.provider,
        repoUrl: repository.repo_url,
        serviceName: repository.service_name,
      })
    } catch (error) {
      await supabase
        .from('repositories')
        .update({ status: 'failed' })
        .eq('id', repositoryId)
        .eq('organization_id', organizationId)

      if (error instanceof LLMRequestError && error.kind === 'authorization_fail') {
        return NextResponse.json(
          { success: false, message: 'authorization fail' },
          { status: 500 }
        )
      }

      return NextResponse.json(
        { success: false, message: 'data not ingested' },
        { status: 500 }
      )
    }

    const contextBlocks = ingestion.blocks
      .map((block) => ({
        repository_id: repositoryId,
        type: block.type,
        title: block.title,
        description: block.description,
        content: block.content,
        keywords: block.keywords,
      }))
      .filter(
        (block) =>
          block.repository_id &&
          block.type &&
          block.title &&
          block.description &&
          block.content &&
          Array.isArray(block.keywords) &&
          block.keywords.length > 0
      )

    if (contextBlocks.length === 0) {
      await supabase
        .from('repositories')
        .update({ status: 'failed' })
        .eq('id', repositoryId)
        .eq('organization_id', organizationId)

      return NextResponse.json(
        { success: false, message: 'data not ingested' },
        { status: 500 }
      )
    }

    // STEP C: insert context blocks.
    let { error: blocksError } = await supabase
      .from('product_context_blocks')
      .insert(contextBlocks)

    // Compatibility fallback for environments with legacy context_type enums.
    if (blocksError && isContextTypeEnumError(blocksError.message)) {
      const legacyBlocks = mapBlocksToLegacyTypes(contextBlocks)
      const retry = await supabase.from('product_context_blocks').insert(legacyBlocks)
      blocksError = retry.error
    }

    if (blocksError) {
      console.error('Context block insert failed:', blocksError)
      await supabase
        .from('repositories')
        .update({ status: 'failed' })
        .eq('id', repositoryId)
        .eq('organization_id', organizationId)

      return NextResponse.json(
        { success: false, message: 'data not ingested' },
        { status: 500 }
      )
    }

    // STEP D: mark ingested.
    const completeError = await updateRepositoryStatusWithFallback(
      supabase,
      repositoryId,
      organizationId,
      ['ingested', 'ready'],
      {
        is_ingested: true,
        ingested_at: new Date().toISOString(),
      }
    )

    if (completeError) {
      console.error('Finalization status update failed:', completeError)
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
      usedFallbackExtraction: ingestion.usedFallback,
    })
  } catch (error) {
    console.error('Ingestion error:', error)
    return NextResponse.json(
      { success: false, message: 'Ingestion failed' },
      { status: 500 }
    )
  }
}
