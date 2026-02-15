# Onboarding Flow Implementation

## Overview

The authentication flow has been updated to include an onboarding step that must be completed before users can access the dashboard and other protected pages.

## Changes Made

### 1. User Type Update
- Added `onboardingCompleted: boolean` field to the `User` interface

### 2. Authentication Flow Updates

#### `lib/auth.ts`
- Updated `getCurrentUser()` to:
  - Return `onboardingCompleted: false` for new users
  - Set `organization_id: null` for new users (will be set during onboarding)
  - Include `onboardingCompleted` in returned user object
- Added `completeOnboarding(organizationId)` function to:
  - Create/assign organization to user
  - Mark onboarding as completed

#### `app/auth/callback/route.ts`
- After OAuth callback, checks `onboarding_completed` status
- Redirects to `/onboarding` if not completed
- Redirects to `/dashboard` if completed

#### `app/page.tsx`
- Checks onboarding status after authentication
- Redirects to `/onboarding` if not completed
- Redirects to `/dashboard` if completed

### 3. Onboarding Page

#### `app/onboarding/page.tsx`
- New page that:
  - Requires authentication (redirects to login if not authenticated)
  - Prevents access if onboarding already completed (redirects to dashboard)
  - Collects organization name
  - Creates organization and completes onboarding
  - Redirects to dashboard after completion

### 4. Protected Pages Updates

All protected pages now check onboarding status:
- `app/dashboard/page.tsx`
- `app/repositories/page.tsx`
- `app/settings/page.tsx`
- `app/insights/page.tsx`

If `onboardingCompleted` is `false`, users are redirected to `/onboarding`.

## Database Schema Changes

Run the migration in `ONBOARDING_MIGRATION.sql`:

1. Add `onboarding_completed` column to `users` table (default: `false`)
2. Make `organization_id` nullable (for users who haven't completed onboarding)
3. Update existing users appropriately

## Flow Diagram

```
User Signs In
    ↓
OAuth Callback
    ↓
Check onboarding_completed
    ↓
    ├─ false → Redirect to /onboarding
    │           ↓
    │       User enters organization name
    │           ↓
    │       Create organization
    │           ↓
    │       Mark onboarding_completed = true
    │           ↓
    │       Redirect to /dashboard
    │
    └─ true → Redirect to /dashboard
```

## Guardrails Implemented

✅ **Onboarding cannot be skipped**: All protected pages check `onboardingCompleted` and redirect if false

✅ **Onboarding page is inaccessible after completion**: The onboarding page checks status and redirects to dashboard if already completed

✅ **No OAuth changes**: OAuth provider setup remains unchanged

✅ **No session creation changes**: Session creation logic is unchanged

✅ **Post-auth routing only**: Only routing logic after authentication was modified

✅ **Users without organizationId**: Instead of redirecting to login, users are redirected to onboarding

## Testing Checklist

- [ ] New user signs in → Redirected to onboarding
- [ ] User completes onboarding → Redirected to dashboard
- [ ] User tries to access dashboard without onboarding → Redirected to onboarding
- [ ] User tries to access onboarding after completion → Redirected to dashboard
- [ ] User tries to access protected pages without onboarding → Redirected to onboarding
- [ ] Database migration runs successfully
- [ ] Existing users with organizations have `onboarding_completed = true`

## Notes

- New users are created with `organization_id: null` and `onboarding_completed: false`
- Organization is created during onboarding
- Once onboarding is completed, it cannot be accessed again
- All protected routes enforce onboarding completion
