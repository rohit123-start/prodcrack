export async function fetchRepoStructure(repoUrl: string) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  return {
    provider: 'bitbucket' as const,
    repoUrl,
    files: ['README.md', 'src/feature-flags.ts', 'src/permissions.ts', 'bitbucket-pipelines.yml'],
    services: ['feature-service', 'permissions-service'],
    configs: ['bitbucket-pipelines.yml'],
  }
}
