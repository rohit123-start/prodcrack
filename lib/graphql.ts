import { GraphQLClient } from 'graphql-request'

// GraphQL fetch wrapper
const endpoint = process.env.NEXT_PUBLIC_GRAPHQL_ENDPOINT || '/api/graphql'

export const graphqlClient = new GraphQLClient(endpoint, {
  headers: {
    'Content-Type': 'application/json',
  },
})

export async function graphqlRequest<T = any>(
  query: string,
  variables?: Record<string, any>
): Promise<T> {
  try {
    return await graphqlClient.request<T>(query, variables)
  } catch (error) {
    console.error('GraphQL request failed:', error)
    throw error
  }
}
