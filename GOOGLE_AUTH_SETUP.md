# Google OAuth Authentication Setup Guide

This guide will help you set up Google OAuth authentication for ProductGPT using Supabase.

## Prerequisites

1. A Supabase project (create one at https://supabase.com)
2. A Google Cloud Project with OAuth credentials

## Step 1: Set Up Google OAuth Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the Google+ API:
   - Go to "APIs & Services" > "Library"
   - Search for "Google+ API" and enable it
4. Create OAuth 2.0 credentials:
   - Go to "APIs & Services" > "Credentials",
   - Click "Create Credentials" > "OAuth client ID"
   - Choose "Web application"
   - Add authorized redirect URIs:
     - `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
     - `http://localhost:3000/auth/callback` (for local development)
   - Copy the **Client ID** and **Client Secret**

## Step 2: Configure Supabase

1. Go to your Supabase Dashboard
2. Navigate to **Authentication** > **Providers**
3. Enable **Google** provider
4. Enter your Google OAuth credentials:
   - **Client ID (for OAuth)**: Your Google Client ID
   - **Client Secret (for OAuth)**: Your Google Client Secret
5. Save the configuration

## Step 3: Set Up Environment Variables

Create or update your `.env.local` file:

```env
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_anon_key_here
```

You can find these values in:
- Supabase Dashboard > Settings > API

## Step 4: Set Up Database Schema

Make sure you've run the Supabase migration to create the necessary tables:

1. Go to Supabase Dashboard > SQL Editor
2. Run the migration from `supabase_migration.sql` (if you have it)
3. Or manually create the tables:
   - `organizations`
   - `users`
   - `repositories`
   - `product_context_blocks`

## Step 5: Test the Authentication

1. Start your development server:
   ```bash
   npm run dev
   ```

2. Navigate to `http://localhost:3000/login`
3. Click "Continue with Google"
4. You should be redirected to Google's sign-in page
5. After signing in, you'll be redirected back to the app

## Troubleshooting

### Issue: "Redirect URI mismatch"
**Solution**: Make sure the redirect URI in Google Cloud Console exactly matches:
- Production: `https://YOUR_PROJECT_REF.supabase.co/auth/v1/callback`
- Development: `http://localhost:3000/auth/callback`

### Issue: "Invalid client"
**Solution**: 
- Double-check your Client ID and Client Secret in Supabase
- Make sure Google+ API is enabled in Google Cloud Console

### Issue: User not created in database
**Solution**: 
- The app automatically creates a user profile on first login
- Make sure the `users` table exists and has the correct schema
- Check browser console for any errors

### Issue: Stuck on loading screen
**Solution**:
- Check that environment variables are set correctly
- Verify Supabase URL and keys are correct
- Check browser console for errors
- Make sure the auth callback route is working

## Security Notes

- Never commit `.env.local` to version control
- Keep your Google Client Secret secure
- Use environment variables in production (Vercel, etc.)
- The Supabase anon key is safe to expose in the frontend (it's protected by RLS)

## Production Deployment

When deploying to production:

1. Update the redirect URI in Google Cloud Console to your production URL
2. Update Supabase redirect URLs in Authentication settings
3. Set environment variables in your hosting platform (Vercel, etc.)
4. Test the authentication flow in production

## Next Steps

After authentication is working:
- Users will be automatically created with `business_analyst` role
- You can manually update user roles in the Supabase `users` table
- Consider adding role management UI for admins
