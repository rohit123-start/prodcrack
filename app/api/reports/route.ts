import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { runOpenAIJson } from '@/lib/llm/openai'

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

type StakeholderSection = {
  summary: string
  metrics: Record<string, number>
  report: string[]
}

type StakeholderReports = {
  cto: StakeholderSection
  pm: StakeholderSection
  operations: StakeholderSection
}

type ReportEvidence = {
  total_entities: number
  total_relationships: number
  api_endpoints: number
  write_operations: number
  read_operations: number
  api_related_modules: number
  external_integrations: number
  top_flow_domains: Array<{ name: string; count: number }>
  method_distribution: Record<string, number>
  capability_signals: {
    auth_related_flows: number
    booking_related_flows: number
    payment_related_flows: number
  }
}

type StakeholderNarrative = {
  summary: string
  report: string[]
}

type RefinedNarratives = {
  cto: StakeholderNarrative
  pm: StakeholderNarrative
  operations: StakeholderNarrative
}

type ApiCatalogItem = {
  api_id: string
  route_name: string
  method: string
  path: string
  flow_domain: string
  relationship_count: number
  relationship_types: Record<string, number>
  linked_entities: Array<{ entity_name: string; entity_type: string }>
  signals: string[]
}

const REPORT_GENERATOR_PROMPT = `
You are a product intelligence report generator for backend API flow data.

Your job:
- Generate report wording for three audiences: CTO, PM, Operations.
- Read all API inputs in api_catalog and reason across them.
- Use ONLY evidence provided in the prompt.
- Keep numbers aligned with provided metrics/evidence.
- Understand the apis and explain what it does in flow and how it fits into the product.
- Review the api and understand it and then only write the report if want the understanding of you also 
so explain each api one by one with tasks

Hard guardrails:
- Do NOT invent metrics or capabilities.
- Do NOT mention file paths, classes, functions, imports, or code snippets.
- Explain API behavior in business/product/operational language.
- If evidence is weak, explicitly say it is not strongly indicated yet.

Report writing rules:
- Write every sentence from scratch (do not copy input wording).
- Keep each summary to 1-2 sentences.
- Keep each report array to 3-5 clear bullets.
- In case of explaining API explain each api one by one with tasks it perforeming

Return JSON only:
{
  "cto": { "summary": "string", "report": ["string"] },
  "pm": { "summary": "string", "report": ["string"] },
  "operations": { "summary": "string", "report": ["string"] }
}
`.trim()

function containsAny(text: string, keywords: string[]) {
  const lower = text.toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword))
}

function topCounts(values: string[], limit: number) {
  const freq = new Map<string, number>()
  for (const value of values) {
    freq.set(value, (freq.get(value) || 0) + 1)
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
}

function countByMethod(routes: Array<{ method: string; path: string }>) {
  const counts: Record<string, number> = {}
  for (const route of routes) {
    counts[route.method] = (counts[route.method] || 0) + 1
  }
  return counts
}

function extractRoutePath(entity: EntityRow) {
  const routePathFromMeta =
    entity.metadata && typeof entity.metadata.route_path === 'string'
      ? entity.metadata.route_path
      : null
  if (routePathFromMeta) return routePathFromMeta.startsWith('/') ? routePathFromMeta : `/${routePathFromMeta}`

  const parts = entity.entity_name.split(' ')
  if (parts.length > 1) {
    const path = parts.slice(1).join(' ').trim()
    return path.startsWith('/') ? path : `/${path}`
  }
  return '/'
}

function extractRouteMethod(entity: EntityRow) {
  const methodFromMeta =
    entity.metadata && typeof entity.metadata.method === 'string'
      ? entity.metadata.method.toUpperCase()
      : null
  if (methodFromMeta) return methodFromMeta

  const first = entity.entity_name.split(' ')[0]?.toUpperCase() || 'GET'
  const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
  return allowed.has(first) ? first : 'GET'
}

function flowNameFromPath(routePath: string) {
  const segments = routePath.split('/').filter(Boolean)
  return segments[0] || 'root'
}

function safeStringArray(value: unknown, limit = 8) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit)
}

function extractSignals(entity: EntityRow) {
  const tags = safeStringArray(entity.metadata?.tags, 8)
  const keywords = safeStringArray(entity.metadata?.keywords, 8)
  const hints = safeStringArray(entity.metadata?.hints, 6)

  const title =
    entity.metadata && typeof entity.metadata.title === 'string'
      ? entity.metadata.title.trim()
      : ''
  const description =
    entity.metadata && typeof entity.metadata.description === 'string'
      ? entity.metadata.description.trim()
      : ''

  return Array.from(
    new Set(
      [...tags, ...keywords, ...hints, title, description]
        .map((item) => item.toLowerCase())
        .filter((item) => item.length >= 3)
        .slice(0, 14)
    )
  )
}

function buildReportEvidence(entities: EntityRow[], graph: GraphRow[]): ReportEvidence {
  const apiEntities = entities.filter((entity) => entity.entity_type === 'api')
  const moduleEntities = entities.filter((entity) => entity.entity_type === 'module')
  const dependencyEntities = entities.filter((entity) => entity.entity_type === 'dependency')

  const routes = apiEntities.map((entity) => ({
    method: extractRouteMethod(entity),
    path: extractRoutePath(entity),
  }))
  const flowNames = routes.map((route) => flowNameFromPath(route.path))
  const topFlows = topCounts(flowNames, 6)

  const writeOps = routes.filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)).length
  const readOps = Math.max(0, routes.length - writeOps)
  const authFlows = flowNames.filter((name) => containsAny(name, ['auth', 'login', 'session', 'token'])).length
  const bookingFlows = flowNames.filter((name) => containsAny(name, ['booking', 'reservation', 'slot'])).length
  const paymentFlows = flowNames.filter((name) => containsAny(name, ['payment', 'billing', 'invoice', 'checkout'])).length

  const serviceModules = moduleEntities.filter((entity) =>
    containsAny(entity.file_path, ['service', 'controller', 'route', 'api'])
  ).length
  const externalDeps = dependencyEntities
    .map((entity) => entity.entity_name)
    .filter((name) => !name.startsWith('.'))
  const uniqueExternalDeps = Array.from(new Set(externalDeps))

  return {
    total_entities: entities.length,
    total_relationships: graph.length,
    api_endpoints: apiEntities.length,
    write_operations: writeOps,
    read_operations: readOps,
    api_related_modules: serviceModules,
    external_integrations: uniqueExternalDeps.length,
    top_flow_domains: topFlows.map(([name, count]) => ({ name, count })),
    method_distribution: countByMethod(routes),
    capability_signals: {
      auth_related_flows: authFlows,
      booking_related_flows: bookingFlows,
      payment_related_flows: paymentFlows,
    },
  }
}

function buildStakeholderReportsFromEvidence(evidence: ReportEvidence): StakeholderReports {
  const topFlows = evidence.top_flow_domains
  const topFlowNames = topFlows.map((flow) => flow.name)

  const cto: StakeholderSection = {
    summary: `API-flow ingestion found ${evidence.api_endpoints} backend endpoints with ${evidence.total_relationships} graph relationships.`,
    metrics: {
      api_endpoints: evidence.api_endpoints,
      api_related_modules: evidence.api_related_modules,
      graph_relationships: evidence.total_relationships,
      external_integrations: evidence.external_integrations,
    },
    report: [
      `Dominant API domains: ${topFlowNames.slice(0, 4).join(', ') || 'none detected'}.`,
      `${evidence.write_operations} state-mutating endpoints detected (POST/PUT/PATCH/DELETE).`,
      `${evidence.external_integrations} external integration touchpoints appear in API flow dependencies.`,
    ],
  }

  const pm: StakeholderSection = {
    summary: `Product behavior from API flows is grouped into key user/business domains for roadmap visibility.`,
    metrics: {
      api_endpoints: evidence.api_endpoints,
      dominant_flows: topFlows.length,
      auth_related_flows: evidence.capability_signals.auth_related_flows,
      booking_related_flows: evidence.capability_signals.booking_related_flows,
      payment_related_flows: evidence.capability_signals.payment_related_flows,
    },
    report: [
      `Top flow groups: ${topFlows.map((flow) => `${flow.name} (${flow.count})`).join(', ') || 'none detected'}.`,
      evidence.capability_signals.auth_related_flows > 0
        ? 'Authentication/session flows are present in backend APIs.'
        : 'Authentication/session flows were not strongly detected.',
      evidence.capability_signals.booking_related_flows > 0
        ? 'Booking/reservation flows are present in backend APIs.'
        : 'Booking/reservation flows were not strongly detected.',
      evidence.capability_signals.payment_related_flows > 0
        ? 'Payment/billing flows are present in backend APIs.'
        : 'Payment/billing flows were not strongly detected.',
    ],
  }

  const operations: StakeholderSection = {
    summary: 'Operations view focuses on reliability-sensitive API paths and run-time hotspots.',
    metrics: {
      write_operations: evidence.write_operations,
      read_operations: evidence.read_operations,
      monitored_flow_domains: topFlows.length,
      integration_touchpoints: evidence.external_integrations,
    },
    report: [
      `${evidence.write_operations} write endpoints should have strict monitoring, retries, and idempotency controls.`,
      `Monitor highest traffic/critical domains first: ${topFlowNames.slice(0, 5).join(', ') || 'none detected'}.`,
      `${evidence.external_integrations} integration points require timeout/fallback and alerting coverage.`,
    ],
  }

  return { cto, pm, operations }
}

function buildApiCatalogForLlm(entities: EntityRow[], graph: GraphRow[]): ApiCatalogItem[] {
  const entityById = new Map<string, EntityRow>()
  for (const entity of entities) {
    entityById.set(entity.id, entity)
  }

  const apiEntities = entities.filter((entity) => entity.entity_type === 'api')
  const graphByEntity = new Map<string, GraphRow[]>()
  for (const edge of graph) {
    if (!graphByEntity.has(edge.source_entity_id)) graphByEntity.set(edge.source_entity_id, [])
    if (!graphByEntity.has(edge.target_entity_id)) graphByEntity.set(edge.target_entity_id, [])
    graphByEntity.get(edge.source_entity_id)?.push(edge)
    graphByEntity.get(edge.target_entity_id)?.push(edge)
  }

  return apiEntities.map((apiEntity) => {
    const method = extractRouteMethod(apiEntity)
    const path = extractRoutePath(apiEntity)
    const flowDomain = flowNameFromPath(path)
    const relatedEdges = graphByEntity.get(apiEntity.id) || []

    const relationshipTypes: Record<string, number> = {}
    const linkedEntityIds = new Set<string>()
    for (const edge of relatedEdges) {
      relationshipTypes[edge.relationship_type] = (relationshipTypes[edge.relationship_type] || 0) + 1
      const linkedId = edge.source_entity_id === apiEntity.id ? edge.target_entity_id : edge.source_entity_id
      if (linkedId !== apiEntity.id) linkedEntityIds.add(linkedId)
    }

    const linkedEntities = Array.from(linkedEntityIds)
      .map((id) => entityById.get(id))
      .filter((entity): entity is EntityRow => Boolean(entity))
      .map((entity) => ({
        entity_name: entity.entity_name,
        entity_type: entity.entity_type,
      }))

    return {
      api_id: apiEntity.id,
      route_name: apiEntity.entity_name,
      method,
      path,
      flow_domain: flowDomain,
      relationship_count: relatedEdges.length,
      relationship_types: relationshipTypes,
      linked_entities: linkedEntities,
      signals: extractSignals(apiEntity),
    }
  })
}

function buildReportPromptPayload(
  evidence: ReportEvidence,
  baseReports: StakeholderReports,
  apiCatalog: ApiCatalogItem[]
) {
  const minimalCatalog = apiCatalog.map((api) => ({
    api_id: api.api_id,
    route_name: api.route_name,
    method: api.method,
    path: api.path,
    flow_domain: api.flow_domain,
    relationship_count: api.relationship_count,
    relationship_types: api.relationship_types,
    linked_entities: api.linked_entities,
    signals: api.signals,
  }))

  const compactCatalog = apiCatalog.map((api) => ({
    api_id: api.api_id,
    method: api.method,
    path: api.path,
    flow_domain: api.flow_domain,
    relationship_count: api.relationship_count,
    relationship_types: api.relationship_types,
    linked_entities: api.linked_entities.slice(0, 8),
    signals: api.signals.slice(0, 6),
  }))

  const highlyCompactCatalog = apiCatalog.map((api) => ({
    api_id: api.api_id,
    method: api.method,
    path: api.path,
    flow_domain: api.flow_domain,
    relationship_count: api.relationship_count,
    relationship_types: api.relationship_types,
    signals: api.signals.slice(0, 4),
  }))

  const basePayload = {
    task: 'Generate stakeholder reports using all API records from api_catalog.',
    evidence,
    required_metrics: {
      cto: baseReports.cto.metrics,
      pm: baseReports.pm.metrics,
      operations: baseReports.operations.metrics,
    },
    output_requirements: {
      sections: ['cto', 'pm', 'operations'],
      bullets_per_section: '3-5',
      no_code_level_details: true,
      strictly_grounded: true,
    },
  }

  let payload: Record<string, unknown> = {
    ...basePayload,
    api_catalog: minimalCatalog,
  }
  let payloadString = JSON.stringify(payload)
  if (payloadString.length <= 150000) {
    return JSON.stringify(payload, null, 2)
  }

  payload = {
    ...basePayload,
    api_catalog: compactCatalog,
  }
  payloadString = JSON.stringify(payload)
  if (payloadString.length <= 150000) {
    return JSON.stringify(payload, null, 2)
  }

  payload = {
    ...basePayload,
    api_catalog: highlyCompactCatalog,
  }
  return JSON.stringify(payload, null, 2)
}

function fallbackNarratives(baseReports: StakeholderReports): RefinedNarratives {
  return {
    cto: {
      summary: baseReports.cto.summary,
      report: baseReports.cto.report,
    },
    pm: {
      summary: baseReports.pm.summary,
      report: baseReports.pm.report,
    },
    operations: {
      summary: baseReports.operations.summary,
      report: baseReports.operations.report,
    },
  }
}

function isNarrativeSection(section: unknown): section is StakeholderNarrative {
  if (!section || typeof section !== 'object') return false
  const maybe = section as Record<string, unknown>
  if (typeof maybe.summary !== 'string') return false
  if (!Array.isArray(maybe.report)) return false
  return maybe.report.every((line) => typeof line === 'string')
}

function passthroughNarrativesWithMetrics(
  baseReports: StakeholderReports,
  refinedNarratives: RefinedNarratives
): StakeholderReports {
  const fallback = fallbackNarratives(baseReports)
  const cto = isNarrativeSection(refinedNarratives.cto) ? refinedNarratives.cto : fallback.cto
  const pm = isNarrativeSection(refinedNarratives.pm) ? refinedNarratives.pm : fallback.pm
  const operations = isNarrativeSection(refinedNarratives.operations)
    ? refinedNarratives.operations
    : fallback.operations

  return {
    cto: {
      summary: cto.summary,
      metrics: baseReports.cto.metrics,
      report: cto.report,
    },
    pm: {
      summary: pm.summary,
      metrics: baseReports.pm.metrics,
      report: pm.report,
    },
    operations: {
      summary: operations.summary,
      metrics: baseReports.operations.metrics,
      report: operations.report,
    },
  }
}

async function refineReportsWithLlm(
  baseReports: StakeholderReports,
  evidence: ReportEvidence,
  apiCatalog: ApiCatalogItem[]
): Promise<StakeholderReports> {
  const fallback = fallbackNarratives(baseReports)
  const userPrompt = buildReportPromptPayload(evidence, baseReports, apiCatalog)

  const refinedNarratives = await runOpenAIJson<RefinedNarratives>(
    REPORT_GENERATOR_PROMPT,
    userPrompt,
    fallback
  )

  return passthroughNarrativesWithMetrics(baseReports, refinedNarratives)
}

async function fetchEntities(repositoryId: string) {
  const supabase = getSupabaseAdmin()
  const pageSize = 1000
  const maxRows = 12000
  const rows: EntityRow[] = []
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await supabase
      .from('repository_entities')
      .select('id,entity_name,entity_type,file_path,metadata')
      .eq('repository_id', repositoryId)
      .range(offset, offset + pageSize - 1)
    if (error) throw new Error(`Failed to read repository_entities: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...(data as EntityRow[]))
    if (data.length < pageSize) break
  }
  return rows
}

async function fetchGraph(repositoryId: string) {
  const supabase = getSupabaseAdmin()
  const pageSize = 1000
  const maxRows = 12000
  const rows: GraphRow[] = []
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await supabase
      .from('code_graph')
      .select('source_entity_id,target_entity_id,relationship_type')
      .eq('repository_id', repositoryId)
      .range(offset, offset + pageSize - 1)
    if (error) throw new Error(`Failed to read code_graph: ${error.message}`)
    if (!data || data.length === 0) break
    rows.push(...(data as GraphRow[]))
    if (data.length < pageSize) break
  }
  return rows
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const repositoryId = typeof body?.repositoryId === 'string' ? body.repositoryId.trim() : ''

    if (!repositoryId) {
      return NextResponse.json({ success: false, message: 'repositoryId is required' }, { status: 400 })
    }

    const authHeader = request.headers.get('authorization')
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!accessToken) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const authUser = await getUserFromBearerToken(accessToken)
    if (!authUser) {
      return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: memberships } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', authUser.id)
    const orgIds = (memberships || []).map((m) => m.organization_id)
    if (orgIds.length === 0) {
      return NextResponse.json({ success: false, message: 'No organization access' }, { status: 403 })
    }

    const { data: repository } = await supabase
      .from('repositories')
      .select('id,is_ingested,status')
      .eq('id', repositoryId)
      .in('organization_id', orgIds)
      .maybeSingle()
    if (!repository) {
      return NextResponse.json({ success: false, message: 'Repository not accessible' }, { status: 403 })
    }
    if (!repository.is_ingested) {
      return NextResponse.json(
        { success: false, message: 'Repository is not ingested yet. Run ingestion first.' },
        { status: 400 }
      )
    }

    const [entities, graph] = await Promise.all([
      fetchEntities(repositoryId),
      fetchGraph(repositoryId),
    ])

    const evidence = buildReportEvidence(entities, graph)
    const baseReports = buildStakeholderReportsFromEvidence(evidence)
    const apiCatalog = buildApiCatalogForLlm(entities, graph)
    const reports = await refineReportsWithLlm(baseReports, evidence, apiCatalog)

    return NextResponse.json({
      success: true,
      reports,
      meta: {
        repository_id: repositoryId,
        entities_indexed: entities.length,
        graph_relationships: graph.length,
        api_inputs_provided: apiCatalog.length,
        llm_refinement_attempted: true,
        llm_response_passthrough: true,
      },
    })
  } catch (error) {
    console.error('Report generation error:', error)
    return NextResponse.json(
      { success: false, message: 'Failed to generate reports' },
      { status: 500 }
    )
  }
}
