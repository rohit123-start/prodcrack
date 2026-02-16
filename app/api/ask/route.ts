import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getUserFromBearerToken } from '@/lib/server/supabase-admin'
import { runOpenAIJson, runOpenAIText } from '@/lib/llm/openai'

type RepoProvider = 'github' | 'gitlab' | 'bitbucket'

type RetrievedFile = {
  path: string
  content: string
}

type YutaOutput = {
  provider: RepoProvider
  filesRetrieved: number
  files: RetrievedFile[]
}

type GojoOutput = {
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

type HakariOutput = {
  status: 'passed' | 'needs_correction'
  issues: string[]
}

const AGENT_PROMPTS = {
  GOJO: `
You are GOJO, an intent analysis agent.
Return JSON only with:
{
  "intent": "string",
  "objective": "string",
  "keywords": ["string"],
  "answer_style": "string"
}
Keep keywords concise and retrieval-friendly.
`.trim(),
  SUKUNA: `
You are SUKUNA, a technical reasoning agent.
Use ONLY the provided repository code context.
Do not invent architecture, modules, or workflows.

If information is insufficient, return:
{
  "findings": [],
  "unknowns": ["insufficient context"],
  "constraints": ["insufficient repository evidence"]
}

Return JSON only with:
{
  "findings": ["string"],
  "unknowns": ["string"],
  "constraints": ["string"]
}
`.trim(),
  HAKARI: `
You are HAKARI, a validation guardrail agent.
Validate whether findings are evidence-backed and non-speculative.
Return JSON only:
{
  "status": "passed" | "needs_correction",
  "issues": ["string"]
}
`.trim(),
  YUJI: `
You are YUJI, a product explanation agent.
Translate validated findings into non-technical product explanation.
Never invent missing flows.
If unknowns exist, clearly say context is insufficient.
Return plain text only.
`.trim(),
} as const

function ensureUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    return new URL(`https://${value}`)
  }
}

function getRepoProvider(repoUrl: string): RepoProvider {
  const hostname = ensureUrl(repoUrl).hostname.toLowerCase()
  if (hostname.includes('github.com')) return 'github'
  if (hostname.includes('gitlab.com')) return 'gitlab'
  if (hostname.includes('bitbucket.org')) return 'bitbucket'
  throw new Error('Unsupported repository provider')
}

function extractPathParts(repoUrl: string) {
  const url = ensureUrl(repoUrl)
  const parts = url.pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
  return parts
}

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.length > 1)
    .slice(0, 10)
}

async function fetchTextOrNull(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { headers })
  if (!response.ok) return null
  return response.text()
}

async function fetchGithubReadme(repoUrl: string): Promise<RetrievedFile[]> {
  const parts = extractPathParts(repoUrl)
  if (parts.length < 2) return []
  const [owner, repo] = parts
  const token = process.env.GITHUB_TOKEN || process.env.GITHUB_ACCESS_TOKEN || ''
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.raw',
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const content = await fetchTextOrNull(
    `https://api.github.com/repos/${owner}/${repo}/readme`,
    headers
  )
  if (!content) return []
  return [{ path: 'README.md', content }]
}

async function fetchGitlabReadme(repoUrl: string): Promise<RetrievedFile[]> {
  const parts = extractPathParts(repoUrl)
  if (parts.length < 2) return []
  const projectPath = encodeURIComponent(parts.join('/'))
  const token = process.env.GITLAB_TOKEN || ''
  const headers: Record<string, string> = {}
  if (token) headers['PRIVATE-TOKEN'] = token

  const projectResponse = await fetch(`https://gitlab.com/api/v4/projects/${projectPath}`, { headers })
  if (!projectResponse.ok) return []
  const projectData = await projectResponse.json()
  const defaultBranch = projectData?.default_branch || 'main'

  const candidates = ['README.md', 'readme.md']
  for (const candidate of candidates) {
    const encodedFile = encodeURIComponent(candidate)
    const rawUrl = `https://gitlab.com/api/v4/projects/${projectPath}/repository/files/${encodedFile}/raw?ref=${encodeURIComponent(
      defaultBranch
    )}`
    const content = await fetchTextOrNull(rawUrl, headers)
    if (content) return [{ path: candidate, content }]
  }
  return []
}

async function fetchBitbucketReadme(repoUrl: string): Promise<RetrievedFile[]> {
  const parts = extractPathParts(repoUrl)
  if (parts.length < 2) return []
  const [workspace, repoSlug] = parts

  const token = process.env.BITBUCKET_TOKEN || ''
  const username = process.env.BITBUCKET_USERNAME || ''
  const appPassword = process.env.BITBUCKET_APP_PASSWORD || ''
  const headers: Record<string, string> = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  } else if (username && appPassword) {
    const encoded = Buffer.from(`${username}:${appPassword}`).toString('base64')
    headers.Authorization = `Basic ${encoded}`
  }

  const metaResponse = await fetch(`https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}`, {
    headers,
  })
  if (!metaResponse.ok) return []
  const meta = await metaResponse.json()
  const branch = meta?.mainbranch?.name || 'main'

  const candidates = ['README.md', 'readme.md']
  for (const candidate of candidates) {
    const rawUrl = `https://api.bitbucket.org/2.0/repositories/${workspace}/${repoSlug}/src/${encodeURIComponent(
      branch
    )}/${candidate}`
    const content = await fetchTextOrNull(rawUrl, headers)
    if (content) return [{ path: candidate, content }]
  }
  return []
}

async function yutaRetrieveRepo(repoUrl: string): Promise<YutaOutput> {
  const provider = getRepoProvider(repoUrl)
  console.log('[YUTA FETCHING]:', { provider, repoUrl })

  let files: RetrievedFile[] = []
  if (provider === 'github') files = await fetchGithubReadme(repoUrl)
  if (provider === 'gitlab') files = await fetchGitlabReadme(repoUrl)
  if (provider === 'bitbucket') files = await fetchBitbucketReadme(repoUrl)

  if (files.length === 0 || !files[0]?.content?.trim()) {
    throw new Error('REPO_CONTENT_NOT_FOUND')
  }

  const output: YutaOutput = {
    provider,
    filesRetrieved: files.length,
    files,
  }

  console.log('[YUTA OUTPUT]:', { filesRetrieved: output.filesRetrieved })
  return output
}

async function gojoIntent(question: string): Promise<GojoOutput> {
  const fallback: GojoOutput = {
    intent: 'unknown',
    objective: 'unknown',
    keywords: [],
    answer_style: 'product',
  }
  console.log('[GOJO INPUT]:', question)
  const parsed = await runOpenAIJson<GojoOutput>(AGENT_PROMPTS.GOJO, JSON.stringify({ question }), fallback)
  const output: GojoOutput = {
    intent: typeof parsed?.intent === 'string' ? parsed.intent : 'unknown',
    objective: typeof parsed?.objective === 'string' ? parsed.objective : 'unknown',
    keywords: normalizeKeywords(parsed?.keywords),
    answer_style: typeof parsed?.answer_style === 'string' ? parsed.answer_style : 'product',
  }
  console.log('[GOJO OUTPUT]:', output)
  return output
}

async function sukunaAnalyze(input: {
  objective: string
  keywords: string[]
  files: RetrievedFile[]
}): Promise<SukunaOutput> {
  const context = input.files
    .map((file) => `[${file.path}]\n${file.content.slice(0, 3000)}`)
    .join('\n\n')

  console.log('[SUKUNA INPUT SIZE]:', context.length)

  const fallback: SukunaOutput = {
    findings: [],
    unknowns: ['insufficient context'],
    constraints: ['insufficient repository evidence'],
  }

  const parsed = await runOpenAIJson<SukunaOutput>(
    AGENT_PROMPTS.SUKUNA,
    JSON.stringify({
      objective: input.objective,
      keywords: input.keywords,
      code_context: context,
    }),
    fallback
  )

  const output: SukunaOutput = {
    findings: Array.isArray(parsed?.findings)
      ? parsed.findings.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [],
    unknowns: Array.isArray(parsed?.unknowns)
      ? parsed.unknowns.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : ['insufficient context'],
    constraints: Array.isArray(parsed?.constraints)
      ? parsed.constraints.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [],
  }

  if (output.findings.length === 0 && output.unknowns.length === 0) {
    output.unknowns = ['insufficient context']
  }

  console.log('[SUKUNA OUTPUT]:', output)
  return output
}

async function hakariValidate(sukuna: SukunaOutput): Promise<HakariOutput> {
  const heuristic: HakariOutput =
    sukuna.findings.length === 0 || sukuna.unknowns.length > 0
      ? {
          status: 'needs_correction',
          issues: ['Findings are incomplete or uncertain'],
        }
      : {
          status: 'passed',
          issues: [],
        }

  const parsed = await runOpenAIJson<HakariOutput>(
    AGENT_PROMPTS.HAKARI,
    JSON.stringify({
      findings: sukuna.findings,
      unknowns: sukuna.unknowns,
      constraints: sukuna.constraints,
    }),
    heuristic
  )

  const output: HakariOutput = {
    status: parsed?.status === 'passed' || parsed?.status === 'needs_correction'
      ? parsed.status
      : heuristic.status,
    issues: Array.isArray(parsed?.issues)
      ? parsed.issues.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : heuristic.issues,
  }
  console.log('[HAKARI VALIDATION]:', output.status, output.issues.length > 0 ? output.issues : '')
  return output
}

async function yujiTranslate(input: {
  objective: string
  answerStyle: string
  sukuna: SukunaOutput
  hakari: HakariOutput
}): Promise<string> {
  if (input.sukuna.unknowns.length > 0) {
    const safe =
      'I cannot confidently describe product flows from the current repository context. Please provide richer repository content or documentation.'
    console.log('[YUJI FINAL OUTPUT]:', safe)
    return safe
  }

  const fallback =
    'Based on available context, this appears partially understood. Please validate against repository documentation.'

  const answer = await runOpenAIText(
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
  console.log('[YUJI FINAL OUTPUT]:', answer)
  return answer || fallback
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const question = typeof body?.question === 'string' ? body.question.trim() : ''
    const repositoryId = typeof body?.repositoryId === 'string' ? body.repositoryId.trim() : ''

    console.log('\n[QUESTION RECEIVED]:', question)

    if (!question) {
      return NextResponse.json({ answer: 'Question is required', debug: { gojo: {}, sukuna: {}, hakari: {} } }, { status: 400 })
    }
    if (!repositoryId) {
      return NextResponse.json({ answer: 'repositoryId is required', debug: { gojo: {}, sukuna: {}, hakari: {} } }, { status: 400 })
    }

    const authHeader = request.headers.get('authorization')
    const accessToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!accessToken) {
      return NextResponse.json({ answer: 'Unauthorized', debug: { gojo: {}, sukuna: {}, hakari: {} } }, { status: 401 })
    }

    const authUser = await getUserFromBearerToken(accessToken)
    if (!authUser) {
      return NextResponse.json({ answer: 'Unauthorized', debug: { gojo: {}, sukuna: {}, hakari: {} } }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const { data: memberships } = await supabase
      .from('organization_members')
      .select('organization_id')
      .eq('user_id', authUser.id)

    const orgIds = (memberships || []).map((m) => m.organization_id)
    if (orgIds.length === 0) {
      return NextResponse.json({ answer: 'No organization access', debug: { gojo: {}, sukuna: {}, hakari: {} } }, { status: 403 })
    }

    const { data: repository, error: repositoryError } = await supabase
      .from('repositories')
      .select('id, repo_url')
      .eq('id', repositoryId)
      .in('organization_id', orgIds)
      .maybeSingle()

    if (repositoryError || !repository) {
      return NextResponse.json({ answer: 'Repository not accessible', debug: { gojo: {}, sukuna: {}, hakari: {} } }, { status: 403 })
    }

    const gojo = await gojoIntent(question)
    const yuta = await yutaRetrieveRepo(repository.repo_url)
    const totalContentLength = yuta.files.reduce((sum, file) => sum + file.content.length, 0)

    if (yuta.files.length === 0 || totalContentLength < 50) {
      console.log('[PIPELINE STOPPED]: insufficient repository context')
      const sukunaStopped: SukunaOutput = {
        findings: [],
        unknowns: ['insufficient context'],
        constraints: ['pipeline stopped before analysis'],
      }
      const hakariStopped: HakariOutput = {
        status: 'needs_correction',
        issues: ['insufficient repository context'],
      }
      return NextResponse.json({
        answer: 'Unable to analyze repository because content retrieval failed.',
        debug: {
          gojo,
          sukuna: sukunaStopped,
          hakari: hakariStopped,
        },
      })
    }

    const sukuna = await sukunaAnalyze({
      objective: gojo.objective,
      keywords: gojo.keywords,
      files: yuta.files,
    })
    const hakari = await hakariValidate(sukuna)
    const answer = await yujiTranslate({
      objective: gojo.objective,
      answerStyle: gojo.answer_style,
      sukuna,
      hakari,
    })

    return NextResponse.json({
      answer,
      debug: {
        gojo,
        sukuna,
        hakari,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    if (message === 'REPO_CONTENT_NOT_FOUND') {
      console.log('[PIPELINE STOPPED]: insufficient repository context')
      return NextResponse.json({
        answer: 'Unable to analyze repository because content retrieval failed.',
        debug: {
          gojo: {},
          sukuna: {
            findings: [],
            unknowns: ['insufficient context'],
            constraints: ['repository content not found'],
          },
          hakari: {
            status: 'needs_correction',
            issues: ['REPO_CONTENT_NOT_FOUND'],
          },
        },
      })
    }

    console.error('[ASK PIPELINE ERROR]:', error)
    return NextResponse.json(
      {
        answer: 'Unable to analyze repository because content retrieval failed.',
        debug: {
          gojo: {},
          sukuna: {
            findings: [],
            unknowns: ['insufficient context'],
            constraints: ['pipeline error'],
          },
          hakari: {
            status: 'needs_correction',
            issues: ['pipeline failure'],
          },
        },
      },
      { status: 500 }
    )
  }
}
