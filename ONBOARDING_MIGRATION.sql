-- Migration to add onboarding support
-- Run this in Supabase SQL Editor

-- Add onboarding_completed column to users table
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE;

-- Make organization_id nullable (for users who haven't completed onboarding)
ALTER TABLE users 
ALTER COLUMN organization_id DROP NOT NULL;

-- Update existing users to have onboarding_completed = true
-- (assuming existing users have already completed onboarding)
UPDATE users 
SET onboarding_completed = TRUE 
WHERE organization_id IS NOT NULL;

-- Set onboarding_completed = false for users without organization
UPDATE users 
SET onboarding_completed = FALSE 
WHERE organization_id IS NULL;
