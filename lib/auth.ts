import { OrgMemberRole, User } from '@/types'
import { supabase } from './supabase'

export type AuthRedirectTarget = '/login' | '/onboarding' | '/dashboard'

async function getAuthSession() {
  const { data, error } = await supabase.auth.getSession()
  if (error) {
    console.error('Error getting session:', error)
    return null
  }
  return data.session
}

async function getCurrentMembership(userId: string) {
  const { data, error } = await supabase
    .from('organization_members')
    .select('organization_id, role, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Error fetching organization membership:', error)
    return null
  }

  if (!data || data.length === 0) return null

  // Keep deterministic org selection; later this can be replaced by org switcher state.
  return data[0]
}

// Profile lookup only. This must NOT create rows.
export async function getCurrentUser(): Promise<User | null> {
  if (typeof window === 'undefined') return null

  const session = await getAuthSession()
  if (!session?.user) return null

  const { data: userProfile, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', session.user.id)
    .maybeSingle()

  if (error) {
    console.error('Error fetching user profile:', error)
    return null
  }

  // Profile is intentionally not auto-created after OAuth. Onboarding owns creation.
  if (!userProfile) {
    return {
      id: session.user.id,
      email: session.user.email || '',
      name:
        session.user.user_metadata?.full_name ||
        session.user.user_metadata?.name ||
        (session.user.email ? session.user.email.split('@')[0] : ''),
      onboardingCompleted: false,
      currentOrganizationId: null,
      currentOrganizationRole: null,
    }
  }

  const membership = await getCurrentMembership(session.user.id)
  const hasMembership = Boolean(membership?.organization_id)
  const completed = Boolean(userProfile.onboarding_completed) && hasMembership

  return {
    id: userProfile.id,
    email: userProfile.email,
    name: userProfile.name,
    onboardingCompleted: completed,
    currentOrganizationId: membership?.organization_id || null,
    currentOrganizationRole: (membership?.role as OrgMemberRole | undefined) || null,
  }
}

export async function getPostAuthRedirectTarget(): Promise<AuthRedirectTarget> {
  if (typeof window === 'undefined') return '/login'

  const session = await getAuthSession()
  if (!session?.user) return '/login'

  const { data: profile, error } = await supabase
    .from('users')
    .select('onboarding_completed')
    .eq('id', session.user.id)
    .maybeSingle()

  if (error || !profile || !profile.onboarding_completed) return '/onboarding'

  const membership = await getCurrentMembership(session.user.id)
  if (!membership?.organization_id) return '/onboarding'

  return '/dashboard'
}

// Sign in with Google
export async function signInWithGoogle() {
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    })
    
    if (error) throw error
    return { data, error: null }
  } catch (error) {
    console.error('Error signing in with Google:', error)
    return { data: null, error }
  }
}

// Sign out
export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut()
    if (error) throw error
    return { error: null }
  } catch (error) {
    console.error('Error signing out:', error)
    return { error }
  }
}

// Create profile only after onboarding is completed.
export async function completeOnboarding(input: {
  name: string
  organizationName: string
  role: OrgMemberRole
}): Promise<{ error: any; organizationId?: string }> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) {
      return { error: 'Not authenticated' }
    }

    const { data: organization, error: organizationError } = await supabase
      .from('organizations')
      .insert({ name: input.organizationName.trim() })
      .select()
      .single()

    if (organizationError || !organization) {
      return { error: organizationError || new Error('Failed to create organization') }
    }

    const requestedRole = input.role
    const assignedRole: OrgMemberRole = 'admin'
    if (requestedRole !== 'admin') {
      // First user in a newly created org is always admin by architecture rule.
      console.info(`Requested role "${requestedRole}" overridden to "${assignedRole}" for organization creator`)
    }

    const { error: userError } = await supabase
      .from('users')
      .upsert({
        id: session.user.id,
        email: session.user.email || '',
        name: input.name.trim(),
        onboarding_completed: true,
      }, { onConflict: 'id' })
      .select('id')
      .single()

    if (userError) {
      return { error: userError }
    }

    const { error: membershipError } = await supabase
      .from('organization_members')
      .upsert({
        user_id: session.user.id,
        organization_id: organization.id,
        role: assignedRole,
      }, { onConflict: 'user_id,organization_id' })

    if (membershipError) {
      return { error: membershipError }
    }

    return { error: null, organizationId: organization.id }
  } catch (error) {
    console.error('Error completing onboarding:', error)
    return { error }
  }
}

// Optional helper for authenticated user basic info before profile exists.
export async function getAuthUserBasic() {
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user ?? null
}

// Legacy functions for backward compatibility
export function setCurrentUser(_user: User | null): void {
  console.warn('setCurrentUser is deprecated. Use Supabase auth instead.')
}

export function hasRole(user: User | null, roles: OrgMemberRole[]): boolean {
  if (!user) return false
  if (!user.currentOrganizationRole) return false
  return roles.includes(user.currentOrganizationRole)
}

export function canIngestRepos(user: User | null): boolean {
  return hasRole(user, ['admin'])
}
