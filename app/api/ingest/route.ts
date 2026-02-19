import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { runGenosIngestion } from '../../../lib/agents/genos-ingestion'

function isRepoStatusEnumError(message?: string) {
  return Boolean(message && message.includes('enum repo_status'))
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

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: 'Use POST /api/ingest with organizationId and repositoryId or repository_url to start ingestion.',
  })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const {
      repositoryId: repositoryIdInput,
      repository_url: repositoryUrlInput,
      organizationId,
      forceReingest,
    } = body

    if ((!repositoryIdInput && !repositoryUrlInput) || !organizationId) {
      return NextResponse.json(
        { success: false, message: 'organizationId and repositoryId or repository_url are required' },
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

    let repositoryQuery = supabase
      .from('repositories')
      .select('*')
      .eq('organization_id', organizationId)

    if (repositoryIdInput) {
      repositoryQuery = repositoryQuery.eq('id', repositoryIdInput)
    } else {
      repositoryQuery = repositoryQuery.eq('repo_url', repositoryUrlInput)
    }

    const { data: repository, error: repositoryError } = await repositoryQuery.maybeSingle()

    if (repositoryError || !repository) {
      return NextResponse.json(
        { success: false, message: 'Repository not found in organization' },
        { status: 404 }
      )
    }

    const repositoryId = repository.id

    const isForceReingest = Boolean(forceReingest)

    if (repository.is_ingested && !isForceReingest) {
      return NextResponse.json(
        { success: false, message: 'Repository already ingested. Use re-run ingestion to refresh.' },
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

    async function safeDeleteByRepositoryId(table: string) {
      const { error } = await supabase
        .from(table as any)
        .delete()
        .eq('repository_id', repositoryId)
      if (!error) return
      const message = error.message?.toLowerCase?.() || ''
      if (message.includes('does not exist') || message.includes('relation')) {
        return
      }
      throw new Error(`${table} cleanup failed: ${error.message}`)
    }

    // Re-run ingestion should refresh structure index for updated repository snapshots.
    if (isForceReingest) {
      try {
        await safeDeleteByRepositoryId('repository_entities')
        await safeDeleteByRepositoryId('code_graph')
        await safeDeleteByRepositoryId('chat_session_memory')
        await safeDeleteByRepositoryId('embeddings')
        await safeDeleteByRepositoryId('embeddings')
      } catch (cleanupError) {
        console.error('Failed to cleanup repository artifacts for re-ingestion:', cleanupError)
        return NextResponse.json(
          { success: false, message: 'Failed to prepare repository for re-ingestion' },
          { status: 500 }
        )
      }
    }

    // Mark processing to support future async workers.
    const processingError = await updateRepositoryStatusWithFallback(
      supabase,
      repositoryId,
      organizationId,
      ['ingesting', 'processing'],
      { is_ingested: false, ingested_at: null }
    )

    if (processingError) {
      console.error('Failed to set processing status:', processingError)
      return NextResponse.json(
        { success: false, message: processingError.message || 'Failed to start ingestion' },
        { status: 500 }
      )
    }

    let ingestionResult
    try {
      ingestionResult = await runGenosIngestion({
        repositoryId,
        repositoryUrl: repository.repo_url,
      })
    } catch (error) {
      await supabase
        .from('repositories')
        .update({ status: 'failed' })
        .eq('id', repositoryId)
        .eq('organization_id', organizationId)

      return NextResponse.json(
        { success: false, message: 'Ingestion pipeline failed' },
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
      message: isForceReingest
        ? 'Repository re-ingested successfully'
        : 'Repository ingested successfully',
      reingested: isForceReingest,
      ...ingestionResult,
    })
  } catch (error) {
    console.error('Ingestion error:', error)
    return NextResponse.json(
      { success: false, message: 'Ingestion failed' },
      { status: 500 }
    )
  }
}
