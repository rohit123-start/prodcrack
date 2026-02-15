import { Repository } from '@/types'

// Simulated repository storage
// In production, this would be stored in a database
let repositories: Repository[] = [
  {
    id: 'repo_1',
    serviceName: 'User Service',
    repoUrl: 'https://github.com/org/user-service',
    organizationId: 'org_1',
    isIngested: false,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'repo_2',
    serviceName: 'Payment Service',
    repoUrl: 'https://github.com/org/payment-service',
    organizationId: 'org_1',
    isIngested: true,
    ingestedAt: new Date(Date.now() - 86400000).toISOString(),
    createdAt: new Date(Date.now() - 172800000).toISOString(),
  },
]

export function getRepositories(organizationId: string): Repository[] {
  return repositories.filter(repo => repo.organizationId === organizationId)
}

export function getRepositoryById(repositoryId: string): Repository | null {
  return repositories.find((repo) => repo.id === repositoryId) || null
}

export function addRepository(
  serviceName: string,
  repoUrl: string,
  organizationId: string
): Repository {
  const newRepo: Repository = {
    id: `repo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    serviceName,
    repoUrl,
    organizationId,
    isIngested: false,
    createdAt: new Date().toISOString(),
  }
  repositories.push(newRepo)
  return newRepo
}

export function markRepositoryAsIngested(repositoryId: string): void {
  const repo = repositories.find(r => r.id === repositoryId)
  if (repo) {
    repo.isIngested = true
    repo.ingestedAt = new Date().toISOString()
  }
}
