import { RepoProvider } from '@/types'
import { fetchRepoStructure as fetchGithub } from './github'
import { fetchRepoStructure as fetchGitlab } from './gitlab'
import { fetchRepoStructure as fetchBitbucket } from './bitbucket'

export interface RepoSnapshotFile {
  path: string
  content: string
}

export async function fetchProviderRepoMetadata(provider: RepoProvider, repoUrl: string) {
  switch (provider) {
    case 'github':
      return fetchGithub(repoUrl)
    case 'gitlab':
      return fetchGitlab(repoUrl)
    case 'bitbucket':
      return fetchBitbucket(repoUrl)
    default:
      throw new Error(`Unsupported provider: ${provider}`)
  }
}

export async function fetchRepositorySnapshot(provider: RepoProvider, repoUrl: string): Promise<RepoSnapshotFile[]> {
  const metadata = await fetchProviderRepoMetadata(provider, repoUrl)
  return metadata.files.map((file) => ({
    path: file,
    // Simulated provider file content pull. We do not persist this raw content.
    content:
      file.toLowerCase() === 'readme.md'
        ? `# ${repoUrl}\nProduct service overview and usage flows.`
        : `// ${file}\nmodule behavior, api integrations, roles, and workflows`,
  }))
}

const IGNORE_PATTERNS = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)(dist|build|out|coverage)(\/|$)/,
  /\.lock$/i,
  /\.(png|jpg|jpeg|gif|webp|zip|jar|pdf|exe|bin)$/i,
]

export function filterRepositoryFiles(files: RepoSnapshotFile[]) {
  return files.filter((file) => !IGNORE_PATTERNS.some((pattern) => pattern.test(file.path)))
}

// Chunk by feature/module using directory boundaries.
export function chunkFilesByModule(files: RepoSnapshotFile[]) {
  const moduleMap = new Map<string, RepoSnapshotFile[]>()
  for (const file of files) {
    const parts = file.path.split('/')
    const moduleKey = parts.length > 1 ? parts[0] : 'root'
    const group = moduleMap.get(moduleKey) || []
    group.push(file)
    moduleMap.set(moduleKey, group)
  }

  return Array.from(moduleMap.entries()).map(([module, group]) => ({
    module,
    files: group.map((f) => f.path),
    content: group
      .slice(0, 12)
      .map((f) => `FILE: ${f.path}\n${f.content.slice(0, 1200)}`)
      .join('\n\n'),
  }))
}
