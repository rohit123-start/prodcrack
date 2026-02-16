import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { answerWithContext, interpretQuestion } from '@/lib/agents/chat-interpreter-agent'
import { AIResponse } from '@/types'

const FALLBACK_ANSWER =
  'Based on available context, this appears to be temporarily unavailable. Please try again shortly.'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { question, repositoryId } = body

    if (!question || typeof question !== 'string') {
      return NextResponse.json(
        { answer: FALLBACK_ANSWER, confidence: 0.3, contextBlocksUsed: [], error: 'Question is required' },
        { status: 400 }
      )
    }

    const authHeader = request.headers.get('authorization')
    const accessToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null

    if (!accessToken) {
      return NextResponse.json(
        { answer: FALLBACK_ANSWER, confidence: 0.3, contextBlocksUsed: [], error: 'Missing access token' },
        { status: 401 }
      )
    }

    const authUser = await getUserFromBearerToken(accessToken)
    if (!authUser) {
      return NextResponse.json(
        { answer: FALLBACK_ANSWER, confidence: 0.3, contextBlocksUsed: [], error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const supabase = getSupabaseAdmin()

    const { data: memberships } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', authUser.id)

    const orgIds = (memberships || []).map((m) => m.organization_id)
    if (orgIds.length === 0) {
      return NextResponse.json(
        { answer: FALLBACK_ANSWER, confidence: 0.3, contextBlocksUsed: [], error: 'No organization access' },
        { status: 403 }
      )
    }

    const { data: repos } = await supabase
      .from('repositories')
      .select('id')
      .in('organization_id', orgIds)

    const repoIds = (repos || []).map((r) => r.id)
    if (repoIds.length === 0) {
      return NextResponse.json({
        answer: 'Based on available context, this appears to have no repositories ingested for your organization yet.',
        confidence: 0.35,
        contextBlocksUsed: [],
      })
    }

    const scopedRepoIds = repositoryId ? repoIds.filter((id) => id === repositoryId) : repoIds
    if (scopedRepoIds.length === 0) {
      return NextResponse.json(
        { answer: FALLBACK_ANSWER, confidence: 0.3, contextBlocksUsed: [], error: 'Repository not accessible' },
        { status: 403 }
      )
    }

    const interpreted = await interpretQuestion(question)

    let blocksQuery = supabase
      .from('product_context_blocks')
      .select('*')
      .in('repository_id', scopedRepoIds)
      .limit(30)

    if (interpreted.keywords.length > 0) {
      blocksQuery = blocksQuery.overlaps('keywords', interpreted.keywords.slice(0, 10))
    }

    const { data: keywordBlocks, error: blocksError } = await blocksQuery
    if (blocksError) {
      return NextResponse.json(
        { answer: FALLBACK_ANSWER, confidence: 0.3, contextBlocksUsed: [], error: 'Failed to load context' },
        { status: 500 }
      )
    }

    let contextBlocks = keywordBlocks || []
    if (contextBlocks.length === 0) {
      const { data: fallbackBlocks } = await supabase
        .from('product_context_blocks')
        .select('*')
        .in('repository_id', scopedRepoIds)
        .order('created_at', { ascending: false })
        .limit(12)
      contextBlocks = fallbackBlocks || []
    }

    const { answer, confidence, contextBlockIds } = await answerWithContext({
      question,
      contextBlocks,
    })

    const response: AIResponse = {
      answer,
      confidence,
      contextBlocksUsed: contextBlockIds,
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('AI API error:', error)
    return NextResponse.json(
      { answer: FALLBACK_ANSWER, confidence: 0.3, contextBlocksUsed: [], error: 'Failed to process question' },
      { status: 500 }
    )
  }
}
