import { RepoProvider } from '@/types'
import { LLMRequestError, runOpenAIJsonOrThrow } from '@/lib/llm/openai'
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
  usedFallback: boolean
}

type ExtractedConfidence = 'high' | 'medium' | 'low'

type EvidenceItem = {
  name: string
  description: string
  confidence?: ExtractedConfidence
  evidence: string[]
}

type ExtractionOutput = {
  product_purpose: string
  core_user_flows: Array<{
    flow_name: string
    description: string
    confidence?: ExtractedConfidence
    evidence: string[]
  }>
  product_modules: Array<{
    name: string
    description: string
    confidence?: ExtractedConfidence
    evidence: string[]
  }>
  features: Array<{
    name: string
    description: string
    evidence: string[]
  }>
  unknown_or_uncertain: string[]
}

function toCleanString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeEvidence(input: unknown) {
  if (!Array.isArray(input)) return []
  return input
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.toLowerCase() !== 'unknown')
    .slice(0, 6)
}

function hasValidEvidence(item: EvidenceItem) {
  return item.evidence.length > 0 && item.name.toLowerCase() !== 'unknown'
}

function inferConfidence(confidence?: ExtractedConfidence) {
  const normalized = toCleanString(confidence)
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized
  }
  return 'low'
}

function buildItemContent(item: EvidenceItem) {
  const confidence = inferConfidence(item.confidence)
  const evidenceText = item.evidence.map((entry) => `- ${entry}`).join('\n')
  return `${item.description}\n\nConfidence: ${confidence}\nEvidence:\n${evidenceText}`
}

function toKeywords(item: EvidenceItem) {
  const tokens = new Set<string>()
  for (const token of item.name.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (token.length > 2) tokens.add(token)
  }
  for (const e of item.evidence) {
    const match = e.match(/\[(.*?)\]/)
    if (match?.[1]) {
      for (const token of match[1].toLowerCase().split(/[^a-z0-9_]+/)) {
        if (token.length > 2) tokens.add(token)
      }
    }
  }
  return Array.from(tokens).slice(0, 12)
}

function unknownBlock(serviceName: string): ExtractedBlock {
  return {
    type: 'business_logic',
    title: `${serviceName} context unknown`,
    description: 'Repository evidence is insufficient to infer reliable product context.',
    content:
      'unknown\n\nEvidence:\n- insufficient explicit product evidence in README/docs/endpoints/comments naming patterns.',
    keywords: ['unknown', 'insufficient_evidence', 'product_context'],
  }
}

const EXTRACTION_SYSTEM_PROMPT = `
You are a PRODUCT CONTEXT INGESTION AGENT.

Your task is to extract PRODUCT understanding from a repository.

You are NOT performing technical indexing.
You are NOT listing files.
You are NOT generating generic summaries.

Your job is to identify REAL product flows and concepts supported by evidence inside the repository.

PRIMARY OBJECTIVE
Extract:
1. Product purpose
2. Core user flows
3. Product modules/domains
4. Key user-facing features
ONLY if supported by explicit repository evidence.

ALLOWED EVIDENCE SOURCES
Use ONLY:
* README.md
* documentation files
* clear naming patterns repeated across the repo
* explicit comments describing behavior
* clearly defined API endpoints
* domain-specific terminology appearing multiple times

If evidence is weak or unclear: return "unknown".

STRICT GUARDRAILS (ANTI-HALLUCINATION)
1. NEVER assume business domain.
2. DO NOT extrapolate from generic backend patterns.
3. NEVER fill missing context with common software archetypes.
4. If unsure: return "unknown" instead of guessing.
5. Every flow or module MUST include supporting evidence.

CONFIDENCE VALIDATION (MANDATORY)
For EACH item:
* Is this explicitly supported by repository text?
* Does evidence exist in more than one place OR clearly in README?
If NO, remove it.

OUTPUT FORMAT (JSON ONLY):
{
  "product_purpose": "",
  "core_user_flows": [
    { "flow_name": "", "description": "", "confidence": "high | medium | low", "evidence": [] }
  ],
  "product_modules": [
    { "name": "", "description": "", "confidence": "high | medium | low", "evidence": [] }
  ],
  "features": [
    { "name": "", "description": "", "evidence": [] }
  ],
  "unknown_or_uncertain": []
}
`.trim()

function extractionToBlocks(extraction: ExtractionOutput): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []

  const productPurpose = toCleanString(extraction.product_purpose) || 'unknown'
  if (productPurpose.toLowerCase() !== 'unknown') {
    blocks.push({
      type: 'architecture',
      title: 'Product purpose',
      description: productPurpose,
      content: productPurpose,
      keywords: ['product', 'purpose'],
    })
  }

  for (const flow of Array.isArray(extraction.core_user_flows) ? extraction.core_user_flows : []) {
    const item: EvidenceItem = {
      name: toCleanString(flow.flow_name),
      description: toCleanString(flow.description),
      confidence: flow.confidence,
      evidence: sanitizeEvidence(flow.evidence),
    }
    if (!item.name || !item.description || !hasValidEvidence(item)) continue
    blocks.push({
      type: 'user_flow',
      title: item.name,
      description: item.description,
      content: buildItemContent(item),
      keywords: toKeywords(item),
    })
  }

  for (const moduleItem of Array.isArray(extraction.product_modules) ? extraction.product_modules : []) {
    const item: EvidenceItem = {
      name: toCleanString(moduleItem.name),
      description: toCleanString(moduleItem.description),
      confidence: moduleItem.confidence,
      evidence: sanitizeEvidence(moduleItem.evidence),
    }
    if (!item.name || !item.description || !hasValidEvidence(item)) continue
    blocks.push({
      type: 'architecture',
      title: item.name,
      description: item.description,
      content: buildItemContent(item),
      keywords: toKeywords(item),
    })
  }

  for (const feature of Array.isArray(extraction.features) ? extraction.features : []) {
    const item: EvidenceItem = {
      name: toCleanString(feature.name),
      description: toCleanString(feature.description),
      evidence: sanitizeEvidence(feature.evidence),
    }
    if (!item.name || !item.description || !hasValidEvidence(item)) continue
    blocks.push({
      type: 'feature',
      title: item.name,
      description: item.description,
      content: buildItemContent(item),
      keywords: toKeywords(item),
    })
  }

  const uncertain = Array.isArray(extraction.unknown_or_uncertain)
    ? extraction.unknown_or_uncertain
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : []

  if (uncertain.length > 0) {
    blocks.push({
      type: 'business_logic',
      title: 'Unknown or uncertain areas',
      description: 'Areas where evidence is insufficient for reliable extraction.',
      content: uncertain.map((entry) => `- ${entry}`).join('\n'),
      keywords: ['unknown', 'uncertain', 'evidence'],
    })
  }

  return blocks
}

function buildEvidenceCorpus(
  files: Array<{ path: string; content: string }>,
  serviceName: string
): string {
  const prioritized = files
    .slice()
    .sort((a, b) => {
      const score = (path: string) => {
        const p = path.toLowerCase()
        if (p.endsWith('readme.md')) return 0
        if (p.includes('/docs/') || p.startsWith('docs/')) return 1
        if (p.includes('/api/') || p.includes('route.ts')) return 2
        return 3
      }
      return score(a.path) - score(b.path)
    })
    .slice(0, 40)

  const snippets = prioritized
    .map((file) => {
      const cleanContent = file.content.slice(0, 1800)
      return `[${file.path}]\n${cleanContent}`
    })
    .join('\n\n')

  return `Repository service: ${serviceName}\n\nEvidence corpus:\n${snippets}`
}

export async function runIngestionAgent(input: {
  provider: RepoProvider
  repoUrl: string
  serviceName: string
}): Promise<IngestionResult> {
  const snapshot = await fetchRepositorySnapshot(input.provider, input.repoUrl)
  const filtered = filterRepositoryFiles(snapshot)
  const chunks = chunkFilesByModule(filtered).slice(0, 12)

  const allBlocks: ExtractedBlock[] = []
  let usedFallback = false

  const prompt = `
Return ONLY valid JSON.
No markdown. No prose outside JSON.

Every evidence item must cite source snippets with file tags like [README.md] or [path/to/file].
If evidence is weak, set fields to "unknown" and list gaps in unknown_or_uncertain.

${buildEvidenceCorpus(filtered, input.serviceName)}
`.trim()

  let parsed: ExtractionOutput | null = null
  try {
    parsed = await runOpenAIJsonOrThrow<ExtractionOutput>(
      EXTRACTION_SYSTEM_PROMPT,
      prompt
    )
  } catch (error) {
    if (error instanceof LLMRequestError && error.kind === 'authorization_fail') {
      throw error
    }
    console.warn('[LLM FAILED] strict ingestion extraction failed', error)
    usedFallback = true
  }

  if (parsed) {
    allBlocks.push(...extractionToBlocks(parsed))
  }

  if (allBlocks.length === 0) {
    usedFallback = true
    allBlocks.push(unknownBlock(input.serviceName))
  }

  // dedupe
  const deduped = new Map<string, ExtractedBlock>()
  for (const block of allBlocks) {
    const key = `${block.type}:${block.title}`.toLowerCase()
    if (!deduped.has(key)) deduped.set(key, block)
  }

  const finalBlocks = Array.from(deduped.values()).slice(0, 40)

  if (finalBlocks.length === 0) {
    throw new Error('data not ingested')
  }

  return {
    blocks: finalBlocks,
    sourceFileCount: filtered.length,
    chunkCount: chunks.length,
    usedFallback,
  }
}

