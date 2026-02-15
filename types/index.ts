export type OrgMemberRole = 'admin' | 'member' | 'viewer'
export type RepoProvider = 'github' | 'gitlab' | 'bitbucket'
export type RepoStatus = 'not_ingested' | 'ingesting' | 'ingested' | 'failed'

export interface User {
  id: string
  email: string
  name: string
  onboardingCompleted: boolean
  currentOrganizationId: string | null
  currentOrganizationRole: OrgMemberRole | null
}

export interface Organization {
  id: string
  name: string
  createdAt: string
}

export interface Repository {
  id: string
  provider: RepoProvider
  serviceName: string
  repoUrl: string
  productId: string
  organizationId: string
  status: RepoStatus
  isIngested: boolean
  ingestedAt?: string
  createdAt: string
}

export type ContextBlockType =
  | 'feature'
  | 'architecture'
  | 'user_flow'
  | 'integration'
  | 'business_logic'
  | 'flow'
  | 'permissions'
  | 'billing'

export interface ProductContextBlock {
  id: string
  repositoryId: string
  type: ContextBlockType
  title: string
  description: string
  content: string
  keywords: string[]
  createdAt: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  confidence?: number
  timestamp: Date
}

export interface IngestResponse {
  success: boolean
  message: string
  contextBlocksCreated?: number
}

export interface AIResponse {
  answer: string
  confidence: number
  contextBlocksUsed: string[]
}
