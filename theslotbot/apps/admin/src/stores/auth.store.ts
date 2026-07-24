/**
 * src/stores/auth.store.ts
 *
 * INVITE-ONLY ENFORCEMENT, FRONTEND HALF:
 * This store deliberately has NO signUp() action. There is no UI path
 * in this codebase that calls supabase.auth.signUp(). The only way an
 * account is created is via the invite-acceptance flow (a separate,
 * token-gated page — not part of this store), which itself calls a
 * backend endpoint, not the Supabase client directly.
 *
 * The real authorization boundary is server-side (authMiddleware.ts):
 * every API call carries the Supabase access token, and the backend
 * rejects any token that doesn't resolve to an invited User row. This
 * store's job is narrower — it just reflects that state so the UI can
 * react correctly (show a login screen, show "not authorized" if
 * Supabase auth succeeded but our /auth/me lookup failed, or show the
 * authenticated app).
 *
 * ROLE-BASED UI:
 * `role` and `salonId` come from OUR backend (`/api/auth/me`), not
 * decoded from the Supabase JWT directly — the JWT only proves identity,
 * our database is what defines role and salon scope. Never trust a
 * client-side JWT claim for authorization decisions; this store treats
 * the JWT purely as a bearer credential to attach to API requests.
 */

import { create } from 'zustand';
import type { Session } from '@supabase/supabase-js';
import { UserRole } from '@theslotbot/shared/types';
import { supabase } from '@/lib/supabaseClient';

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  salonId: string | null;
}

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'unauthorized';

interface AuthState {
  status: AuthStatus;
  session: Session | null;
  user: CurrentUser | null;
  errorMessage: string | null;

  /** Wires up the Supabase auth listener. Call once at app startup. */
  initialize: () => () => void; // returns an unsubscribe function

  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;

  /** True if the current user's role is in the allowed list, or agency_admin. */
  hasRole: (...roles: UserRole[]) => boolean;
}

const API_BASE = import.meta.env.VITE_API_URL ?? '';

async function fetchCurrentUser(accessToken: string): Promise<CurrentUser> {
  const response = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? 'This account is not authorized to access theslotbot.'
        : `Failed to load account details (${response.status})`,
    );
  }

  const body = (await response.json()) as {
    success: boolean;
    data?: { id: string; email: string; name: string; role: UserRole; salonId: string | null };
  };

  if (!body.success || !body.data) {
    throw new Error('This account is not authorized to access theslotbot.');
  }

  return body.data;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  session: null,
  user: null,
  errorMessage: null,

  initialize: () => {
    // Resolve the current session on load, then react to future changes
    // (sign-in, sign-out, token refresh) via Supabase's listener.
    supabase.auth.getSession().then(({ data }) => {
      void resolveSession(data.session, set);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      void resolveSession(session, set);
    });

    return () => listener.subscription.unsubscribe();
  },

  signIn: async (email: string, password: string) => {
    set({ status: 'loading', errorMessage: null });

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error || !data.session) {
      set({
        status: 'unauthenticated',
        session: null,
        user: null,
        errorMessage: error?.message ?? 'Sign in failed',
      });
      return;
    }

    await resolveSession(data.session, set);
  },

  signOut: async () => {
    await supabase.auth.signOut();
    set({ status: 'unauthenticated', session: null, user: null, errorMessage: null });
  },

  hasRole: (...roles: UserRole[]) => {
    const user = get().user;
    if (!user) return false;
    return user.role === UserRole.AGENCY_ADMIN || roles.includes(user.role);
  },
}));

/**
 * Shared resolution logic: given a Supabase session (or null), decide
 * the app's auth status. A session with no matching backend User row
 * results in 'unauthorized' — distinct from 'unauthenticated', so the
 * UI can show a clear "you're not invited" message rather than
 * silently bouncing back to the login form as if the password were wrong.
 */
async function resolveSession(
  session: Session | null,
  set: (partial: Partial<AuthState>) => void,
): Promise<void> {
  if (!session) {
    set({ status: 'unauthenticated', session: null, user: null });
    return;
  }

  try {
    const user = await fetchCurrentUser(session.access_token);
    set({ status: 'authenticated', session, user, errorMessage: null });
  } catch (err) {
    // Valid Supabase session, but not an invited theslotbot user (or
    // the backend call failed for another reason). Sign out of
    // Supabase too, so a stale session doesn't linger in the browser
    // pretending to be usable.
    await supabase.auth.signOut();
    set({
      status: 'unauthorized',
      session: null,
      user: null,
      errorMessage: err instanceof Error ? err.message : 'Authorization failed',
    });
  }
}
