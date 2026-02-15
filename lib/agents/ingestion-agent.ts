import { RepoProvider } from '@/types'
import { runOpenAIJson } from '@/lib/llm/openai'
import {
  chunkFilesByModule,
  fetchRepositorySnapshot,
  filterRepositoryFiles,
} from '@/lib/ingest'

type ExtractedBlock = {
  type: 'feature' | 'architecture' | 'user_flow' | 'integration' | 'business_logic'
  title: string
  description: string
  content: string
  keywords: string[]
}

type IngestionResult = {
  blocks: ExtractedBlock[]
  sourceFileCount: number
  chunkCount: number
}

const EXTRACTION_SYSTEM_PROMPT = `
You are an Ingestion Agent that converts codebase chunks into PRODUCT INTELLIGENCE.

Rules:
- Never return raw code snippets.
- Extract only product-level understanding.
- Focus on features, user flows, architecture decisions, integrations, permissions, business logic, and operational workflows.
- Keep output concise and structured.
- Return JSON object: { "blocks": ExtractedBlock[] }.
`.trim()

function fallbackBlocksFromChunk(moduleName: string, content: string): ExtractedBlock[] {
  const lowered = content.toLowerCase()
  return [
    {
      type: 'feature',
      title: `${moduleName} feature summary`,
      description: `Feature behavior inferred from ${moduleName}`,
      content: 'This module appears to deliver user-facing capabilities and operational workflows for the product.',
      keywords: ['feature', moduleName],
    },
    {
      type: 'integration',
      title: `${moduleName} integrations`,
      description: 'External integrations and service dependencies',
      content: lowered.includes('auth')
        ? 'This module integrates with authentication and access workflows.'
        : 'This module integrates with internal and external services.',
      keywords: ['integration', moduleName, 'workflow'],
    },
  ]
}

export async function runIngestionAgent(input: {
  provider: RepoProvider
  repoUrl: string
  serviceName: string
}): Promise<IngestionResult> {
  const snapshot = await fetchRepositorySnapshot(input.provider, input.repoUrl)
  const filtered = filterRepositoryFiles(snapshot)
  const chunks = chunkFilesByModule(filtered).slice(0, 12) // token control

  const allBlocks: ExtractedBlock[] = []

  for (const chunk of chunks) {
    const prompt = `
Repository service: ${input.serviceName}
Module: ${chunk.module}
Files: ${chunk.files.join(', ')}

Chunk content:
${chunk.content}

Extract product intelligence blocks using types:
feature | architecture | user_flow | integration | business_logic
`.trim()

    const fallback = { blocks: fallbackBlocksFromChunk(chunk.module, chunk.content) }
    const parsed = await runOpenAIJson<{ blocks?: ExtractedBlock[] }>(
      EXTRACTION_SYSTEM_PROMPT,
      prompt,
      fallback
    )

    const extracted = Array.isArray(parsed.blocks) ? parsed.blocks : fallback.blocks
    allBlocks.push(...extracted)
  }

  // Deduplicate by title/type.
  const deduped = new Map<string, ExtractedBlock>()
  for (const block of allBlocks) {
    const key = `${block.type}:${block.title}`.toLowerCase()
    if (!deduped.has(key)) deduped.set(key, block)
  }

  return {
    blocks: Array.from(deduped.values()).slice(0, 40),
    sourceFileCount: filtered.length,
    chunkCount: chunks.length,
  }
}
