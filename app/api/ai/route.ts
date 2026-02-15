import { NextRequest, NextResponse } from 'next/server'
import { searchContextBlocks } from '@/lib/context-engine'
import { AIResponse } from '@/types'

// AI prompt template with guardrails
const AI_PROMPT_TEMPLATE = `You are a product-focused AI assistant. Your role is to explain product behavior, user flows, and business logic in non-technical terms.

IMPORTANT RULES:
1. NEVER expose raw code, implementation details, or technical specifics
2. Focus ONLY on product behavior, user-facing features, and business flows
3. Use ONLY the provided context blocks to answer questions
4. If context is insufficient or confidence is low, start your response with "Based on available context, this appears to..."
5. Do NOT make up information or hallucinate - only use what's in the context
6. Keep responses clear, concise, and product-focused

Context Blocks:
{CONTEXT_BLOCKS}

Question: {QUESTION}

Provide a product-focused explanation:`

function calculateConfidence(
  relevantBlocks: number,
  totalBlocks: number,
  queryMatchQuality: number
): number {
  // Confidence calculation based on:
  // - Number of relevant context blocks found
  // - Quality of matches
  // - Coverage of the question
  
  if (relevantBlocks === 0) return 0.3 // Low confidence if no blocks found
  
  const blockScore = Math.min(relevantBlocks / 3, 1.0) // More blocks = higher confidence (cap at 3)
  const qualityScore = queryMatchQuality
  const coverageScore = relevantBlocks > 0 ? 0.8 : 0.3
  
  // Weighted average
  const confidence = (blockScore * 0.4) + (qualityScore * 0.4) + (coverageScore * 0.2)
  
  return Math.min(Math.max(confidence, 0.3), 0.95) // Clamp between 0.3 and 0.95
}

function simulateAIResponse(
  question: string,
  contextBlocks: Array<{ title: string; description: string; content: string; type: string; keywords?: string[] }>
): { answer: string; confidence: number } {
  const lowerQuestion = question.toLowerCase()
  
  // Determine which context blocks are most relevant
  const relevantBlocks = contextBlocks.filter(block => {
    const searchText = `${block.title} ${block.description} ${block.content}`.toLowerCase()
    return (
      searchText.includes(lowerQuestion) ||
      block.keywords?.some((kw: string) => lowerQuestion.includes(kw.toLowerCase()))
    )
  })

  // Calculate confidence
  const matchQuality = relevantBlocks.length > 0 ? 0.8 : 0.4
  const confidence = calculateConfidence(
    relevantBlocks.length,
    contextBlocks.length,
    matchQuality
  )

  // Generate product-focused response based on context
  let answer = ''
  
  if (relevantBlocks.length === 0) {
    answer = `Based on available context, this appears to be outside the scope of the current product documentation. I don't have sufficient information to provide a detailed answer about "${question}". Please ensure the repository has been ingested and contains relevant product context.`
  } else {
    // Build answer from relevant context blocks
    const primaryBlock = relevantBlocks[0]
    
    if (confidence < 0.6) {
      answer = `Based on available context, this appears to relate to ${primaryBlock.title.toLowerCase()}. `
    }
    
    // Extract product-focused information (avoiding technical details)
    answer += primaryBlock.content
    
    // Add additional context if multiple blocks are relevant
    if (relevantBlocks.length > 1) {
      answer += ` Additionally, ${relevantBlocks[1].description.toLowerCase()}.`
    }
    
    // Ensure answer is product-focused
    answer = answer
      .replace(/code|implementation|technical|API|endpoint/gi, (match) => {
        // Replace technical terms with product terms
        const replacements: Record<string, string> = {
          'code': 'product feature',
          'implementation': 'product behavior',
          'technical': 'product',
          'API': 'system',
          'endpoint': 'feature'
        }
        return replacements[match.toLowerCase()] || match
      })
  }

  return { answer, confidence }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { question, repositoryId } = body

    if (!question || typeof question !== 'string') {
      return NextResponse.json(
        { error: 'Question is required' },
        { status: 400 }
      )
    }

    // Retrieve relevant context blocks
    const allBlocks = searchContextBlocks(question, repositoryId)
    
    // If no blocks found, search more broadly
    const contextBlocks = allBlocks.length > 0 
      ? allBlocks 
      : searchContextBlocks('', repositoryId).slice(0, 3) // Fallback to first 3 blocks

    // Simulate AI processing with guardrails
    const { answer, confidence } = simulateAIResponse(question, contextBlocks)

    const response: AIResponse = {
      answer,
      confidence,
      contextBlocksUsed: contextBlocks.map(b => b.id),
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error('AI API error:', error)
    return NextResponse.json(
      { error: 'Failed to process question' },
      { status: 500 }
    )
  }
}
