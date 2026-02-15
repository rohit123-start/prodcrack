import { ProductContextBlock, ContextBlockType } from '@/types'

// Simulated product context blocks storage
// In production, this would be stored in a database
let contextBlocks: ProductContextBlock[] = []

export function getContextBlocks(repositoryId?: string): ProductContextBlock[] {
  if (repositoryId) {
    return contextBlocks.filter(block => block.repositoryId === repositoryId)
  }
  return contextBlocks
}

export function addContextBlock(block: Omit<ProductContextBlock, 'id' | 'createdAt'>): ProductContextBlock {
  const newBlock: ProductContextBlock = {
    ...block,
    id: `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    createdAt: new Date().toISOString(),
  }
  contextBlocks.push(newBlock)
  return newBlock
}

export function searchContextBlocks(query: string, repositoryId?: string): ProductContextBlock[] {
  const blocks = repositoryId 
    ? contextBlocks.filter(b => b.repositoryId === repositoryId)
    : contextBlocks
  
  const lowerQuery = query.toLowerCase()
  
  return blocks.filter(block => {
    const matchesTitle = block.title.toLowerCase().includes(lowerQuery)
    const matchesDescription = block.description.toLowerCase().includes(lowerQuery)
    const matchesKeywords = block.keywords.some(kw => kw.toLowerCase().includes(lowerQuery))
    const matchesContent = block.content.toLowerCase().includes(lowerQuery)
    
    return matchesTitle || matchesDescription || matchesKeywords || matchesContent
  })
}

export function generateMockContextBlocks(repositoryId: string): ProductContextBlock[] {
  const mockBlocks: Omit<ProductContextBlock, 'id' | 'createdAt'>[] = [
    {
      repositoryId,
      type: 'flow',
      title: 'User Authentication Flow',
      description: 'Complete user authentication and authorization process',
      content: 'Users can sign up with email, verify their account, and log in. After login, they are redirected to the dashboard. The system supports password reset and two-factor authentication.',
      keywords: ['authentication', 'login', 'signup', 'security', 'user flow'],
    },
    {
      repositoryId,
      type: 'permissions',
      title: 'Role-Based Access Control',
      description: 'Permission system for different user roles',
      content: 'The system has three main roles: Admin, Product Manager, and Business Analyst. Admins can manage repositories and ingest data. Product Managers can ingest repos and view insights. Business Analysts can only view insights and ask questions.',
      keywords: ['permissions', 'roles', 'access control', 'admin', 'pm', 'analyst'],
    },
    {
      repositoryId,
      type: 'billing',
      title: 'Subscription Management',
      description: 'How subscription and billing works',
      content: 'Users can subscribe to monthly or annual plans. Billing is processed automatically. The system supports upgrades, downgrades, and cancellations. Payment methods are securely stored.',
      keywords: ['billing', 'subscription', 'payment', 'plans', 'pricing'],
    },
    {
      repositoryId,
      type: 'feature',
      title: 'Product Insights Dashboard',
      description: 'Main dashboard for viewing product insights',
      content: 'The dashboard displays key product metrics, recent activity, and quick access to repositories. Users can filter by date range and view detailed analytics for each repository.',
      keywords: ['dashboard', 'insights', 'analytics', 'metrics', 'reports'],
    },
  ]
  
  return mockBlocks.map(block => addContextBlock(block))
}
