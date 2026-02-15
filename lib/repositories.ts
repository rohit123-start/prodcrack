import { RepoProvider, Repository } from '@/types'
import { supabase } from './supabase'

function mapRepositoryRow(row: any): Repository {
  return {
    id: row.id,
    provider: row.provider,
    serviceName: row.service_name,
    repoUrl: row.repo_url,
    productId: row.product_id,
    organizationId: row.organization_id,
    status: row.status,
    isIngested: row.is_ingested,
    ingestedAt: row.ingested_at || undefined,
    createdAt: row.created_at,
  }
}

export async function getRepositories(organizationId: string): Promise<Repository[]> {
  const { data, error } = await supabase
    .from('repositories')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Error loading repositories:', error)
    return []
  }
  return (data || []).map(mapRepositoryRow)
}

export async function addRepository(input: {
  provider: RepoProvider
  serviceName: string
  repoUrl: string
  productId: string
  organizationId: string
}): Promise<{ repository: Repository | null; error: any }> {
  const { data, error } = await supabase
    .from('repositories')
    .insert({
      provider: input.provider,
      service_name: input.serviceName,
      repo_url: input.repoUrl,
      product_id: input.productId,
      organization_id: input.organizationId,
      status: 'not_ingested',
      is_ingested: false,
    })
    .select('*')
    .single()

  if (error || !data) {
    return { repository: null, error: error || new Error('Insert failed') }
  }
  return { repository: mapRepositoryRow(data), error: null }
}
