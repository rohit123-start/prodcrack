import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import ts from 'typescript'
import { getSupabaseAdmin } from '@/lib/server/supabase-admin'
import { IngestionLogger } from '@/lib/agents/ingestion-logger'

const execFileAsync = promisify(execFile)
const MAX_FILE_SIZE = 120_000
const BATCH_SIZE = 100

const EXCLUDED_PATH_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)(dist|build|out|coverage|.next)(\/|$)/,
  /(^|\/)(vendor|tmp|temp)(\/|$)/,
]

const EXCLUDED_FILE_PATTERNS = [
  /\.env(\..+)?$/i,
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tar|gz|jar|exe|dll|so|dylib|map|lock)$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
]

type FrameworkDetection = {
  primaryLanguage: string
  framework: string
  evidence: string[]
}

type AstRoute = {
  method: string
  path: string
  functionName?: string
}

type AstFileAnalysis = {
  path: string
  imports: string[]
  functions: string[]
  classes: string[]
  routes: AstRoute[]
  parseError?: string
  snippet: string
}

type RepositoryEntityRow = {
  id: string
  repository_id: string
  entity_name: string
  entity_type: string
  file_path: string
  content: string | null
  metadata: Record<string, unknown>
}

type CodeGraphRow = {
  repository_id: string
  source_entity_id: string
  target_entity_id: string
  relationship_type: string
  metadata: Record<string, unknown>
}

type GenosResult = {
  repository_id: string
  detected_framework: string
  entities_extracted_count: number
  graph_nodes_count: number
  embeddings_created_count: number
  ingestion_status: 'structure_indexed' | 'failed'
  reports: StakeholderReports
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

function sanitizeRepoUrl(url: string) {
  return url.trim()
}

function deriveRepositoryIdFromUrl(repositoryUrl: string) {
  const normalized = sanitizeRepoUrl(repositoryUrl).toLowerCase().replace(/\.git$/, '')
  const hex = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`
}

function makeDeterministicId(...parts: string[]) {
  const hex = crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`
}

function makeEntityId(repositoryId: string, entityName: string, filePath: string) {
  return makeDeterministicId(repositoryId, entityName, filePath)
}

function cleanSnippet(value: string, maxLen = 220) {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen)
}

function toKeywordSet(values: string[]) {
  const set = new Set<string>()
  for (const value of values) {
    for (const token of value.toLowerCase().split(/[^a-z0-9_]+/)) {
      if (token.length > 2) set.add(token)
    }
  }
  return Array.from(set).slice(0, 20)
}

function containsAny(text: string, keywords: string[]) {
  const lower = text.toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword))
}

function isBackendApiPath(pathValue: string) {
  const lower = pathValue.toLowerCase()

  // Hard excludes — never treat frontend/asset paths as backend API.
  const excludeHints = [
    '/components/',
    '/views/',
    '/screens/',
    '/styles/',
    '/assets/',
    '/public/',
    '/frontend/',
    '/client/',
  ]
  if (excludeHints.some((hint) => lower.includes(hint))) return false

  // Repos often have a root-level `api/`, `server/`, or `backend/` folder whose
  // relative paths start WITHOUT a leading slash (e.g. "api/utils/error.js").
  // Check for these root-folder prefixes explicitly before the slash-prefixed hints.
  const rootBackendFolders = ['api/', 'server/', 'backend/']
  if (rootBackendFolders.some((prefix) => lower.startsWith(prefix))) return true

  // Standard slash-prefixed path hints for nested directories.
  const includeHints = [
    '/api/',
    '/routes/',
    '/route/',
    '/controller/',
    '/controllers/',
    '/model/',
    '/models/',
    '/service/',
    '/services/',
    '/middleware/',
    '/middlewares/',
    '/schema/',
    '/schemas/',
    '/utils/',
    'pages/api/',
    'app/api/',
  ]
  return includeHints.some((hint) => lower.includes(hint))
}

function hasServerImport(imports: string[]) {
  const serverDeps = [
    'express',
    'koa',
    'fastify',
    'hapi',
    '@nestjs',
    'next/server',
    'next/headers',
    'mongoose',
    'sequelize',
    'typeorm',
    'prisma',
    'knex',
    'jsonwebtoken',
    'bcrypt',
    'bcryptjs',
    'passport',
    'cookie-parser',
    'cors',
    'helmet',
    'dotenv',
    'body-parser',
  ]
  return imports.some((item) => containsAny(item, serverDeps))
}

function isApiFlowAnalysis(analysis: AstFileAnalysis) {
  if (analysis.routes.length > 0) return true
  if (isBackendApiPath(analysis.path)) return true
  if (hasServerImport(analysis.imports)) return true
  return false
}


function extractRouteFromApiEntity(entity: RepositoryEntityRow) {
  if (entity.entity_type !== 'api') return { method: 'GET', path: '/' }
  const method = typeof entity.metadata.method === 'string'
    ? entity.metadata.method.toUpperCase()
    : entity.entity_name.split(' ')[0]?.toUpperCase() || 'GET'
  const routePath = typeof entity.metadata.route_path === 'string'
    ? entity.metadata.route_path
    : entity.entity_name.split(' ').slice(1).join(' ') || '/'
  return { method, path: routePath.startsWith('/') ? routePath : `/${routePath}` }
}

function flowKeyFromPath(routePath: string) {
  const segments = routePath.split('/').filter(Boolean)
  return segments[0] || 'root'
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

function buildStakeholderReports(
  entities: RepositoryEntityRow[],
  graph: CodeGraphRow[],
  framework: FrameworkDetection
): StakeholderReports {
  const apiEntities = entities.filter((entity) => entity.entity_type === 'api')
  const moduleEntities = entities.filter((entity) => entity.entity_type === 'module')
  const dependencyEntities = entities.filter((entity) => entity.entity_type === 'dependency')

  const routes = apiEntities.map((entity) => extractRouteFromApiEntity(entity))
  const routeFlowKeys = routes.map((route) => flowKeyFromPath(route.path))
  const topFlows = topCounts(routeFlowKeys, 6)
  const writeOps = routes.filter((route) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)).length
  const authFlows = routeFlowKeys.filter((flow) => containsAny(flow, ['auth', 'login', 'session', 'token'])).length
  const paymentFlows = routeFlowKeys.filter((flow) => containsAny(flow, ['payment', 'billing', 'checkout', 'invoice'])).length

  const serviceModules = moduleEntities.filter((entity) => containsAny(entity.file_path, ['service', 'controller', 'route'])).length
  const externalDeps = dependencyEntities
    .map((entity) => entity.entity_name)
    .filter((name) => !name.startsWith('.'))
  const uniqueExternalDeps = Array.from(new Set(externalDeps))

  const ctoReport: StakeholderSection = {
    summary: `Backend API flow index created for ${apiEntities.length} endpoints with ${graph.length} relationships across ${framework.framework || 'unknown'} (${framework.primaryLanguage || 'unknown'}).`,
    metrics: {
      api_endpoints: apiEntities.length,
      api_related_modules: serviceModules,
      graph_relationships: graph.length,
      external_integrations: uniqueExternalDeps.length,
    },
    report: [
      `Primary API domains: ${topFlows.slice(0, 4).map(([name]) => name).join(', ') || 'none detected'}.`,
      `${writeOps} state-changing endpoints identified (POST/PUT/PATCH/DELETE).`,
      `${uniqueExternalDeps.length} external dependency touchpoints detected in backend API flow.`,
    ],
  }

  const pmReport: StakeholderSection = {
    summary: `Product-facing backend capabilities were inferred from ${apiEntities.length} API endpoints and grouped into dominant operational flows.`,
    metrics: {
      api_endpoints: apiEntities.length,
      dominant_flows: topFlows.length,
      auth_related_flows: authFlows,
      payment_related_flows: paymentFlows,
    },
    report: [
      `Top user/business flows: ${topFlows.map(([name, count]) => `${name} (${count})`).join(', ') || 'none detected'}.`,
      authFlows > 0
        ? 'Authentication/session lifecycle endpoints are present.'
        : 'Authentication/session lifecycle endpoints were not strongly detected.',
      paymentFlows > 0
        ? 'Payment/billing lifecycle endpoints are present.'
        : 'Payment/billing lifecycle endpoints were not strongly detected.',
    ],
  }

  const opsReport: StakeholderSection = {
    summary: 'Operations report highlights runtime-sensitive API paths and reliability focus areas.',
    metrics: {
      write_operations: writeOps,
      read_operations: Math.max(0, routes.length - writeOps),
      monitored_flows: topFlows.length,
      integration_touchpoints: uniqueExternalDeps.length,
    },
    report: [
      `${writeOps} write-oriented endpoints should be prioritized for retry/idempotency and alerting coverage.`,
      `Top operational domains to monitor: ${topFlows.slice(0, 5).map(([name]) => name).join(', ') || 'none detected'}.`,
      `${uniqueExternalDeps.length} integration touchpoints may require failure handling and timeout policies.`,
    ],
  }

  return {
    cto: ctoReport,
    pm: pmReport,
    operations: opsReport,
  }
}

function isIncludedPath(pathValue: string) {
  const lowerPath = pathValue.toLowerCase()
  if (EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(lowerPath))) return false
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(lowerPath))) return false
  return true
}

function isLikelyBinary(content: string) {
  return content.includes('\u0000')
}

async function cloneRepository(repositoryUrl: string, repositoryId: string) {
  const checkoutDir = path.join(os.tmpdir(), 'genos-ingestion', repositoryId)
  await fs.rm(checkoutDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(checkoutDir), { recursive: true })
  await execFileAsync('git', ['clone', '--depth', '1', repositoryUrl, checkoutDir], {
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return checkoutDir
}

async function readRepositoryFiles(rootDir: string) {
  const result: Array<{ path: string; content: string }> = []
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      const relPath = path.relative(rootDir, absolute).replace(/\\/g, '/')
      if (!isIncludedPath(relPath)) continue
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stats = await fs.stat(absolute)
        if (stats.size === 0 || stats.size > MAX_FILE_SIZE) continue
        const content = await fs.readFile(absolute, 'utf8')
        if (!content || content.length < 2) continue
        if (isLikelyBinary(content)) continue
        result.push({ path: relPath, content })
      } catch {
        // ignore unreadable files
      }
    }
  }
  await walk(rootDir)
  return result
}

function detectFramework(files: Array<{ path: string; content: string }>): FrameworkDetection {
  const paths = files.map((f) => f.path.toLowerCase())
  const evidence: string[] = []

  let framework = 'unknown'
  if (paths.some((p) => p.includes('next.config'))) {
    framework = 'nextjs'
    evidence.push('next.config detected')
  } else if (paths.some((p) => p.endsWith('angular.json'))) {
    framework = 'angular'
    evidence.push('angular.json detected')
  } else if (paths.some((p) => p.endsWith('pom.xml'))) {
    framework = 'spring'
    evidence.push('pom.xml detected')
  } else if (paths.some((p) => p.endsWith('manage.py'))) {
    framework = 'django'
    evidence.push('manage.py detected')
  } else if (paths.some((p) => p.endsWith('go.mod'))) {
    framework = 'go'
    evidence.push('go.mod detected')
  }

  const languageScores: Record<string, number> = { typescript: 0, javascript: 0, python: 0, go: 0, java: 0 }
  for (const file of files) {
    if (file.path.endsWith('.ts') || file.path.endsWith('.tsx')) languageScores.typescript += 1
    else if (file.path.endsWith('.js') || file.path.endsWith('.jsx')) languageScores.javascript += 1
    else if (file.path.endsWith('.py')) languageScores.python += 1
    else if (file.path.endsWith('.go')) languageScores.go += 1
    else if (file.path.endsWith('.java')) languageScores.java += 1
  }

  const primaryLanguage = Object.entries(languageScores).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown'
  if (primaryLanguage !== 'unknown') evidence.push(`primary language score favors ${primaryLanguage}`)
  return { primaryLanguage, framework, evidence }
}

function parseWithAst(filePath: string, content: string): AstFileAnalysis {
  const snippet = cleanSnippet(content)
  if (!/\.(ts|tsx|js|jsx)$/.test(filePath)) {
    return { path: filePath, imports: [], functions: [], classes: [], routes: [], snippet }
  }

  try {
    const kind = filePath.endsWith('.ts') || filePath.endsWith('.tsx')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS
    const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind)

    const imports = new Set<string>()
    const functions = new Set<string>()
    const classes = new Set<string>()
    const routes: AstRoute[] = []

    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.add(node.moduleSpecifier.text)
      }

      if (ts.isFunctionDeclaration(node) && node.name?.text) {
        functions.add(node.name.text)
      }

      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue
          if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
            functions.add(d.name.text)
          }
        }
      }

      if (ts.isClassDeclaration(node) && node.name?.text) {
        classes.add(node.name.text)
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.getText(source).toLowerCase()
        const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'use'])
        if (routeMethods.has(method) && node.arguments.length > 0) {
          const firstArg = node.arguments[0]
          if (ts.isStringLiteralLike(firstArg) && firstArg.text.startsWith('/')) {
            routes.push({
              method,
              path: firstArg.text,
              functionName: ts.isIdentifier(node.expression.expression)
                ? node.expression.expression.text
                : undefined,
            })
          }
        }
      }

      ts.forEachChild(node, walk)
    }

    walk(source)
    return {
      path: filePath,
      imports: Array.from(imports),
      functions: Array.from(functions),
      classes: Array.from(classes),
      routes,
      snippet,
    }
  } catch (error) {
    return {
      path: filePath,
      imports: [],
      functions: [],
      classes: [],
      routes: [],
      parseError: error instanceof Error ? error.message : 'ast_parse_failed',
      snippet,
    }
  }
}

function buildEntities(
  repositoryId: string,
  analyses: AstFileAnalysis[],
  framework: FrameworkDetection,
  fileContentByPath: Map<string, string>
): RepositoryEntityRow[] {
  const entities: RepositoryEntityRow[] = []
  const addEntity = (
    entityName: string,
    entityType: string,
    filePath: string,
    metadata: Record<string, unknown>,
    content: string | null
  ) => {
    const id = makeEntityId(repositoryId, entityName, filePath)
    const tags = toKeywordSet([entityName, entityType, filePath, framework.framework, framework.primaryLanguage])
    entities.push({
      id,
      repository_id: repositoryId,
      entity_name: entityName,
      entity_type: entityType,
      file_path: filePath,
      content,
      metadata: {
        ...metadata,
        tags,
        keywords: tags,
        framework: framework.framework,
        primary_language: framework.primaryLanguage,
      },
    })
  }

  for (const file of analyses) {
    // Every file that reached buildEntities already passed isApiFlowAnalysis —
    // it is confirmed backend API-flow scope, so always store full content on the
    // module entity and on every API route entity from that file.
    const fullFileContent = fileContentByPath.get(file.path) ?? null
    addEntity(file.path, 'module', file.path, { parse_error: file.parseError || null, snippet: file.snippet }, fullFileContent)
    for (const fn of file.functions) addEntity(fn, 'function', file.path, { snippet: file.snippet }, null)
    for (const cls of file.classes) addEntity(cls, 'class', file.path, { snippet: file.snippet }, null)
    for (const route of file.routes) {
      addEntity(`${route.method.toUpperCase()} ${route.path}`, 'api', file.path, {
        method: route.method,
        route_path: route.path,
        snippet: file.snippet,
      }, fullFileContent)
    }
    for (const imp of file.imports) addEntity(imp, 'dependency', file.path, { snippet: file.snippet }, null)
  }

  const deduped = new Map<string, RepositoryEntityRow>()
  for (const entity of entities) {
    const key = `${entity.repository_id}:${entity.entity_name}:${entity.file_path}`
    if (!deduped.has(key)) deduped.set(key, entity)
  }
  return Array.from(deduped.values())
}

function resolveImportedModuleEntityId(
  repositoryId: string,
  fromFilePath: string,
  importPath: string,
  entityIndex: Map<string, RepositoryEntityRow>
) {
  if (!importPath.startsWith('.')) return null
  const baseDir = fromFilePath.split('/').slice(0, -1).join('/')
  const normalized = `${baseDir}/${importPath}`.replace(/\/\.\//g, '/')
  const candidates = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
  ]
  for (const c of candidates) {
    const id = makeEntityId(repositoryId, c, c)
    const entity = entityIndex.get(id)
    if (entity) return entity.id
  }
  return null
}

function buildCodeGraph(
  repositoryId: string,
  analyses: AstFileAnalysis[],
  entities: RepositoryEntityRow[]
): CodeGraphRow[] {
  const graph: CodeGraphRow[] = []
  const entityIndex = new Map<string, RepositoryEntityRow>(entities.map((e) => [e.id, e]))

  for (const file of analyses) {
    const moduleId = makeEntityId(repositoryId, file.path, file.path)
    if (!entityIndex.has(moduleId)) continue

    for (const imp of file.imports) {
      const dependencyId = makeEntityId(repositoryId, imp, file.path)
      if (entityIndex.has(dependencyId)) {
        graph.push({
          repository_id: repositoryId,
          source_entity_id: moduleId,
          target_entity_id: dependencyId,
          relationship_type: 'IMPORTS',
          metadata: {},
        })
      }

      const importedModuleId = resolveImportedModuleEntityId(repositoryId, file.path, imp, entityIndex)
      if (importedModuleId) {
        graph.push({
          repository_id: repositoryId,
          source_entity_id: moduleId,
          target_entity_id: importedModuleId,
          relationship_type: 'USES_MODULE',
          metadata: {},
        })
      }
    }
  }

  const deduped = new Map<string, CodeGraphRow>()
  for (const edge of graph) {
    const key = `${edge.repository_id}:${edge.source_entity_id}:${edge.target_entity_id}:${edge.relationship_type}`
    if (!deduped.has(key)) deduped.set(key, edge)
  }
  return Array.from(deduped.values())
}

async function batchUpsert(
  table: 'repository_entities' | 'code_graph',
  rows: Record<string, unknown>[],
  onConflict: string
) {
  if (rows.length === 0) return
  const supabase = getSupabaseAdmin()
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`${table} upsert failed: ${error.message}`)
  }
}

async function writeCodeGraphRows(rows: CodeGraphRow[]) {
  if (rows.length === 0) return
  const supabase = getSupabaseAdmin()
  try {
    await batchUpsert(
      'code_graph',
      rows,
      'repository_id,source_entity_id,target_entity_id,relationship_type'
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('no unique or exclusion constraint matching the ON CONFLICT specification')) {
      throw error
    }

    const repositoryIds = Array.from(new Set(rows.map((r) => r.repository_id)))
    const { error: deleteError } = await supabase.from('code_graph').delete().in('repository_id', repositoryIds)
    if (deleteError) throw new Error(`code_graph replace(delete) failed: ${deleteError.message}`)

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE)
      const { error: insertError } = await supabase.from('code_graph').insert(chunk)
      if (insertError) throw new Error(`code_graph replace(insert) failed: ${insertError.message}`)
    }
  }
}

export async function runGenosIngestion(input: {
  repositoryUrl: string
  repositoryId?: string
}): Promise<GenosResult> {
  const repositoryUrl = sanitizeRepoUrl(input.repositoryUrl)
  const derivedRepositoryId = deriveRepositoryIdFromUrl(repositoryUrl)
  const storageRepositoryId = input.repositoryId || derivedRepositoryId
  const logger = new IngestionLogger(storageRepositoryId, true)

  await logger.log({
    orchestratorState: 'ingestion_started',
    agentName: 'GENOS',
    step: 'ingestion_started',
    status: 'started',
    inputSummary: {
      repository_url_host: (() => { try { return new URL(repositoryUrl).host } catch { return 'invalid_url' } })(),
      derived_repository_id: derivedRepositoryId,
      storage_repository_id: storageRepositoryId,
    },
    outputSummary: {},
  })

  let clonePath = ''
  try {
    clonePath = await cloneRepository(repositoryUrl, derivedRepositoryId)
    await logger.log({
      orchestratorState: 'repo_cloned_success',
      agentName: 'GENOS',
      step: 'repo_cloned_success',
      status: 'success',
      inputSummary: {},
      outputSummary: { clone_path_suffix: clonePath.slice(-36) },
    })

    await logger.log({
      orchestratorState: 'framework_detected',
      agentName: 'BANG',
      step: 'framework_detection',
      status: 'started',
      inputSummary: {},
      outputSummary: {},
    })

    const files = await readRepositoryFiles(clonePath)
    const framework = detectFramework(files)
    await logger.log({
      orchestratorState: 'framework_detected',
      agentName: 'BANG',
      step: 'framework_detection',
      status: 'success',
      inputSummary: { files_scanned: files.length },
      outputSummary: { framework: framework.framework, primary_language: framework.primaryLanguage },
    })

    await logger.log({
      orchestratorState: 'ast_parsing_started',
      agentName: 'CHILD_EMPEROR',
      step: 'ast_parsing',
      status: 'started',
      inputSummary: { candidate_files: files.length },
      outputSummary: {},
    })
    const analyses = files.map((file) => parseWithAst(file.path, file.content))
    const apiFlowAnalyses = analyses.filter((analysis) => isApiFlowAnalysis(analysis))
    const fileContentByPath = new Map<string, string>(files.map((file) => [file.path, file.content]))
    await logger.log({
      orchestratorState: 'ast_parsing_started',
      agentName: 'CHILD_EMPEROR',
      step: 'ast_parsing',
      status: 'success',
      inputSummary: { files_processed: analyses.length },
      outputSummary: {
        parse_failures: analyses.filter((a) => a.parseError).length,
        api_flow_files: apiFlowAnalyses.length,
      },
    })

    await logger.log({
      orchestratorState: 'entities_extracted',
      agentName: 'DRIVE_KNIGHT',
      step: 'entity_extraction',
      status: 'started',
      inputSummary: { analyses_count: apiFlowAnalyses.length },
      outputSummary: {},
    })
    const entities = buildEntities(storageRepositoryId, apiFlowAnalyses, framework, fileContentByPath)
    await batchUpsert('repository_entities', entities, 'repository_id,entity_name,file_path')
    await logger.log({
      orchestratorState: 'entities_extracted',
      agentName: 'DRIVE_KNIGHT',
      step: 'entity_extraction',
      status: 'success',
      inputSummary: { analyses_count: apiFlowAnalyses.length },
      outputSummary: {
        entities_extracted_count: entities.length,
        entities_with_content: entities.filter((entity) => Boolean(entity.content)).length,
        entities_null_content: entities.filter((entity) => !entity.content).length,
      },
    })

    await logger.log({
      orchestratorState: 'graph_built',
      agentName: 'METAL_KNIGHT',
      step: 'code_graph_build',
      status: 'started',
      inputSummary: { entities_count: entities.length },
      outputSummary: {},
    })
    const graph = buildCodeGraph(storageRepositoryId, apiFlowAnalyses, entities)
    await writeCodeGraphRows(graph)
    await logger.log({
      orchestratorState: 'graph_built',
      agentName: 'METAL_KNIGHT',
      step: 'code_graph_build',
      status: 'success',
      inputSummary: { entities_count: entities.length },
      outputSummary: { graph_relationships_count: graph.length },
    })

    const reports = buildStakeholderReports(entities, graph, framework)
    await logger.log({
      orchestratorState: 'ingestion_completed',
      agentName: 'GENOS',
      step: 'stakeholder_reports_generated',
      status: 'success',
      inputSummary: { api_entities: entities.filter((entity) => entity.entity_type === 'api').length },
      outputSummary: {
        cto_metrics: reports.cto.metrics,
        pm_metrics: reports.pm.metrics,
        operations_metrics: reports.operations.metrics,
      },
    })

    await logger.log({
      orchestratorState: 'embeddings_generated',
      agentName: 'FUBUKI',
      step: 'embedding_generation',
      status: 'skipped',
      inputSummary: { reason: 'lazy_embedding_only_in_chat' },
      outputSummary: {},
    })

    await logger.log({
      orchestratorState: 'ingestion_completed',
      agentName: 'GENOS',
      step: 'ingestion_completed',
      status: 'success',
      inputSummary: {},
      outputSummary: {
        detected_framework: framework.framework,
        entities_extracted_count: entities.length,
        graph_nodes_count: graph.length,
        ingestion_status: 'structure_indexed',
        scope: 'backend_api_flow_only',
      },
    })

    return {
      repository_id: derivedRepositoryId,
      detected_framework: framework.framework,
      entities_extracted_count: entities.length,
      graph_nodes_count: graph.length,
      embeddings_created_count: 0,
      ingestion_status: 'structure_indexed',
      reports,
    }
  } catch (error) {
    await logger.log({
      orchestratorState: 'ingestion_failed',
      agentName: 'GENOS',
      step: 'ingestion_failed',
      status: 'failed',
      inputSummary: {},
      outputSummary: {},
      errorMessage: error instanceof Error ? error.message : 'unknown_error',
    })
    throw error
  } finally {
    if (clonePath) {
      await fs.rm(clonePath, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
/*
import crypto from 'crypto'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import ts from 'typescript'
import { getSupabaseAdmin } from '@/lib/server/supabase-admin'
import { IngestionLogger } from '@/lib/agents/ingestion-logger'

const execFileAsync = promisify(execFile)
const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small'
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
const MAX_FILE_SIZE = 120_000
const BATCH_SIZE = 100
const EMBEDDING_BATCH_SIZE = 64

const EXCLUDED_PATH_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)(dist|build|out|coverage|.next)(\/|$)/,
  /(^|\/)(vendor|tmp|temp)(\/|$)/,
]

const EXCLUDED_FILE_PATTERNS = [
  /\.env(\..+)?$/i,
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tar|gz|jar|exe|dll|so|dylib|map|lock)$/i,
  /(^|\/)package-lock\.json$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
]

type FrameworkDetection = {
  primaryLanguage: string
  framework: string
  evidence: string[]
}

type AstRoute = {
  method: string
  path: string
  functionName?: string
}

type AstFileAnalysis = {
  path: string
  imports: string[]
  functions: string[]
  classes: string[]
  routes: AstRoute[]
  parseError?: string
}

type RepositoryEntityRow = {
  id: string
  repository_id: string
  entity_name: string
  entity_type: string
  file_path: string
  metadata: Record<string, unknown>
}

type CodeGraphRow = {
  repository_id: string
  source_entity_id: string
  target_entity_id: string
  relationship_type: string
  metadata: Record<string, unknown>
}

type EmbeddingRow = {
  repository_id: string
  entity_id: string
  embedding: number[]
  semantic_summary: string
}

type GenosResult = {
  repository_id: string
  detected_framework: string
  entities_extracted_count: number
  graph_nodes_count: number
  embeddings_created_count: number
  ingestion_status: 'success' | 'failed'
}

function sanitizeRepoUrl(url: string) {
  return url.trim()
}

function deriveRepositoryIdFromUrl(repositoryUrl: string) {
  const normalized = sanitizeRepoUrl(repositoryUrl).toLowerCase().replace(/\.git$/, '')
  const hex = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`
}

function makeDeterministicId(...parts: string[]) {
  const hex = crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 32).split('')
  // UUID v5-style deterministic formatting.
  hex[12] = '5'
  hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20, 32).join('')}`
}

function makeEntityId(repositoryId: string, entityName: string, filePath: string) {
  return makeDeterministicId(repositoryId, entityName, filePath)
}

function isIncludedPath(pathValue: string) {
  const lowerPath = pathValue.toLowerCase()
  if (EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(lowerPath))) return false
  if (EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(lowerPath))) return false
  return true
}

function isLikelyBinary(content: string) {
  return content.includes('\u0000')
}

async function cloneRepository(repositoryUrl: string, repositoryId: string) {
  const checkoutDir = path.join(os.tmpdir(), 'genos-ingestion', repositoryId)
  await fs.rm(checkoutDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(checkoutDir), { recursive: true })
  await execFileAsync('git', ['clone', '--depth', '1', repositoryUrl, checkoutDir], {
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  })
  return checkoutDir
}

async function readRepositoryFiles(rootDir: string) {
  const result: Array<{ path: string; content: string }> = []
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name)
      const relPath = path.relative(rootDir, absolute).replace(/\\/g, '/')
      if (!isIncludedPath(relPath)) continue
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue

      try {
        const stats = await fs.stat(absolute)
        if (stats.size === 0 || stats.size > MAX_FILE_SIZE) continue
        const content = await fs.readFile(absolute, 'utf8')
        if (!content || content.length < 2) continue
        if (isLikelyBinary(content)) continue
        result.push({ path: relPath, content })
      } catch {
        // ignore unreadable files
      }
    }
  }
  await walk(rootDir)
  return result
}

function detectFramework(files: Array<{ path: string; content: string }>): FrameworkDetection {
  const paths = files.map((f) => f.path.toLowerCase())
  const evidence: string[] = []

  let framework = 'unknown'
  if (paths.some((p) => p.includes('next.config'))) {
    framework = 'nextjs'
    evidence.push('next.config detected')
  } else if (paths.some((p) => p.endsWith('angular.json'))) {
    framework = 'angular'
    evidence.push('angular.json detected')
  } else if (paths.some((p) => p.endsWith('pom.xml'))) {
    framework = 'spring'
    evidence.push('pom.xml detected')
  } else if (paths.some((p) => p.endsWith('manage.py'))) {
    framework = 'django'
    evidence.push('manage.py detected')
  } else if (paths.some((p) => p.endsWith('go.mod'))) {
    framework = 'go'
    evidence.push('go.mod detected')
  }

  const languageScores: Record<string, number> = { typescript: 0, javascript: 0, python: 0, go: 0, java: 0 }
  for (const file of files) {
    if (file.path.endsWith('.ts') || file.path.endsWith('.tsx')) languageScores.typescript += 1
    else if (file.path.endsWith('.js') || file.path.endsWith('.jsx')) languageScores.javascript += 1
    else if (file.path.endsWith('.py')) languageScores.python += 1
    else if (file.path.endsWith('.go')) languageScores.go += 1
    else if (file.path.endsWith('.java')) languageScores.java += 1
  }

  const primaryLanguage = Object.entries(languageScores).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown'
  if (primaryLanguage !== 'unknown') {
    evidence.push(`primary language score favors ${primaryLanguage}`)
  }

  return { primaryLanguage, framework, evidence }
}

function parseWithAst(filePath: string, content: string): AstFileAnalysis {
  if (!/\.(ts|tsx|js|jsx)$/.test(filePath)) {
    return { path: filePath, imports: [], functions: [], classes: [], routes: [] }
  }

  try {
    const kind = filePath.endsWith('.ts') || filePath.endsWith('.tsx')
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS
    const source = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind)

    const imports = new Set<string>()
    const functions = new Set<string>()
    const classes = new Set<string>()
    const routes: AstRoute[] = []

    const walk = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.add(node.moduleSpecifier.text)
      }

      if (ts.isFunctionDeclaration(node) && node.name?.text) {
        functions.add(node.name.text)
      }

      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue
          if (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) {
            functions.add(d.name.text)
          }
        }
      }

      if (ts.isClassDeclaration(node) && node.name?.text) {
        classes.add(node.name.text)
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.getText(source).toLowerCase()
        const routeMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'use'])
        if (routeMethods.has(method) && node.arguments.length > 0) {
          const firstArg = node.arguments[0]
          if (ts.isStringLiteralLike(firstArg) && firstArg.text.startsWith('/')) {
            routes.push({
              method,
              path: firstArg.text,
              functionName: ts.isIdentifier(node.expression.expression)
                ? node.expression.expression.text
                : undefined,
            })
          }
        }
      }

      ts.forEachChild(node, walk)
    }

    walk(source)
    return {
      path: filePath,
      imports: Array.from(imports),
      functions: Array.from(functions),
      classes: Array.from(classes),
      routes,
    }
  } catch (error) {
    return {
      path: filePath,
      imports: [],
      functions: [],
      classes: [],
      routes: [],
      parseError: error instanceof Error ? error.message : 'ast_parse_failed',
    }
  }
}

function buildEntities(
  repositoryId: string,
  analyses: AstFileAnalysis[],
  framework: FrameworkDetection
): RepositoryEntityRow[] {
  const entities: RepositoryEntityRow[] = []
  const addEntity = (entityName: string, entityType: string, filePath: string, metadata: Record<string, unknown>) => {
    const id = makeEntityId(repositoryId, entityName, filePath)
    entities.push({
      id,
      repository_id: repositoryId,
      entity_name: entityName,
      entity_type: entityType,
      file_path: filePath,
      metadata: { ...metadata, framework: framework.framework, primary_language: framework.primaryLanguage },
    })
  }

  for (const file of analyses) {
    addEntity(file.path, 'module', file.path, { parse_error: file.parseError || null })
    for (const fn of file.functions) addEntity(fn, 'function', file.path, {})
    for (const cls of file.classes) addEntity(cls, 'class', file.path, {})
    for (const route of file.routes) {
      addEntity(`${route.method.toUpperCase()} ${route.path}`, 'api', file.path, {
        method: route.method,
        route_path: route.path,
      })
    }
    for (const imp of file.imports) addEntity(imp, 'dependency', file.path, {})
  }

  const deduped = new Map<string, RepositoryEntityRow>()
  for (const entity of entities) {
    const key = `${entity.repository_id}:${entity.entity_name}:${entity.file_path}`
    if (!deduped.has(key)) deduped.set(key, entity)
  }
  return Array.from(deduped.values())
}

function resolveImportedModuleEntityId(
  repositoryId: string,
  fromFilePath: string,
  importPath: string,
  entityIndex: Map<string, RepositoryEntityRow>
) {
  if (!importPath.startsWith('.')) return null
  const baseDir = fromFilePath.split('/').slice(0, -1).join('/')
  const normalized = `${baseDir}/${importPath}`.replace(/\/\.\//g, '/')
  const candidates = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
  ]
  for (const c of candidates) {
    const id = makeEntityId(repositoryId, c, c)
    const entity = entityIndex.get(id)
    if (entity) return entity.id
  }
  return null
}

function buildCodeGraph(
  repositoryId: string,
  analyses: AstFileAnalysis[],
  entities: RepositoryEntityRow[]
): CodeGraphRow[] {
  const graph: CodeGraphRow[] = []
  const entityIndex = new Map<string, RepositoryEntityRow>(entities.map((e) => [e.id, e]))

  for (const file of analyses) {
    const moduleId = makeEntityId(repositoryId, file.path, file.path)
    if (!entityIndex.has(moduleId)) continue

    for (const imp of file.imports) {
      const dependencyId = makeEntityId(repositoryId, imp, file.path)
      if (entityIndex.has(dependencyId)) {
        graph.push({
          repository_id: repositoryId,
          source_entity_id: moduleId,
          target_entity_id: dependencyId,
          relationship_type: 'IMPORTS',
          metadata: {},
        })
      }
      const importedModuleId = resolveImportedModuleEntityId(repositoryId, file.path, imp, entityIndex)
      if (importedModuleId) {
        graph.push({
          repository_id: repositoryId,
          source_entity_id: moduleId,
          target_entity_id: importedModuleId,
          relationship_type: 'USES_MODULE',
          metadata: {},
        })
      }
    }

    for (const route of file.routes) {
      const apiId = makeEntityId(repositoryId, `${route.method.toUpperCase()} ${route.path}`, file.path)
      if (entityIndex.has(apiId)) {
        graph.push({
          repository_id: repositoryId,
          source_entity_id: apiId,
          target_entity_id: moduleId,
          relationship_type: 'USES',
          metadata: {},
        })
      }
    }
  }

  const deduped = new Map<string, CodeGraphRow>()
  for (const edge of graph) {
    const key = `${edge.repository_id}:${edge.source_entity_id}:${edge.target_entity_id}:${edge.relationship_type}`
    if (!deduped.has(key)) deduped.set(key, edge)
  }
  return Array.from(deduped.values())
}

function buildSemanticSummary(entity: RepositoryEntityRow) {
  const meta = entity.metadata || {}
  const normalizeValue = (value: string, maxLen: number) =>
    value
      .replace(/[;\n\r\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, maxLen)

  const entityName = normalizeValue(entity.entity_name, 96)
  const entityType = normalizeValue(entity.entity_type, 32)
  const filePath = normalizeValue(entity.file_path, 140)
  // Keep compact to reduce token usage.
  const core = `entity=${entityName};type=${entityType};file=${filePath};`
  const framework =
    typeof meta.framework === 'string' && meta.framework !== 'unknown'
      ? `framework=${normalizeValue(meta.framework, 40)};`
      : ''
  const route =
    typeof meta.route_path === 'string' ? `route=${normalizeValue(meta.route_path, 80)};` : ''
  return `${core}${framework}${route}`.slice(0, 280)
}

function validateGroundedSummary(entity: RepositoryEntityRow, summary: string) {
  const required = ['entity=', 'type=', 'file=']
  if (!required.every((token) => summary.includes(token))) return false
  const clean = (value: string) =>
    value
      .replace(/[;\n\r\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  const normalizedSummary = clean(summary)
  const nameProbe = clean(entity.entity_name).slice(0, 32)
  const fileProbe = clean(entity.file_path).slice(0, 32)
  if (!nameProbe || !fileProbe) return false
  return normalizedSummary.includes(nameProbe) && normalizedSummary.includes(fileProbe)
}

function summaryHash(value: string) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12)
}

async function generateEmbeddingsBatchOrThrow(summaries: string[]): Promise<number[][]> {
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
      input: summaries,
    }),
  })

  if (!response.ok) {
    throw new Error(`embedding_request_failed_${response.status}`)
  }

  const json = await response.json()
  const data = Array.isArray(json?.data) ? json.data : []
  if (data.length !== summaries.length) {
    throw new Error('embedding_response_mismatch')
  }

  const result: number[][] = []
  for (const item of data) {
    if (!Array.isArray(item?.embedding)) {
      throw new Error('embedding_invalid_vector')
    }
    const vector = item.embedding.filter((v: unknown) => typeof v === 'number')
    if (vector.length === 0) {
      throw new Error('embedding_empty_vector')
    }
    result.push(vector)
  }
  return result
}

async function batchUpsert(
  table: 'repository_entities' | 'code_graph' | 'embeddings',
  rows: Record<string, unknown>[],
  onConflict: string
) {
  if (rows.length === 0) return
  const supabase = getSupabaseAdmin()
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from(table).upsert(chunk, { onConflict })
    if (error) throw new Error(`${table} upsert failed: ${error.message}`)
  }
}

export async function runGenosIngestion(input: {
  repositoryUrl: string
  repositoryId?: string
}): Promise<GenosResult> {
  const repositoryUrl = sanitizeRepoUrl(input.repositoryUrl)
  const derivedRepositoryId = deriveRepositoryIdFromUrl(repositoryUrl)
  const storageRepositoryId = input.repositoryId || derivedRepositoryId
  const logger = new IngestionLogger(storageRepositoryId, true)

  await logger.log({
    orchestratorState: 'ingestion_started',
    agentName: 'GENOS',
    step: 'ingestion_started',
    status: 'started',
    inputSummary: {
      repository_url_host: (() => {
        try {
          return new URL(repositoryUrl).host
        } catch {
          return 'invalid_url'
        }
      })(),
      derived_repository_id: derivedRepositoryId,
      storage_repository_id: storageRepositoryId,
    },
    outputSummary: {},
  })

  let clonePath = ''
  try {
    clonePath = await cloneRepository(repositoryUrl, derivedRepositoryId)
    await logger.log({
      orchestratorState: 'repo_cloned_success',
      agentName: 'GENOS',
      step: 'repo_cloned_success',
      status: 'success',
      inputSummary: { repository_url_host: (() => { try { return new URL(repositoryUrl).host } catch { return 'invalid_url' } })() },
      outputSummary: { clone_path_suffix: clonePath.slice(-36) },
    })

    let files: Array<{ path: string; content: string }> = []
    let framework: FrameworkDetection
    try {
      await logger.log({
        orchestratorState: 'framework_detected',
        agentName: 'BANG',
        step: 'framework_detection',
        status: 'started',
        inputSummary: {},
        outputSummary: {},
      })

      files = await readRepositoryFiles(clonePath)
      framework = detectFramework(files)
      await logger.log({
        orchestratorState: 'framework_detected',
        agentName: 'BANG',
        step: 'framework_detection',
        status: 'success',
        inputSummary: { files_scanned: files.length },
        outputSummary: { framework: framework.framework, primary_language: framework.primaryLanguage },
      })
    } catch (error) {
      await logger.log({
        orchestratorState: 'framework_detected',
        agentName: 'BANG',
        step: 'framework_detection',
        status: 'failed',
        inputSummary: {},
        outputSummary: {},
        errorMessage: error instanceof Error ? error.message : 'framework_detection_failed',
      })
      throw error
    }

    await logger.log({
      orchestratorState: 'ast_parsing_started',
      agentName: 'CHILD_EMPEROR',
      step: 'ast_parsing',
      status: 'started',
      inputSummary: { candidate_files: files.length },
      outputSummary: {},
    })

    let analyses: AstFileAnalysis[] = []
    try {
      analyses = files.map((file) => parseWithAst(file.path, file.content))
      const parseFailures = analyses.filter((a) => a.parseError).length
      await logger.log({
        orchestratorState: 'ast_parsing_started',
        agentName: 'CHILD_EMPEROR',
        step: 'ast_parsing',
        status: 'success',
        inputSummary: { files_processed: analyses.length },
        outputSummary: { parse_failures: parseFailures },
      })
    } catch (error) {
      await logger.log({
        orchestratorState: 'ast_parsing_started',
        agentName: 'CHILD_EMPEROR',
        step: 'ast_parsing',
        status: 'failed',
        inputSummary: {},
        outputSummary: {},
        errorMessage: error instanceof Error ? error.message : 'ast_parsing_failed',
      })
      throw error
    }

    await logger.log({
      orchestratorState: 'entities_extracted',
      agentName: 'DRIVE_KNIGHT',
      step: 'entity_extraction',
      status: 'started',
      inputSummary: { analyses_count: analyses.length },
      outputSummary: {},
    })
    let entities: RepositoryEntityRow[] = []
    try {
      entities = buildEntities(storageRepositoryId, analyses, framework)
      await batchUpsert('repository_entities', entities, 'repository_id,entity_name,file_path')
      await logger.log({
        orchestratorState: 'entities_extracted',
        agentName: 'DRIVE_KNIGHT',
        step: 'entity_extraction',
        status: 'success',
        inputSummary: { analyses_count: analyses.length },
        outputSummary: { entities_extracted_count: entities.length },
      })
    } catch (error) {
      await logger.log({
        orchestratorState: 'entities_extracted',
        agentName: 'DRIVE_KNIGHT',
        step: 'entity_extraction',
        status: 'failed',
        inputSummary: { analyses_count: analyses.length },
        outputSummary: {},
        errorMessage: error instanceof Error ? error.message : 'entity_extraction_failed',
      })
      throw error
    }

    await logger.log({
      orchestratorState: 'graph_built',
      agentName: 'METAL_KNIGHT',
      step: 'code_graph_build',
      status: 'started',
      inputSummary: { entities_count: entities.length },
      outputSummary: {},
    })
    let graph: CodeGraphRow[] = []
    try {
      graph = buildCodeGraph(storageRepositoryId, analyses, entities)
      await batchUpsert(
        'code_graph',
        graph,
        'repository_id,source_entity_id,target_entity_id,relationship_type'
      )
      await logger.log({
        orchestratorState: 'graph_built',
        agentName: 'METAL_KNIGHT',
        step: 'code_graph_build',
        status: 'success',
        inputSummary: { entities_count: entities.length },
        outputSummary: { graph_relationships_count: graph.length },
      })
    } catch (error) {
      await logger.log({
        orchestratorState: 'graph_built',
        agentName: 'METAL_KNIGHT',
        step: 'code_graph_build',
        status: 'failed',
        inputSummary: { entities_count: entities.length },
        outputSummary: {},
        errorMessage: error instanceof Error ? error.message : 'graph_build_failed',
      })
      throw error
    }

    await logger.log({
      orchestratorState: 'embeddings_generated',
      agentName: 'FUBUKI',
      step: 'embedding_generation',
      status: 'started',
      inputSummary: { entities_count: entities.length },
      outputSummary: {},
    })

    const embeddingRows: EmbeddingRow[] = []
    try {
      const candidates: Array<{ entity: RepositoryEntityRow; semanticSummary: string }> = []
      let hallucinationSkipped = 0
      for (const entity of entities) {
        if (!['function', 'class', 'module', 'api'].includes(entity.entity_type)) continue
        const semanticSummary = buildSemanticSummary(entity)
        if (!validateGroundedSummary(entity, semanticSummary)) {
          hallucinationSkipped += 1
          continue
        }
        candidates.push({ entity, semanticSummary })
      }

      for (let i = 0; i < candidates.length; i += EMBEDDING_BATCH_SIZE) {
        const chunk = candidates.slice(i, i + EMBEDDING_BATCH_SIZE)
        const vectors = await generateEmbeddingsBatchOrThrow(chunk.map((c) => c.semanticSummary))
        for (let idx = 0; idx < chunk.length; idx += 1) {
          const c = chunk[idx]
          embeddingRows.push({
            repository_id: storageRepositoryId,
            entity_id: c.entity.id,
            embedding: vectors[idx],
            semantic_summary: c.semanticSummary,
          })
        }
      }

      if (candidates.length > 0 && embeddingRows.length === 0) {
        throw new Error('embeddings_generation_empty')
      }
      await logger.log({
        orchestratorState: 'embeddings_generated',
        agentName: 'FUBUKI',
        step: 'embedding_generation',
        status: 'success',
        inputSummary: { entities_count: entities.length },
        outputSummary: {
          embeddings_candidate_count: candidates.length,
          embeddings_prepared_count: embeddingRows.length,
          hallucination_skipped_count: hallucinationSkipped,
          embeddings_batch_model: EMBEDDING_MODEL,
          sample_summary_hash: candidates[0] ? summaryHash(candidates[0].semanticSummary) : null,
        },
      })
    } catch (error) {
      await logger.log({
        orchestratorState: 'embeddings_generated',
        agentName: 'FUBUKI',
        step: 'embedding_generation',
        status: 'failed',
        inputSummary: { entities_count: entities.length },
        outputSummary: {},
        errorMessage: error instanceof Error ? error.message : 'embedding_generation_failed',
      })
      throw error
    }

    await logger.log({
      orchestratorState: 'embeddings_generated',
      agentName: 'KING',
      step: 'vector_storage',
      status: 'started',
      inputSummary: { embeddings_prepared_count: embeddingRows.length },
      outputSummary: {},
    })
    try {
      await batchUpsert('embeddings', embeddingRows, 'repository_id,entity_id')
      await logger.log({
        orchestratorState: 'embeddings_generated',
        agentName: 'KING',
        step: 'vector_storage',
        status: 'success',
        inputSummary: { embeddings_prepared_count: embeddingRows.length },
        outputSummary: { embeddings_created_count: embeddingRows.length },
      })
    } catch (error) {
      await logger.log({
        orchestratorState: 'embeddings_generated',
        agentName: 'KING',
        step: 'vector_storage',
        status: 'failed',
        inputSummary: { embeddings_prepared_count: embeddingRows.length },
        outputSummary: {},
        errorMessage: error instanceof Error ? error.message : 'vector_storage_failed',
      })
      throw error
    }

    await logger.log({
      orchestratorState: 'ingestion_completed',
      agentName: 'GENOS',
      step: 'ingestion_completed',
      status: 'success',
      inputSummary: { repository_url_host: (() => { try { return new URL(repositoryUrl).host } catch { return 'invalid_url' } })() },
      outputSummary: {
        detected_framework: framework.framework,
        entities_extracted_count: entities.length,
        graph_nodes_count: graph.length,
        embeddings_created_count: embeddingRows.length,
      },
    })

    return {
      repository_id: derivedRepositoryId,
      detected_framework: framework.framework,
      entities_extracted_count: entities.length,
      graph_nodes_count: graph.length,
      embeddings_created_count: embeddingRows.length,
      ingestion_status: 'success',
    }
  } catch (error) {
    await logger.log({
      orchestratorState: 'ingestion_failed',
      agentName: 'GENOS',
      step: 'ingestion_failed',
      status: 'failed',
      inputSummary: {},
      outputSummary: {},
      errorMessage: error instanceof Error ? error.message : 'unknown_error',
    })
    throw error
  } finally {
    if (clonePath) {
      await fs.rm(clonePath, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
*/
