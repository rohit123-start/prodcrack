export async function fetchRepoStructure(repoUrl: string) {
  await new Promise((resolve) => setTimeout(resolve, 150))
  return {
    provider: 'gitlab' as const,
    repoUrl,
    files: ['README.md', 'src/billing.ts', 'src/subscriptions.ts', '.gitlab-ci.yml'],
    services: ['billing-service', 'subscription-service'],
    configs: ['.gitlab-ci.yml'],
  }
}
