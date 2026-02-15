export type OrgMemberRole = 'admin' | 'member' | 'viewer'

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
  serviceName: string
  repoUrl: string
  organizationId: string
  isIngested: boolean
  ingestedAt?: string
  createdAt: string
}

export type ContextBlockType = 'flow' | 'permissions' | 'billing' | 'feature'

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
