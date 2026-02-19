import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { runOpenAIJson, runOpenAIText } from '@/lib/llm/openai'
import { IngestionLogger } from '@/lib/agents/ingestion-logger'

type GojoOutput = {
  intent_type: 'greeting' | 'smalltalk' | 'repo_question' | 'unclear'
  intent: string
  objective: string
  keywords: string[]
  answer_style: string
}

type SukunaOutput = {
  findings: string[]
  unknowns: string[]
  constraints: string[]
}

type FrontdeskOutput = {
  mode: 'reply' | 'route'
  human_message: string
  refined_question: string
}

type EntityRow = {
  id: string
  entity_name: string
  entity_type: string
  file_path: string
  metadata: Record<string, unknown> | null
}

type GraphRow = {
  source_entity_id: string
  target_entity_id: string
  relationship_type: string
}

type ChatHistoryItem = {
  role: 'user' | 'assistant'
  content: string
}

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
const EMBEDDING_BATCH_SIZE = 20
const RESPONSE_BUDGET_MS = 1900

const AGENT_PROMPTS = {
  IRUKA: `
You are IRUKA (Human Frontdesk Agent).
You always receive the user's message first.

Your job:
- Act like a natural, friendly human assistant.
- Decide whether to reply directly OR route to repository analysis agents.

Rules:
- If message is greeting/smalltalk/chitchat, set mode="reply" and provide a short natural response.
- If message asks about repository/product behavior/flows/system logic, set mode="route".
- Keep refined_question clear and concise for downstream agents.

Return JSON only:
{
  "mode": "reply | route",
  "human_message": "string",
  "refined_question": "string"
}
`.trim(),
  SHIKAMARU: `
You are SHIKAMARU (Intent + Context Analyzer).
Given question, chat history summary, and session memory entities:
- infer user objective
- extract retrieval keywords
- preserve topic continuity

Rules:
- Classify intent_type as one of: greeting | smalltalk | repo_question | unclear.
- If user input is greeting/casual conversation, set intent_type to "greeting".
- For repo-related questions, set intent_type to "repo_question".
- ALWAYS output non-empty keywords for repo_question.

Return JSON only:
{
  "intent_type": "greeting | smalltalk | repo_question | unclear",
  "intent": "string",
  "objective": "string",
  "keywords": ["string"],
  "answer_style": "product | technical | beginner | executive"
}
`.trim(),
  KAKASHI: `
You are KAKASHI (Retrieval Builder query expander).
Expand keywords into semantic retrieval terms.
Return JSON only:
{
  "expanded_keywords": ["string"]
}
`.trim(),
  ITACHI: `
You are ITACHI (Flow Anchor Builder).
Given question, gojo intent/objective/keywords, and dominant repository domains:
- generate concrete flow anchors to guide retrieval
- prioritize domain-specific anchors over generic words

Rules:
- Avoid generic anchors like "system flow" unless no domain signal exists.
- Keep anchors short and retrieval-friendly.

Return JSON only:
{
  "flow_anchors": ["authentication flow", "booking flow", "payment lifecycle"]
}
`.trim(),
  SASUKE: `
You are SASUKE (Fast Technical Reasoning).
Use ONLY provided structural entities + graph edges.
If incomplete, infer likely flow from nearby connected entities only.
Never invent non-existing modules.
Return JSON only:
{
  "findings": ["string"],
  "unknowns": ["string"],
  "constraints": ["string"]
}
`.trim(),
  NARUTO: `
You are NARUTO (Product Explanation).
Translate findings into product-level explanation.
Never expose code/file/module/import/class/function names.
Use only product behavior language: user actions, system checks, outcomes.
Mention uncertainty when needed. Keep concise.
Return plain text only.
`.trim(),
} as const

function isAlphaNum(char: string) {
  const code = char.charCodeAt(0)
  const isDigit = code >= 48 && code <= 57
  const isUpper = code >= 65 && code <= 90
  const isLower = code >= 97 && code <= 122
  return isDigit || isUpper || isLower
}

function tokenizeWords(value: string, minLength = 1) {
  const tokens: string[] = []
  let current = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (isAlphaNum(ch) || ch === '_') {
      current += ch.toLowerCase()
      continue
    }
    if (current.length >= minLength) tokens.push(current)
    current = ''
  }
  if (current.length >= minLength) tokens.push(current)
  return tokens
}

function normalizeText(value: string) {
  const tokens = tokenizeWords(value, 1)
  return tokens.join(' ').trim()
}

function containsAnyPhrase(value: string, phrases: string[]) {
  const normalized = ` ${normalizeText(value)} `
  for (const phrase of phrases) {
    const p = normalizeText(phrase)
    if (!p) continue
    if (normalized.includes(` ${p} `)) return true
  }
  return false
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 1)
    .slice(0, 20)
}

function extractKeywordsFromQuestion(question: string): string[] {
  return Array.from(new Set(tokenizeWords(question, 3))).slice(0, 12)
}

const GENERIC_QUERY_WORDS = new Set([
  'explain', 'flow', 'flows', 'system', 'how', 'what', 'works', 'work', 'it', 'app', 'application',
  'overview', 'details', 'about', 'feature', 'features', 'logic', 'process',
])

const DOMAIN_STOPWORDS = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'api', 'utils', 'helper', 'helpers', 'common', 'shared',
  'index', 'main', 'service', 'services', 'controller', 'controllers', 'component', 'components',
  'module', 'modules', 'hook', 'hooks', 'model', 'models', 'types', 'type', 'route', 'routes',
  'view', 'views', 'page', 'pages', 'client', 'server', 'public', 'private', 'core', 'feature',
  'features', 'impl', 'implementation', 'test', 'tests', 'spec', 'config', 'configs',
  'js', 'jsx', 'ts', 'tsx', 'json',
])

function extractDomainTokensFromEntity(entity: EntityRow): string[] {
  const raw = `${entity.entity_name} ${entity.file_path}`.toLowerCase()
  return tokenizeWords(raw, 1)
    .filter((token) => token.length >= 3)
    .filter((token) => !DOMAIN_STOPWORDS.has(token))
    .filter((token) => !GENERIC_QUERY_WORDS.has(token))
}

function extractAnchorTerms(anchors: string[]): string[] {
  return Array.from(
    new Set(
      anchors
        .flatMap((a) => tokenizeWords(a.toLowerCase(), 1))
        .filter((token) => token.length >= 3)
        .filter((token) => !GENERIC_QUERY_WORDS.has(token))
        .filter((token) => token !== 'flow' && token !== 'lifecycle')
    )
  ).slice(0, 20)
}

function buildRetrievalKeywords(
  base: string[],
  expanded: string[],
  anchorTerms: string[],
  dominantDomains: string[]
): string[] {
  const raw = [...base, ...expanded, ...anchorTerms, ...dominantDomains]
    .map((k) => k.toLowerCase().trim())
    .filter(Boolean)
  return Array.from(new Set(raw))
    .filter((k) => !GENERIC_QUERY_WORDS.has(k))
    .slice(0, 28)
}

function scoreEntityAgainstKeywords(entity: EntityRow, keywords: string[]) {
  if (keywords.length === 0) return 0
  const metaKeywords = Array.isArray(entity.metadata?.keywords)
    ? entity.metadata?.keywords.filter((x): x is string => typeof x === 'string').join(' ')
    : ''
  const metaTags = Array.isArray(entity.metadata?.tags)
    ? entity.metadata?.tags.filter((x): x is string => typeof x === 'string').join(' ')
    : ''
  const haystack = `${entity.entity_name} ${entity.entity_type} ${entity.file_path} ${metaKeywords} ${metaTags}`.toLowerCase()
  let score = 0
  for (const keyword of keywords) {
    const k = keyword.toLowerCase().trim()
    if (k && haystack.includes(k)) score += 1
  }
  return score
}

function sanitizeForLike(value: string) {
  let out = ''
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]
    if (ch === '%' || ch === '_' || ch === '\'' || ch === '"' || ch === ',') continue
    out += ch
  }
  return out.trim().slice(0, 40)
}

function compactText(value: string, max = 220) {
  return normalizeText(value).slice(0, max)
}

function buildChatHistorySummary(history: ChatHistoryItem[]) {
  return history
    .slice(-6)
    .map((h) => `${h.role}: ${compactText(h.content, 160)}`)
    .join(' | ')
    .slice(0, 1200)
}

function getEntitySnippet(entity: EntityRow) {
  const raw = entity.metadata && typeof entity.metadata.snippet === 'string'
    ? entity.metadata.snippet
    : ''
  return compactText(raw, 200)
}

function inferStageFromEntity(entity: EntityRow) {
  const text = `${entity.entity_name} ${entity.entity_type}`.toLowerCase()
  if (containsAnyPhrase(text, ['route', 'api', 'controller', 'handler', 'entry', 'submit', 'start', 'create', 'select', 'choose', 'book', 'checkout', 'login', 'sign'])) return 'initiation'
  if (containsAnyPhrase(text, ['validate', 'verify', 'auth', 'permission', 'guard', 'check', 'policy', 'rule'])) return 'validation'
  if (containsAnyPhrase(text, ['service', 'process', 'apply', 'calculate', 'execute', 'reserve', 'payment', 'charge', 'update', 'compute'])) return 'processing'
  if (containsAnyPhrase(text, ['model', 'store', 'save', 'persist', 'state', 'session', 'token', 'record', 'cache'])) return 'state_update'
  if (containsAnyPhrase(text, ['response', 'result', 'success', 'failed', 'notify', 'redirect', 'complete', 'status'])) return 'outcome'
  if (entity.entity_type === 'dependency') return 'integration'
  return 'processing'
}

function inferAuthCapabilities(entities: EntityRow[]) {
  const corpus = entities
    .map((e) => `${e.entity_name} ${e.entity_type} ${e.file_path}`)
    .join(' ')
    .toLowerCase()
  const has = (terms: string[]) => containsAnyPhrase(corpus, terms)
  return {
    credentialSignIn: has(['signin', 'sign in', 'login', 'password', 'credential', 'email']),
    socialGoogle: has(['google', 'oauth']),
    socialGithub: has(['github']),
    signUp: has(['signup', 'sign up', 'register']),
    signOut: has(['signout', 'sign out', 'logout']),
    session: has(['session', 'token', 'jwt', 'cookie']),
    validation: has(['validate', 'verify', 'bcrypt', 'auth', 'permission', 'guard']),
    redirect: has(['redirect', 'navigate', 'route']),
  }
}

function buildDeterministicFallbackAnswer(question: string, entities: EntityRow[], relationships: GraphRow[]) {
  if (entities.length === 0) {
    return 'I could not find enough indexed structure for this question yet. Re-run ingestion to refresh the structure index.'
  }
  const queryKeywords = extractKeywordsFromQuestion(question)
  const scored = entities
    .map((entity) => ({ entity, score: scoreEntityAgainstKeywords(entity, queryKeywords) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    return `I cannot confidently confirm this specific flow from the currently indexed structure for "${compactText(question, 70)}". The repository index needs stronger matching evidence for this question before I can describe the behavior reliably.`
  }

  const anchorIds = new Set(scored.slice(0, 18).map((x) => x.entity.id))
  const relatedEdges = relationships.filter((edge) => anchorIds.has(edge.source_entity_id) || anchorIds.has(edge.target_entity_id))
  const relatedIds = new Set<string>()
  for (const edge of relatedEdges.slice(0, 180)) {
    relatedIds.add(edge.source_entity_id)
    relatedIds.add(edge.target_entity_id)
  }
  for (const id of anchorIds) relatedIds.add(id)

  const relatedEntities = entities.filter((entity) => relatedIds.has(entity.id)).slice(0, 40)
  const q = question.toLowerCase()
  const isAuthQuestion = containsAnyPhrase(q, ['auth', 'login', 'sign in', 'signin', 'signup', 'sign up', 'oauth', 'session', 'token'])
  const auth = inferAuthCapabilities(relatedEntities)

  if (isAuthQuestion) {
    const signinOptions: string[] = []
    if (auth.credentialSignIn) signinOptions.push('credentials-based sign-in')
    if (auth.socialGoogle) signinOptions.push('Google sign-in')
    if (auth.socialGithub) signinOptions.push('GitHub sign-in')

    const steps: string[] = []
    if (signinOptions.length > 0) {
      steps.push(`Sign-in options visible in the implemented flow: ${signinOptions.join(', ')}.`)
    } else {
      steps.push('The auth flow is present, but specific sign-in options are not strongly identifiable from indexed structure yet.')
    }
    if (auth.validation) {
      steps.push('After sign-in is submitted, the system validates identity before granting access.')
    }
    if (auth.session) {
      steps.push('On success, an authenticated session is established so users can access protected areas.')
    }
    if (auth.redirect) {
      steps.push('Users are then moved into the main product experience after successful authentication.')
    }
    if (auth.signOut) {
      steps.push('Sign-out is supported and clears active access.')
    }

    const confidence =
      relatedEdges.length >= 20
        ? 'Confidence is high because multiple connected auth-related relationships were found.'
        : 'Confidence is moderate because the auth flow is inferred from partial but relevant structural evidence.'
    return `${steps.join(' ')} ${confidence}`
  }

  const stageBuckets: Record<string, number> = {
    initiation: 0,
    validation: 0,
    processing: 0,
    state_update: 0,
    integration: 0,
    outcome: 0,
  }
  for (const entity of relatedEntities) stageBuckets[inferStageFromEntity(entity)] += 1

  const steps: string[] = []
  if (stageBuckets.initiation > 0) {
    steps.push('1) Users initiate the flow through a clear entry action in the product experience.')
  }
  if (stageBuckets.validation > 0) {
    steps.push('2) The system runs validation/authorization checks before moving forward.')
  }
  if (stageBuckets.processing > 0) {
    steps.push('3) Core business processing executes the requested operation.')
  }
  if (stageBuckets.state_update > 0) {
    steps.push('4) Application state and records are updated to reflect the result.')
  }
  if (stageBuckets.integration > 0) {
    steps.push('5) External/internal integrations are involved where required.')
  }
  if (stageBuckets.outcome > 0) {
    steps.push('6) The user receives the final outcome and next-step status.')
  }
  if (steps.length === 0) {
    steps.push('The flow appears to follow a standard request -> validation -> processing -> outcome pattern.')
  }

  const confidence =
    relatedEdges.length >= 20
      ? 'Confidence is high because the flow is supported by multiple connected structural relationships.'
      : 'Confidence is moderate because the flow is inferred from partial but relevant structural relationships.'
  return `${steps.join(' ')} ${confidence}`
}

function sanitizeProductAnswer(answer: string, fallback: string): string {
  const compact = normalizeText(answer)
  if (!compact) return fallback
  const tokens = compact.split(' ').filter(Boolean)
  let hasPathLike = false
  for (const token of tokens) {
    if (token.includes('/') && token.length > 3) {
      hasPathLike = true
      break
    }
  }
  const looksTechnical = hasPathLike || containsAnyPhrase(compact, [
    'import', 'module', 'file', 'path', 'controller', 'entity', 'graph', 'relationship',
    'function', 'class', 'dependency', 'snippet', 'tsx', 'jsx', 'py', 'java',
  ])
  if (looksTechnical) return fallback
  return compact
}

function toEmbeddingInput(entity: EntityRow) {
  return compactText(
    `entity=${entity.entity_name};type=${entity.entity_type};file=${entity.file_path};snippet=${getEntitySnippet(entity)};`,
    420
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const id = setTimeout(() => resolve(fallback), ms)
    promise
      .then((value) => {
        clearTimeout(id)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(id)
        resolve(fallback)
      })
  })
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0
  let an = 0
  let bn = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i]
    an += a[i] * a[i]
    bn += b[i] * b[i]
  }
  if (an === 0 || bn === 0) return 0
  return dot / (Math.sqrt(an) * Math.sqrt(bn))
}

async function resolveEmbeddingTable() {
  const supabase = getSupabaseAdmin()
  const repoTry = await supabase.from('embeddings').select('entity_id').limit(1)
  if (!repoTry.error) return 'embeddings' as const
  return 'embeddings' as const
}

async function generateEmbeddingBatch(inputs: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY || ''
  if (!apiKey || inputs.length === 0) return []

  const response = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
    }),
  })

  if (!response.ok) return []
  const payload = await response.json()
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.map((r: any) =>
    Array.isArray(r?.embedding) ? r.embedding.filter((v: unknown) => typeof v === 'number') : []
  )
}

async function readSessionMemoryEntities(input: {
  sessionId: string
  repositoryId: string
}): Promise<string[]> {
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('chat_session_memory')
    .select('entity_id')
    .eq('session_id', input.sessionId)
    .eq('repository_id', input.repositoryId)
    .order('weight', { ascending: false })
    .limit(30)
  return (data || []).map((x: any) => x.entity_id)
}

async function upsertSessionMemory(input: {
  sessionId: string
  repositoryId: string
  entityIds: string[]
}) {
  if (input.entityIds.length === 0) return
  const supabase = getSupabaseAdmin()
  const now = new Date().toISOString()

  for (const entityId of input.entityIds) {
    const { data: existing } = await supabase
      .from('chat_session_memory')
      .select('weight')
      .eq('session_id', input.sessionId)
      .eq('repository_id', input.repositoryId)
      .eq('entity_id', entityId)
      .maybeSingle()

    const nextWeight = typeof existing?.weight === 'number' ? existing.weight + 1 : 1
    await supabase
      .from('chat_session_memory')
      .upsert(
        {
          session_id: input.sessionId,
          repository_id: input.repositoryId,
          entity_id: entityId,
          weight: nextWeight,
          last_used: now,
        },
        { onConflict: 'session_id,repository_id,entity_id' }
      )
  }
}

async function detectDominantRepoDomains(repositoryId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('repository_entities')
    .select('entity_name,file_path')
    .eq('repository_id', repositoryId)
    .limit(500)

  const frequency = new Map<string, number>()
  for (const row of data || []) {
    const entity = {
      id: '',
      entity_name: (row as any).entity_name || '',
      entity_type: '',
      file_path: (row as any).file_path || '',
      metadata: null,
    } as EntityRow
    const tokens = extractDomainTokensFromEntity(entity)
    for (const token of tokens) {
      frequency.set(token, (frequency.get(token) || 0) + 1)
    }
  }

  return Array.from(frequency.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([token]) => token)
    .slice(0, 10)
}

async function generateFlowAnchors(input: {
  question: string
  gojo: GojoOutput
  dominantDomains: string[]
}): Promise<string[]> {
  const fallback = {
    flow_anchors: input.dominantDomains.slice(0, 6).map((domain) => `${domain} flow`),
  }
  const parsed = await runOpenAIJson<{ flow_anchors: string[] }>(
    AGENT_PROMPTS.ITACHI,
    JSON.stringify({
      question: input.question,
      gojo: {
        intent: input.gojo.intent,
        objective: input.gojo.objective,
        keywords: input.gojo.keywords,
      },
      dominant_repo_domains: input.dominantDomains,
    }),
    fallback
  )
  const anchors = Array.isArray(parsed?.flow_anchors)
    ? parsed.flow_anchors.filter((x): x is string => typeof x === 'string')
    : []
  const normalized = Array.from(
    new Set(
      anchors
        .map((a) => compactText(a.toLowerCase(), 48))
        .filter((a) => a.length > 3)
    )
  ).slice(0, 8)
  if (normalized.length > 0) return normalized
  return fallback.flow_anchors
}

async function retrieveEntitiesByKeywords(
  repositoryId: string,
  keywords: string[]
): Promise<{ entities: EntityRow[]; usedFallback: boolean }> {
  const supabase = getSupabaseAdmin()
  const map = new Map<string, EntityRow>()
  for (const keyword of keywords.slice(0, 10)) {
    const like = sanitizeForLike(keyword)
    if (!like) continue
    const { data } = await supabase
      .from('repository_entities')
      .select('id,entity_name,entity_type,file_path,metadata')
      .eq('repository_id', repositoryId)
      .or(`entity_name.ilike.%${like}%,file_path.ilike.%${like}%`)
      .limit(40)
    for (const row of data || []) map.set(row.id, row as EntityRow)
  }

  return { entities: Array.from(map.values()), usedFallback: false }
}

function scoreForSeedRanking(entity: EntityRow, retrievalKeywords: string[], dominantDomains: string[], inSession: boolean) {
  const keywordScore = scoreEntityAgainstKeywords(entity, retrievalKeywords)
  const domainScore = scoreEntityAgainstKeywords(entity, dominantDomains)
  const sessionBoost = inSession ? 1 : 0
  return keywordScore * 2 + domainScore + sessionBoost
}

async function retrieveEntitiesByIds(repositoryId: string, ids: string[]): Promise<EntityRow[]> {
  if (ids.length === 0) return []
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from('repository_entities')
    .select('id,entity_name,entity_type,file_path,metadata')
    .eq('repository_id', repositoryId)
    .in('id', ids.slice(0, 80))
  return (data || []) as EntityRow[]
}

async function expandGraph(repositoryId: string, seedIds: string[]) {
  if (seedIds.length === 0) return { entities: [] as EntityRow[], relationships: [] as GraphRow[] }
  const supabase = getSupabaseAdmin()
  const [outA, outB] = await Promise.all([
    supabase
      .from('code_graph')
      .select('source_entity_id,target_entity_id,relationship_type')
      .eq('repository_id', repositoryId)
      .in('source_entity_id', seedIds)
      .limit(300),
    supabase
      .from('code_graph')
      .select('source_entity_id,target_entity_id,relationship_type')
      .eq('repository_id', repositoryId)
      .in('target_entity_id', seedIds)
      .limit(300),
  ])
  const relationships = [...(outA.data || []), ...(outB.data || [])] as GraphRow[]
  const ids = new Set<string>(seedIds)
  for (const edge of relationships) {
    ids.add(edge.source_entity_id)
    ids.add(edge.target_entity_id)
  }
  const entities = await retrieveEntitiesByIds(repositoryId, Array.from(ids))
  return { entities, relationships }
}

async function rerankWithEmbeddings(repositoryId: string, question: string, entities: EntityRow[]) {
  if (entities.length === 0) return entities
  const queryVectorBatch = await generateEmbeddingBatch([question])
  const queryVector = queryVectorBatch[0]
  if (!queryVector || queryVector.length === 0) return entities

  const table = await resolveEmbeddingTable()
  const supabase = getSupabaseAdmin()
  const { data } = await supabase
    .from(table)
    .select('entity_id,embedding')
    .eq('repository_id', repositoryId)
    .in('entity_id', entities.map((e) => e.id).slice(0, 120))

  const vectors = new Map<string, number[]>()
  for (const row of data || []) {
    if (Array.isArray((row as any).embedding)) {
      vectors.set((row as any).entity_id, (row as any).embedding.filter((v: unknown) => typeof v === 'number'))
    }
  }

  return entities
    .map((entity, index) => {
      const vec = vectors.get(entity.id)
      const semantic = vec ? cosineSimilarity(queryVector, vec) : 0
      const lexicalPrior = 1 / (1 + index)
      return { entity, score: semantic + lexicalPrior * 0.15 }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entity)
}

async function runMetalBatWorker(input: {
  repositoryId: string
  keywords: string[]
  entities: EntityRow[]
  logger: IngestionLogger
}) {
  await input.logger.log({
    orchestratorState: 'chat_async_embedding',
    agentName: 'METAL_BAT',
    step: 'lazy_embedding_start',
    status: 'started',
    inputSummary: { keywords: input.keywords.slice(0, 8), candidate_entities: input.entities.length },
    outputSummary: {},
  })

  const table = await resolveEmbeddingTable()
  const supabase = getSupabaseAdmin()
  const candidates = input.entities.slice(0, 20)
  const { data: existing } = await supabase
    .from(table)
    .select('entity_id')
    .eq('repository_id', input.repositoryId)
    .in('entity_id', candidates.map((e) => e.id))

  const existingIds = new Set((existing || []).map((x: any) => x.entity_id))
  const missing = candidates.filter((e) => !existingIds.has(e.id))
  if (missing.length === 0) {
    await input.logger.log({
      orchestratorState: 'chat_async_embedding',
      agentName: 'METAL_BAT',
      step: 'lazy_embedding_start',
      status: 'skipped',
      inputSummary: { candidates: candidates.length },
      outputSummary: { reason: 'all_candidates_already_embedded' },
    })
    return
  }

  const inputs = missing.map((entity) => toEmbeddingInput(entity))
  const vectors = await generateEmbeddingBatch(inputs)
  const rows: Array<{
    repository_id: string
    entity_id: string
    embedding: number[]
    semantic_summary: string
  }> = []

  for (let i = 0; i < missing.length; i += 1) {
    const vector = vectors[i]
    if (!Array.isArray(vector) || vector.length === 0) continue
    rows.push({
      repository_id: input.repositoryId,
      entity_id: missing[i].id,
      embedding: vector,
      semantic_summary: inputs[i],
    })
  }

  if (rows.length === 0) {
    await input.logger.log({
      orchestratorState: 'chat_async_embedding',
      agentName: 'METAL_BAT',
      step: 'lazy_embedding_upsert',
      status: 'failed',
      inputSummary: { missing_entities: missing.length, embedding_model: EMBEDDING_MODEL },
      outputSummary: {},
      errorMessage: 'embedding_vectors_empty',
    })
    return
  }

  for (let i = 0; i < rows.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBEDDING_BATCH_SIZE)
    const { error } = await supabase.from(table).upsert(batch, { onConflict: 'repository_id,entity_id' })
    if (error) {
      await input.logger.log({
        orchestratorState: 'chat_async_embedding',
        agentName: 'METAL_BAT',
        step: 'lazy_embedding_upsert',
        status: 'failed',
        inputSummary: { batch_size: batch.length },
        outputSummary: {},
        errorMessage: error.message,
      })
      return
    }
  }

  await input.logger.log({
    orchestratorState: 'chat_async_embedding',
    agentName: 'METAL_BAT',
    step: 'lazy_embedding_upsert',
    status: 'success',
    inputSummary: { missing_entities: missing.length },
    outputSummary: { embedded_entity_count: rows.length, sample_entity_ids: rows.slice(0, 10).map((r) => r.entity_id) },
  })
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now()
  let repositoryIdForLogs = 'unknown'
  try {
    const body = await request.json()
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    const repositoryId = typeof body?.repositoryId === 'string' ? body.repositoryId.trim() : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : `session_${repositoryId || 'unknown'}`
    const chatHistory = Array.isArray(body?.chatHistory) ? body.chatHistory as ChatHistoryItem[] : []
    repositoryIdForLogs = repositoryId || 'unknown'
    const logger = new IngestionLogger(repositoryIdForLogs, true)

    if (!question) {
      return NextResponse.json({ answer: 'Question is required', debug: {} }, { status: 400 })
    }
    if (!repositoryId) {
      return NextResponse.json({ answer: 'repositoryId is required', debug: {} }, { status: 400 })
    }

    const authHeader = request.headers.get('authorization')
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!accessToken) {
      return NextResponse.json({ answer: 'Unauthorized', debug: {} }, { status: 401 })
    }

    const authUser = await getUserFromBearerToken(accessToken)
    if (!authUser) {
      return NextResponse.json({ answer: 'Unauthorized', debug: {} }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: memberships } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', authUser.id)
    const orgIds = (memberships || []).map((m) => m.organization_id)
    if (orgIds.length === 0) {
      return NextResponse.json({ answer: 'No organization access', debug: {} }, { status: 403 })
    }

    const { data: repository } = await supabase
      .from('repositories')
      .select('id')
      .eq('id', repositoryId)
      .in('organization_id', orgIds)
      .maybeSingle()
    if (!repository) {
      return NextResponse.json({ answer: 'Repository not accessible', debug: {} }, { status: 403 })
    }

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'GENOS',
      step: 'chat_start',
      status: 'started',
      inputSummary: { question_len: question.length, session_id: sessionId },
      outputSummary: {},
    })

    const historySummary = buildChatHistorySummary(chatHistory)

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'IRUKA',
      step: 'frontdesk_intake',
      status: 'started',
      inputSummary: { question_len: question.length, history_summary_len: historySummary.length },
      outputSummary: {},
    })

    const frontdeskFallback: FrontdeskOutput = {
      mode: 'route',
      human_message: 'Got it. Let me analyze that from your repository context.',
      refined_question: question,
    }

    const frontdesk = await withTimeout(
      runOpenAIJson<FrontdeskOutput>(
        AGENT_PROMPTS.IRUKA,
        JSON.stringify({
          message: question,
          chat_history_summary: historySummary,
        }),
        frontdeskFallback
      ),
      450,
      frontdeskFallback
    )

    const frontdeskMode = frontdesk?.mode === 'reply' ? 'reply' : 'route'
    const refinedQuestion =
      typeof frontdesk?.refined_question === 'string' && frontdesk.refined_question.trim().length > 0
        ? frontdesk.refined_question.trim()
        : question
    const frontdeskMessage =
      typeof frontdesk?.human_message === 'string' && frontdesk.human_message.trim().length > 0
        ? frontdesk.human_message.trim()
        : frontdeskFallback.human_message

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'IRUKA',
      step: 'frontdesk_intake',
      status: 'success',
      inputSummary: { question_len: question.length },
      outputSummary: { mode: frontdeskMode, refined_question_len: refinedQuestion.length },
    })

    if (frontdeskMode === 'reply') {
      await logger.log({
        orchestratorState: 'chat_orchestrator',
        agentName: 'GENOS',
        step: 'chat_end',
        status: 'success',
        inputSummary: { elapsed_ms: Date.now() - startedAt, frontdesk_short_circuit: true },
        outputSummary: { retrieval_candidates: 0, async_embedding_triggered: false },
      })
      return NextResponse.json({
        answer: frontdeskMessage,
        debug: {
          mode: 'frontdesk_reply',
          frontdesk: { mode: frontdeskMode, refined_question: refinedQuestion },
          performance: { elapsed_ms: Date.now() - startedAt, target_ms: RESPONSE_BUDGET_MS },
        },
      })
    }

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'SHIKAMARU',
      step: 'intent_analysis',
      status: 'started',
      inputSummary: {
        question_len: refinedQuestion.length,
        history_summary_len: historySummary.length,
        memory_entities: 0,
      },
      outputSummary: {},
    })

    const gojoFallback: GojoOutput = {
      intent_type: 'unclear',
      intent: 'unknown',
      objective: compactText(refinedQuestion, 120),
      keywords: extractKeywordsFromQuestion(refinedQuestion),
      answer_style: 'product',
    }

    const gojo = await withTimeout(
      runOpenAIJson<GojoOutput>(
        AGENT_PROMPTS.SHIKAMARU,
        JSON.stringify({
          question: refinedQuestion,
          chat_history_summary: historySummary,
          session_memory_entities: [],
        }),
        gojoFallback
      ),
      700,
      gojoFallback
    )

    const gojoKeywords = normalizeKeywords(gojo.keywords)
    const fallbackQuestionKeywords = extractKeywordsFromQuestion(refinedQuestion)
    if (gojo.intent_type === 'greeting') {
      const greetingFallback =
        'Hi! Happy to help. Ask me what flows are implemented in your product, and I will explain them in product language.'
      const greetingAnswer = await withTimeout(
        runOpenAIText(
          AGENT_PROMPTS.NARUTO,
          JSON.stringify({
            mode: 'greeting',
            user_message: refinedQuestion,
            instruction: 'Reply briefly and conversationally. Do not discuss code details.',
          }),
          greetingFallback
        ),
        450,
        greetingFallback
      )

      await logger.log({
        orchestratorState: 'chat_orchestrator',
        agentName: 'NARUTO',
        step: 'product_translation',
        status: 'success',
        inputSummary: { intent_type: 'greeting' },
        outputSummary: { answer_len: greetingAnswer.length, greeting_short_circuit: true },
      })

      await logger.log({
        orchestratorState: 'chat_orchestrator',
        agentName: 'GENOS',
        step: 'chat_end',
        status: 'success',
        inputSummary: { elapsed_ms: Date.now() - startedAt, greeting_short_circuit: true },
        outputSummary: { retrieval_candidates: 0, async_embedding_triggered: false },
      })
      return NextResponse.json({
        answer: greetingAnswer,
        debug: {
          mode: 'greeting_short_circuit',
          gojo: { ...gojo, keywords: gojoKeywords },
          performance: { elapsed_ms: Date.now() - startedAt, target_ms: RESPONSE_BUDGET_MS },
        },
      })
    }

    const dominantDomains = await detectDominantRepoDomains(repositoryId)
    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'KAKASHI',
      step: 'dominant_repo_domains_detected',
      status: 'success',
      inputSummary: { entities_scanned_limit: 500 },
      outputSummary: {
        dominant_domains_count: dominantDomains.length,
        dominant_domains_sample: dominantDomains.slice(0, 8),
      },
    })

    const weakGojo = isVagueIntent(gojo.intent, gojo.intent_type, gojoKeywords)
    const finalGojoKeywords = weakGojo
      ? Array.from(new Set([...gojoKeywords, ...fallbackQuestionKeywords, ...dominantDomains.slice(0, 6)])).slice(0, 16)
      : (gojoKeywords.length > 0 ? gojoKeywords : fallbackQuestionKeywords)

    const memoryEntityIds = await readSessionMemoryEntities({ sessionId, repositoryId })
    const memoryEntities = await retrieveEntitiesByIds(repositoryId, memoryEntityIds)

    const correctedGojo: GojoOutput = weakGojo
      ? {
          intent_type: 'repo_question',
          intent: 'repository_overview',
          objective: 'explain major application flows',
          keywords: finalGojoKeywords,
          answer_style: 'product',
        }
      : { ...gojo, keywords: finalGojoKeywords }

    if (weakGojo) {
      await logger.log({
        orchestratorState: 'chat_orchestrator',
        agentName: 'SHIKAMARU',
        step: 'vague_intent_correction',
        status: 'success',
        inputSummary: { original_intent: gojo.intent || 'unknown', original_keywords: gojoKeywords.slice(0, 10) },
        outputSummary: {
          correction_triggered: true,
          corrected_intent: correctedGojo.intent,
          corrected_keywords: correctedGojo.keywords.slice(0, 12),
        },
      })
    }
    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'SHIKAMARU',
      step: 'intent_analysis',
      status: 'success',
      inputSummary: { question_len: question.length },
      outputSummary: {
        intent: correctedGojo.intent || 'unknown',
        objective: correctedGojo.objective || compactText(question, 120),
        keywords_count: finalGojoKeywords.length,
      },
    })

    const fubukiExpanded = await withTimeout(
      runOpenAIJson<{ expanded_keywords: string[] }>(
        AGENT_PROMPTS.KAKASHI,
        JSON.stringify({
          question: refinedQuestion,
          base_keywords: finalGojoKeywords,
        }),
        { expanded_keywords: finalGojoKeywords }
      ),
      500,
      { expanded_keywords: finalGojoKeywords }
    )
    const expandedKeywords = normalizeKeywords(fubukiExpanded.expanded_keywords)
    const sonicFallbackAnchors = dominantDomains.slice(0, 6).map((d) => `${d} flow`)
    const flowAnchors = await withTimeout(
      generateFlowAnchors({
        question: refinedQuestion,
        gojo: correctedGojo,
        dominantDomains,
      }),
      500,
      sonicFallbackAnchors
    )
    const anchorTerms = extractAnchorTerms(flowAnchors)
    const retrievalKeywords = buildRetrievalKeywords(
      refinedQuestion,
      finalGojoKeywords,
      expandedKeywords,
      anchorTerms,
      dominantDomains
    )

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'ITACHI',
      step: 'flow_anchor_generation',
      status: 'success',
      inputSummary: { dominant_domains_count: dominantDomains.length, gojo_keywords_count: finalGojoKeywords.length },
      outputSummary: { anchors_count: flowAnchors.length, anchors_sample: flowAnchors.slice(0, 6) },
    })

    const sessionPriority = memoryEntities
      .map((entity) => ({ entity, score: scoreEntityAgainstKeywords(entity, retrievalKeywords) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.entity)
      .slice(0, 20)

    const keywordResult = await retrieveEntitiesByKeywords(repositoryId, retrievalKeywords)
    let keywordMatched = keywordResult.entities
    let domainFallbackUsed = false
    if (keywordMatched.length === 0 && dominantDomains.length > 0) {
      const domainFallback = await retrieveEntitiesByKeywords(repositoryId, dominantDomains.slice(0, 8))
      keywordMatched = domainFallback.entities
      domainFallbackUsed = keywordMatched.length > 0
    }

    const merged = new Map<string, EntityRow>()
    for (const entity of keywordMatched) merged.set(entity.id, entity)
    for (const entity of sessionPriority) if (!merged.has(entity.id)) merged.set(entity.id, entity)

    const sessionSet = new Set(sessionPriority.map((entity) => entity.id))
    const seeds = Array.from(merged.values())
      .map((entity) => ({
        entity,
        rank: scoreForSeedRanking(entity, retrievalKeywords, dominantDomains, sessionSet.has(entity.id)),
      }))
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 80)
      .map((x) => x.entity)

    const { entities: expandedEntities, relationships } = await expandGraph(repositoryId, seeds.map((e) => e.id))
    const reranked = await rerankWithEmbeddings(repositoryId, refinedQuestion, expandedEntities)
    const candidateEntities = reranked.slice(0, 80)

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'KAKASHI',
      step: 'retrieval_builder',
      status: 'success',
      inputSummary: {
        retrieval_keywords_count: retrievalKeywords.length,
        session_entities: sessionPriority.length,
        flow_anchors_count: flowAnchors.length,
      },
      outputSummary: {
        seed_entities: seeds.length,
        expanded_entities: expandedEntities.length,
        final_candidates: candidateEntities.length,
        relationships: relationships.length,
        fallback_seeding_used: keywordResult.entities.length === 0,
        domain_fallback_used: domainFallbackUsed,
      },
    })

    if (candidateEntities.length === 0) {
      return NextResponse.json({
        answer: 'I could not find enough structural context for this question. Re-run ingestion to rebuild the structure index.',
        debug: {
          gojo: correctedGojo,
          sonic: { dominant_domains: dominantDomains, flow_anchors: flowAnchors },
          fubuki: { retrieval_keywords: retrievalKeywords },
        },
      })
    }

    const sukunaFallback: SukunaOutput = {
      findings: [],
      unknowns: ['insufficient context'],
      constraints: ['insufficient structural evidence'],
    }

    const sukuna = await withTimeout(
      runOpenAIJson<SukunaOutput>(
        AGENT_PROMPTS.SASUKE,
        JSON.stringify({
          objective: correctedGojo.objective || compactText(refinedQuestion, 120),
          keywords: retrievalKeywords,
          entities: candidateEntities.slice(0, 40).map((e) => ({
            id: e.id,
            name: e.entity_name,
            type: e.entity_type,
            path: e.file_path,
            snippet: getEntitySnippet(e),
          })),
          relationships: relationships.slice(0, 120),
        }),
        sukunaFallback
      ),
      600,
      sukunaFallback
    )

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'SASUKE',
      step: 'reasoning',
      status: 'success',
      inputSummary: { entity_context_count: candidateEntities.length, relationship_count: relationships.length },
      outputSummary: { findings_count: sukuna.findings.length, unknowns_count: sukuna.unknowns.length },
    })

    const deterministicFallback = buildDeterministicFallbackAnswer(refinedQuestion, candidateEntities, relationships)
    const canUseYuji = sukuna.findings.length > 0
    const yujiAnswerRaw = canUseYuji
      ? await withTimeout(
          runOpenAIText(
            AGENT_PROMPTS.NARUTO,
            JSON.stringify({
              question: refinedQuestion,
              objective: correctedGojo.objective || compactText(refinedQuestion, 120),
              findings: sukuna.findings,
              unknowns: sukuna.unknowns,
              constraints: sukuna.constraints,
            }),
            deterministicFallback
          ),
          450,
          deterministicFallback
        )
      : deterministicFallback
    const yujiAnswer = sanitizeProductAnswer(yujiAnswerRaw, deterministicFallback)

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'NARUTO',
      step: 'product_translation',
      status: canUseYuji ? 'success' : 'skipped',
      inputSummary: { findings_count: sukuna.findings.length, unknowns_count: sukuna.unknowns.length },
      outputSummary: { answer_len: yujiAnswer.length, fallback_used: !canUseYuji },
    })

    // Update session memory for continuity.
    const usedEntityIds = candidateEntities.slice(0, 20).map((e) => e.id)
    void upsertSessionMemory({
      sessionId,
      repositoryId,
      entityIds: usedEntityIds,
    }).catch((error) => {
      console.warn('chat_session_memory upsert failed:', error instanceof Error ? error.message : String(error))
    })

    // Async lazy embeddings after response path has been prepared.
    const metalBatPromise = runMetalBatWorker({
      repositoryId,
      keywords: Array.from(new Set([...dominantDomains, ...anchorTerms, ...finalGojoKeywords])).slice(0, 20),
      entities: candidateEntities,
      logger,
    }).catch((error) => {
      void logger.log({
        orchestratorState: 'chat_async_embedding',
        agentName: 'METAL_BAT',
        step: 'lazy_embedding_start',
        status: 'failed',
        inputSummary: { candidates: candidateEntities.length },
        outputSummary: {},
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    })
    void metalBatPromise

    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'GENOS',
      step: 'chat_end',
      status: 'success',
      inputSummary: { elapsed_ms: Date.now() - startedAt },
      outputSummary: {
        retrieval_candidates: candidateEntities.length,
        async_embedding_triggered: true,
      },
    })

    return NextResponse.json({
      answer: yujiAnswer,
      debug: {
        gojo: correctedGojo,
        frontdesk: { mode: frontdeskMode, refined_question: refinedQuestion },
        sonic: {
          dominant_domains: dominantDomains,
          flow_anchors: flowAnchors,
        },
        fubuki: {
          expanded_keywords: expandedKeywords,
          retrieval_keywords: retrievalKeywords,
          session_entities_used: sessionPriority.length,
        },
        sukuna,
        performance: {
          elapsed_ms: Date.now() - startedAt,
          target_ms: RESPONSE_BUDGET_MS,
        },
      },
    })
  } catch (error) {
    const logger = new IngestionLogger(repositoryIdForLogs, true)
    await logger.log({
      orchestratorState: 'chat_orchestrator',
      agentName: 'GENOS',
      step: 'chat_end',
      status: 'failed',
      inputSummary: {},
      outputSummary: {},
      errorMessage: error instanceof Error ? error.message : 'chat_pipeline_failed',
    })
    return NextResponse.json(
      { answer: 'Unable to answer right now. Please try again.', debug: {} },
      { status: 500 }
    )
  }
}
/*
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { runOpenAIJson, runOpenAIText } from '@/lib/llm/openai'

type GojoOutput = {
  intent: string
  objective: string
  keywords: string[]
  answer_style: string
}

type FubukiExpansion = {
  expanded_keywords: string[]
}

type SukunaOutput = {
  findings: string[]
  unknowns: string[]
  constraints: string[]
}

type HakariOutput = {
  status: 'passed' | 'needs_correction'
  issues: string[]
}

type EntityRow = {
  id: string
  entity_name: string
  entity_type: string
  file_path: string
  metadata: Record<string, unknown> | null
}

type GraphRow = {
  source_entity_id: string
  target_entity_id: string
  relationship_type: string
}

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
const EMBEDDING_BATCH_SIZE = 64

export const AGENT_PROMPTS = {
  GOJO: `
You are GOJO, an intent analysis agent.

Your job:
- Understand user intent from query.
- Extract clear product/repository objective.
- Produce retrieval-friendly keywords.

Rules:
- Do NOT answer the question.
- Focus on intent classification and search optimization.
- Keep keywords short and semantic.

Return JSON ONLY:

{
  "intent": "short classification label",
  "objective": "what the user is trying to achieve",
  "keywords": ["semantic keyword", "feature name", "domain concept"],
  "answer_style": "technical | product | beginner | executive | summary"
}
`.trim(),

  FUBUKI: `
You are FUBUKI, a query expansion agent.

Your job:
- Expand keywords into semantic search queries.
- Optimize for vector search and repository retrieval.
- Include synonyms, architecture terms, and product-level concepts.

Rules:
- Keep terms compact and retrieval-friendly.
- Avoid long sentences.
- No explanations.

Return JSON ONLY:

{
  "expanded_keywords": ["semantic phrase", "architecture term", "feature synonym"]
}
`.trim(),

  SUKUNA: `
You are SUKUNA, a technical reasoning agent.

Your job:
- Analyze ONLY provided repository structural context.
- Use entities, relationships, and structural graph data.
- Infer flows ONLY when strongly supported by structure.

STRICT RULES:
- DO NOT invent architecture.
- DO NOT assume missing modules.
- DO NOT infer business logic without structural evidence.
- If unsure → mark as unknown.

If insufficient context:

{
  "findings": [],
  "unknowns": ["insufficient context"],
  "constraints": ["insufficient structural evidence"]
}

Return JSON ONLY:

{
  "findings": ["structurally supported technical observation"],
  "unknowns": ["missing info or uncertainty"],
  "constraints": ["limitations from provided data"]
}
`.trim(),

  HAKARI: `
You are HAKARI, a validation guardrail agent.

Your job:
- Validate SUKUNA output.
- Detect hallucination or unsupported claims.
- Ensure findings match structural evidence.

Rules:
- If any unsupported inference exists → needs_correction.
- Be strict.

Return JSON ONLY:

{
  "status": "passed" | "needs_correction",
  "issues": ["validation error or hallucination risk"]
}
`.trim(),

  YUJI: `
You are YUJI, a product explanation agent.

Your job:
- Convert validated technical findings into clear product explanation.
- Explain flows at product or user level.
- Keep explanation structured and readable.

Rules:
- NEVER invent unknown flows.
- Explicitly mention uncertainty if present.
- Prefer simple, clear language.

Return plain text ONLY.
`.trim(),
} as const;

function logAgentEvent(params: {
  repositoryId: string
  agentName: 'GOJO' | 'FUBUKI' | 'YUTA' | 'SUKUNA' | 'HAKARI' | 'YUJI'
  step: string
  status: 'started' | 'success' | 'failed' | 'skipped'
  inputSummary?: Record<string, unknown>
  outputSummary?: Record<string, unknown>
  errorMessage?: string
}) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      repository_id: params.repositoryId,
      agent_name: params.agentName,
      step: params.step,
      status: params.status,
      input_summary: params.inputSummary || {},
      output_summary: params.outputSummary || {},
      ...(params.errorMessage ? { error_message: params.errorMessage } : {}),
    })
  )
}

function logAgentIO(
  agentName: 'GOJO' | 'FUBUKI' | 'YUTA' | 'SUKUNA' | 'HAKARI' | 'YUJI',
  phase: 'INPUT' | 'OUTPUT',
  payload: Record<string, unknown>
) {
  console.log(`[${agentName} ${phase}]:`, payload)
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 1)
    .slice(0, 16)
}

function sanitizeForLike(value: string) {
  return value.replace(/[%_,'"]/g, '').trim().slice(0, 40)
}

function compactText(value: string, max = 260) {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

function pickSnippet(metadata: Record<string, unknown> | null) {
  const raw = metadata && typeof metadata.snippet === 'string' ? metadata.snippet : ''
  return compactText(raw, 220)
}

async function gojoIntent(question: string): Promise<GojoOutput> {
  const fallback: GojoOutput = {
    intent: 'unknown',
    objective: 'unknown',
    keywords: [],
    answer_style: 'product',
  }
  const parsed = await runOpenAIJson<GojoOutput>(
    AGENT_PROMPTS.GOJO,
    JSON.stringify({ question }),
    fallback
  )
  return {
    intent: typeof parsed?.intent === 'string' ? parsed.intent : 'unknown',
    objective: typeof parsed?.objective === 'string' ? parsed.objective : 'unknown',
    keywords: normalizeKeywords(parsed?.keywords),
    answer_style: typeof parsed?.answer_style === 'string' ? parsed.answer_style : 'product',
  }
}

async function fubukiExpandKeywords(question: string, baseKeywords: string[]): Promise<string[]> {
  const fallback: FubukiExpansion = { expanded_keywords: baseKeywords }
  const parsed = await runOpenAIJson<FubukiExpansion>(
    AGENT_PROMPTS.FUBUKI,
    JSON.stringify({ question, base_keywords: baseKeywords }),
    fallback
  )
  return normalizeKeywords(parsed?.expanded_keywords)
}

function computeEntityScore(entity: EntityRow, keywords: string[]) {
  const haystack = [
    entity.entity_name,
    entity.file_path,
    JSON.stringify(entity.metadata || {}),
  ]
    .join(' ')
    .toLowerCase()

  let score = 0
  for (const keyword of keywords) {
    if (haystack.includes(keyword)) score += 1
  }
  if (entity.entity_type === 'api') score += 0.5
  if (entity.entity_type === 'function' || entity.entity_type === 'class') score += 0.25
  return score
}

async function retrieveStructuralCandidates(
  repositoryId: string,
  keywords: string[]
): Promise<EntityRow[]> {
  const supabase = getSupabaseAdmin()
  const entities = new Map<string, EntityRow>()

  for (const keyword of keywords.slice(0, 8)) {
    const like = sanitizeForLike(keyword)
    if (!like) continue
    const { data } = await supabase
      .from('repository_entities')
      .select('id,entity_name,entity_type,file_path,metadata')
      .eq('repository_id', repositoryId)
      .or(`entity_name.ilike.%${like}%,file_path.ilike.%${like}%`)
      .limit(40)

    for (const row of data || []) {
      entities.set(row.id, row as EntityRow)
    }
  }

  if (entities.size === 0) {
    const { data } = await supabase
      .from('repository_entities')
      .select('id,entity_name,entity_type,file_path,metadata')
      .eq('repository_id', repositoryId)
      .limit(80)
    for (const row of data || []) {
      entities.set(row.id, row as EntityRow)
    }
  }

  const ranked = Array.from(entities.values())
    .map((entity) => ({ entity, score: computeEntityScore(entity, keywords) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
    .map((x) => x.entity)

  return ranked
}

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0
  let aNorm = 0
  let bNorm = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i]
    aNorm += a[i] * a[i]
    bNorm += b[i] * b[i]
  }
  if (aNorm === 0 || bNorm === 0) return 0
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm))
}

async function generateQueryEmbedding(question: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY || ''
  if (!apiKey) return null
  try {
    const response = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: compactText(question, 1000),
      }),
    })
    if (!response.ok) return null
    const payload = await response.json()
    const embedding = payload?.data?.[0]?.embedding
    if (!Array.isArray(embedding)) return null
    return embedding.filter((v: unknown) => typeof v === 'number')
  } catch {
    return null
  }
}

async function rerankWithEmbeddings(
  repositoryId: string,
  entities: EntityRow[],
  question: string
): Promise<EntityRow[]> {
  const queryEmbedding = await generateQueryEmbedding(question)
  if (!queryEmbedding || entities.length === 0) return entities

  const supabase = getSupabaseAdmin()
  const ids = entities.map((e) => e.id)
  const { data } = await supabase
    .from('embeddings')
    .select('entity_id,embedding')
    .eq('repository_id', repositoryId)
    .in('entity_id', ids)

  const vectors = new Map<string, number[]>()
  for (const row of data || []) {
    if (Array.isArray(row.embedding)) {
      vectors.set(row.entity_id, row.embedding.filter((v: unknown) => typeof v === 'number'))
    }
  }

  const ranked = entities
    .map((entity, idx) => {
      const vector = vectors.get(entity.id)
      const semanticScore = vector ? cosineSimilarity(queryEmbedding, vector) : 0
      // Keep keyword ordering as a light prior.
      const lexicalPrior = 1 / (1 + idx)
      return { entity, score: semanticScore + lexicalPrior * 0.15 }
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.entity)

  return ranked
}

async function expandGraphContext(
  repositoryId: string,
  seedEntities: EntityRow[]
): Promise<{ entities: EntityRow[]; relationships: GraphRow[] }> {
  const supabase = getSupabaseAdmin()
  const seedIds = seedEntities.map((e) => e.id).slice(0, 60)
  if (seedIds.length === 0) return { entities: [], relationships: [] }

  const [sourceEdges, targetEdges] = await Promise.all([
    supabase
      .from('code_graph')
      .select('source_entity_id,target_entity_id,relationship_type')
      .eq('repository_id', repositoryId)
      .in('source_entity_id', seedIds)
      .limit(300),
    supabase
      .from('code_graph')
      .select('source_entity_id,target_entity_id,relationship_type')
      .eq('repository_id', repositoryId)
      .in('target_entity_id', seedIds)
      .limit(300),
  ])

  const relationships = [
    ...(sourceEdges.data || []),
    ...(targetEdges.data || []),
  ] as GraphRow[]

  const relatedIds = new Set<string>(seedIds)
  for (const edge of relationships) {
    relatedIds.add(edge.source_entity_id)
    relatedIds.add(edge.target_entity_id)
  }

  const ids = Array.from(relatedIds).slice(0, 180)
  const { data: relatedEntities } = await supabase
    .from('repository_entities')
    .select('id,entity_name,entity_type,file_path,metadata')
    .eq('repository_id', repositoryId)
    .in('id', ids)

  return {
    entities: (relatedEntities || []) as EntityRow[],
    relationships,
  }
}

function buildEmbeddingInput(entity: EntityRow) {
  const snippet = pickSnippet(entity.metadata)
  const tags =
    entity.metadata && Array.isArray(entity.metadata.tags)
      ? entity.metadata.tags.filter((t: unknown) => typeof t === 'string').slice(0, 8).join(',')
      : ''
  return compactText(
    `entity=${entity.entity_name};type=${entity.entity_type};file=${entity.file_path};tags=${tags};snippet=${snippet};`,
    420
  )
}

async function generateEmbeddingsBatchOrThrow(inputs: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY || ''
  if (!apiKey) throw new Error('authorization fail')

  const response = await fetch(`${OPENAI_BASE_URL}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: inputs,
    }),
  })

  if (!response.ok) throw new Error(`embedding_request_failed_${response.status}`)
  const payload = await response.json()
  const data = Array.isArray(payload?.data) ? payload.data : []
  if (data.length !== inputs.length) throw new Error('embedding_response_mismatch')

  return data.map((item: any) => {
    if (!Array.isArray(item?.embedding)) throw new Error('embedding_invalid_vector')
    const vector = item.embedding.filter((v: unknown) => typeof v === 'number')
    if (vector.length === 0) throw new Error('embedding_empty_vector')
    return vector
  })
}

async function triggerLazyEmbeddingsInBackground(input: {
  repositoryId: string
  missingEntities: EntityRow[]
}) {
  const supabase = getSupabaseAdmin()
  const toEmbed = input.missingEntities.slice(0, 160)
  console.log('[FUBUKI LAZY EMBEDDING]:', {
    repository_id: input.repositoryId,
    trigger_count: toEmbed.length,
  })

  if (toEmbed.length === 0) return

  const rows: Array<{
    repository_id: string
    entity_id: string
    embedding: number[]
    semantic_summary: string
  }> = []

  for (let i = 0; i < toEmbed.length; i += EMBEDDING_BATCH_SIZE) {
    const chunk = toEmbed.slice(i, i + EMBEDDING_BATCH_SIZE)
    const inputs = chunk.map((entity) => buildEmbeddingInput(entity))
    const vectors = await generateEmbeddingsBatchOrThrow(inputs)
    for (let idx = 0; idx < chunk.length; idx += 1) {
      rows.push({
        repository_id: input.repositoryId,
        entity_id: chunk[idx].id,
        embedding: vectors[idx],
        semantic_summary: inputs[idx],
      })
    }
  }

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100)
    const { error } = await supabase
      .from('embeddings')
      .upsert(batch, { onConflict: 'repository_id,entity_id' })
    if (error) throw new Error(`lazy_embedding_upsert_failed: ${error.message}`)
  }

  console.log('[FUBUKI LAZY EMBEDDING COMPLETE]:', {
    repository_id: input.repositoryId,
    embedded_entity_ids: rows.slice(0, 20).map((r) => r.entity_id),
    embedded_count: rows.length,
  })
}

function buildDeterministicAnswer(input: {
  question: string
  entities: EntityRow[]
  relationships: GraphRow[]
}) {
  const q = input.question.toLowerCase()
  const likelyCart = input.entities.filter((e) => {
    const text = `${e.entity_name} ${e.file_path} ${e.entity_type}`.toLowerCase()
    return text.includes('cart') || text.includes('checkout') || text.includes('basket')
  })
  const focus = likelyCart.length > 0 ? likelyCart : input.entities.slice(0, 12)
  const names = focus.slice(0, 8).map((e) => `${e.entity_type}:${e.entity_name}`)
  const relCount = input.relationships.length

  if (focus.length === 0) {
    return 'I could not find structural entities related to this question yet. Re-run ingestion to build structure index.'
  }

  const leading =
    q.includes('cart')
      ? 'From the indexed repository structure, cart-related flow appears to involve these entities:'
      : 'From the indexed repository structure, relevant flow appears to involve these entities:'

  return `${leading} ${names.join(', ')}. I found ${relCount} structural relationships connecting nearby modules. This is structure-derived guidance (non-hallucinated) and may be incomplete until more lazy embeddings are built through usage.`
}

async function sukunaAnalyze(input: {
  objective: string
  keywords: string[]
  entities: EntityRow[]
  relationships: GraphRow[]
}): Promise<SukunaOutput> {
  const entityContext = input.entities.slice(0, 50).map((entity) => ({
    id: entity.id,
    name: entity.entity_name,
    type: entity.entity_type,
    path: entity.file_path,
    snippet: pickSnippet(entity.metadata),
  }))

  const relationshipContext = input.relationships.slice(0, 120)

  const fallback: SukunaOutput = {
    findings: [],
    unknowns: ['insufficient context'],
    constraints: ['insufficient structural evidence'],
  }

  return runOpenAIJson<SukunaOutput>(
    AGENT_PROMPTS.SUKUNA,
    JSON.stringify({
      objective: input.objective,
      keywords: input.keywords,
      structural_entities: entityContext,
      graph_relationships: relationshipContext,
    }),
    fallback
  )
}

async function hakariValidate(sukuna: SukunaOutput): Promise<HakariOutput> {
  const heuristic: HakariOutput =
    sukuna.findings.length === 0 || sukuna.unknowns.length > 0
      ? { status: 'needs_correction', issues: ['Findings are incomplete or uncertain'] }
      : { status: 'passed', issues: [] }

  return runOpenAIJson<HakariOutput>(
    AGENT_PROMPTS.HAKARI,
    JSON.stringify(sukuna),
    heuristic
  )
}

async function yujiTranslate(input: {
  objective: string
  answerStyle: string
  sukuna: SukunaOutput
  hakari: HakariOutput
}) {
  if (input.sukuna.unknowns.length > 0) {
    return 'I cannot confidently describe product behavior from available structural context yet. Ask a narrower question or continue interacting to improve coverage.'
  }

  const fallback = 'Based on available context, this appears partially understood. Please validate against repository documentation.'
  return runOpenAIText(
    AGENT_PROMPTS.YUJI,
    JSON.stringify({
      objective: input.objective,
      answer_style: input.answerStyle,
      findings: input.sukuna.findings,
      constraints: input.sukuna.constraints,
      validation_status: input.hakari.status,
      validation_issues: input.hakari.issues,
    }),
    fallback
  )
}

export async function POST(request: NextRequest) {
  let requestRepositoryIdForLogs = 'unknown'
  try {
    const body = await request.json()
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    const repositoryId = typeof body?.repositoryId === 'string' ? body.repositoryId.trim() : ''
    requestRepositoryIdForLogs = repositoryId || 'unknown'

    if (!question) {
      return NextResponse.json({ answer: 'Question is required', debug: { gojo: {}, fubuki: {}, sukuna: {}, hakari: {} } }, { status: 400 })
    }
    if (!repositoryId) {
      return NextResponse.json({ answer: 'repositoryId is required', debug: { gojo: {}, fubuki: {}, sukuna: {}, hakari: {} } }, { status: 400 })
    }

    const authHeader = request.headers.get('authorization')
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!accessToken) {
      return NextResponse.json({ answer: 'Unauthorized', debug: { gojo: {}, fubuki: {}, sukuna: {}, hakari: {} } }, { status: 401 })
    }

    const authUser = await getUserFromBearerToken(accessToken)
    if (!authUser) {
      return NextResponse.json({ answer: 'Unauthorized', debug: { gojo: {}, fubuki: {}, sukuna: {}, hakari: {} } }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: memberships } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', authUser.id)
    const orgIds = (memberships || []).map((m) => m.organization_id)
    if (orgIds.length === 0) {
      return NextResponse.json({ answer: 'No organization access', debug: { gojo: {}, fubuki: {}, sukuna: {}, hakari: {} } }, { status: 403 })
    }

    const { data: repository, error: repositoryError } = await supabase
      .from('repositories')
      .select('id')
      .eq('id', repositoryId)
      .in('organization_id', orgIds)
      .maybeSingle()
    if (repositoryError || !repository) {
      return NextResponse.json({ answer: 'Repository not accessible', debug: { gojo: {}, fubuki: {}, sukuna: {}, hakari: {} } }, { status: 403 })
    }

    const gojo = await gojoIntent(question)
    logAgentIO('GOJO', 'INPUT', { question })
    logAgentIO('GOJO', 'OUTPUT', {
      intent: gojo.intent,
      objective: gojo.objective,
      keywords: gojo.keywords,
      answer_style: gojo.answer_style,
    })
    logAgentEvent({
      repositoryId,
      agentName: 'GOJO',
      step: 'intent_analysis',
      status: 'success',
      inputSummary: { question_len: question.length },
      outputSummary: { keywords_count: gojo.keywords.length, objective: gojo.objective },
    })

    const expandedKeywords = await fubukiExpandKeywords(question, gojo.keywords)
    logAgentIO('FUBUKI', 'INPUT', { question, base_keywords: gojo.keywords })
    logAgentIO('FUBUKI', 'OUTPUT', { expanded_keywords: expandedKeywords })
    logAgentEvent({
      repositoryId,
      agentName: 'FUBUKI',
      step: 'query_expansion',
      status: 'success',
      inputSummary: { base_keywords_count: gojo.keywords.length },
      outputSummary: { expanded_keywords_count: expandedKeywords.length },
    })

    const retrievalKeywords = Array.from(new Set([...gojo.keywords, ...expandedKeywords])).slice(0, 16)
    logAgentIO('YUTA', 'INPUT', { retrieval_keywords: retrievalKeywords })

    logAgentEvent({
      repositoryId,
      agentName: 'YUTA',
      step: 'structural_retrieval',
      status: 'started',
      inputSummary: { retrieval_keywords_count: retrievalKeywords.length },
      outputSummary: {},
    })

    const seedEntitiesRaw = await retrieveStructuralCandidates(repositoryId, retrievalKeywords)
    const seedEntities = await rerankWithEmbeddings(repositoryId, seedEntitiesRaw, question)
    const { entities: expandedEntities, relationships } = await expandGraphContext(repositoryId, seedEntities)
    logAgentIO('YUTA', 'OUTPUT', {
      seed_entities: seedEntities.length,
      expanded_entities: expandedEntities.length,
      relationships: relationships.length,
      sample_entity_ids: expandedEntities.slice(0, 5).map((e) => e.id),
    })
    logAgentEvent({
      repositoryId,
      agentName: 'YUTA',
      step: 'structural_retrieval',
      status: 'success',
      inputSummary: { retrieval_keywords_count: retrievalKeywords.length },
      outputSummary: { seed_entities: seedEntities.length, expanded_entities: expandedEntities.length, relationships: relationships.length },
    })

    if (expandedEntities.length === 0) {
      return NextResponse.json({
        answer: 'Unable to analyze repository because structure index is empty. Re-run ingestion first.',
        debug: {
          gojo,
          fubuki: { expanded_keywords: expandedKeywords, retrieval_keywords: retrievalKeywords },
          sukuna: { findings: [], unknowns: ['insufficient context'], constraints: ['no structured entities found'] },
          hakari: { status: 'needs_correction', issues: ['structure index empty'] },
        },
      })
    }

    const candidateEntities = expandedEntities.slice(0, 80)
    const candidateIds = candidateEntities.map((e) => e.id)
    const { data: existingEmbeddings } = await supabase
      .from('embeddings')
      .select('entity_id')
      .eq('repository_id', repositoryId)
      .in('entity_id', candidateIds)
    const embeddedIds = new Set((existingEmbeddings || []).map((x) => x.entity_id))
    const missingEntities = candidateEntities.filter((e) => !embeddedIds.has(e.id))

    console.log('[FUBUKI EMBEDDING REUSE]:', {
      repository_id: repositoryId,
      reuse_count: embeddedIds.size,
      missing_count: missingEntities.length,
    })

    // Non-blocking lazy embedding trigger.
    void triggerLazyEmbeddingsInBackground({
      repositoryId,
      missingEntities,
    }).catch((error) => {
      console.warn('[FUBUKI LAZY EMBEDDING FAILED]:', {
        repository_id: repositoryId,
        error: error instanceof Error ? error.message : String(error),
      })
    })

    const sukuna = await sukunaAnalyze({
      objective: gojo.objective,
      keywords: retrievalKeywords,
      entities: candidateEntities,
      relationships,
    })
    logAgentIO('SUKUNA', 'INPUT', {
      objective: gojo.objective,
      keywords: retrievalKeywords,
      entity_context_count: candidateEntities.length,
      relationship_count: relationships.length,
    })
    logAgentIO('SUKUNA', 'OUTPUT', {
      findings: sukuna.findings,
      unknowns: sukuna.unknowns,
      constraints: sukuna.constraints,
    })
    logAgentEvent({
      repositoryId,
      agentName: 'SUKUNA',
      step: 'reasoning',
      status: 'success',
      inputSummary: { entity_context_count: candidateEntities.length, relationship_count: relationships.length },
      outputSummary: { findings_count: sukuna.findings.length, unknowns_count: sukuna.unknowns.length },
    })

    const hakari = await hakariValidate(sukuna)
    logAgentIO('HAKARI', 'INPUT', {
      findings: sukuna.findings,
      unknowns: sukuna.unknowns,
      constraints: sukuna.constraints,
    })
    logAgentIO('HAKARI', 'OUTPUT', {
      status: hakari.status,
      issues: hakari.issues,
    })
    logAgentEvent({
      repositoryId,
      agentName: 'HAKARI',
      step: 'validation',
      status: 'success',
      inputSummary: { findings_count: sukuna.findings.length, unknowns_count: sukuna.unknowns.length },
      outputSummary: { status: hakari.status, issues_count: hakari.issues.length },
    })

    let answer = ''
    if (hakari.status === 'needs_correction' || sukuna.unknowns.length > 0) {
      logAgentEvent({
        repositoryId,
        agentName: 'YUJI',
        step: 'translation',
        status: 'skipped',
        inputSummary: { reason: 'hallucination_guardrail', unknowns_count: sukuna.unknowns.length },
        outputSummary: {},
      })
      answer = buildDeterministicAnswer({
        question,
        entities: candidateEntities,
        relationships,
      })
      logAgentIO('YUJI', 'OUTPUT', {
        mode: 'deterministic_fallback',
        answer_preview: compactText(answer, 180),
      })
    } else {
      logAgentIO('YUJI', 'INPUT', {
        objective: gojo.objective,
        answer_style: gojo.answer_style,
        findings_count: sukuna.findings.length,
      })
      answer = await yujiTranslate({
        objective: gojo.objective,
        answerStyle: gojo.answer_style,
        sukuna,
        hakari,
      })
      logAgentIO('YUJI', 'OUTPUT', {
        mode: 'llm_translation',
        answer_preview: compactText(answer, 180),
      })
      logAgentEvent({
        repositoryId,
        agentName: 'YUJI',
        step: 'translation',
        status: 'success',
        inputSummary: { findings_count: sukuna.findings.length },
        outputSummary: { answer_len: answer.length },
      })
    }

    return NextResponse.json({
      answer,
      debug: {
        gojo,
        fubuki: {
          expanded_keywords: expandedKeywords,
          retrieval_keywords: retrievalKeywords,
          embedding_reuse_count: embeddedIds.size,
          embedding_trigger_count: missingEntities.length,
        },
        sukuna,
        hakari,
      },
    })
  } catch (error) {
    logAgentEvent({
      repositoryId: requestRepositoryIdForLogs,
      agentName: 'YUTA',
      step: 'pipeline',
      status: 'failed',
      inputSummary: {},
      outputSummary: {},
      errorMessage: error instanceof Error ? error.message : 'pipeline_error',
    })
    console.error('[ASK PIPELINE ERROR]:', error)
    return NextResponse.json(
      {
        answer: 'Unable to answer right now. Please try again.',
        debug: {
          gojo: {},
          fubuki: {},
          sukuna: { findings: [], unknowns: ['insufficient context'], constraints: ['pipeline error'] },
          hakari: { status: 'needs_correction', issues: ['pipeline failure'] },
        },
      },
      { status: 500 }
    )
  }
}
*/
