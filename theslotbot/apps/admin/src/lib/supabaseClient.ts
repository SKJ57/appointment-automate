/**
 * src/lib/supabaseClient.ts
 *
 * Frontend Supabase client, using the anon key only. This client can
 * sign in existing users and manage sessions — it has NO capability
 * to create accounts (Supabase's client-side signUp() method exists
 * on the SDK, but this codebase never calls it anywhere, which is the
 * actual enforcement of "no public sign-up" on the frontend side; the
 * real enforcement is server-side in authMiddleware.ts, which rejects
 * any Supabase session with no matching invited User row).
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set — see .env.example',
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // needed for the invite-accept magic-link-style flow
  },
});
