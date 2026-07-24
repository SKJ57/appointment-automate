/**
 * src/pages/Login.tsx
 *
 * Deliberately has no "Sign up" link, no "Forgot password → create
 * account" fallback, nothing that implies self-registration is
 * possible. This is not an oversight — it's the visible half of the
 * invite-only enforcement. The only way to get an account is an email
 * invite from a salon_owner or agency_admin (accepted via a separate,
 * token-gated route not linked from here).
 */

import { useState, FormEvent } from 'react';
import { useAuthStore } from '@/stores/auth.store';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { signIn, status, errorMessage } = useAuthStore();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void signIn(email, password);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold text-ink-900">theslotbot</h1>
          <p className="mt-1 text-sm text-ink-500">Sign in to your salon's admin panel</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-ink-200 bg-white p-6">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink-700">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink-700">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
            />
          </div>

          {errorMessage && (
            <p className="rounded-md bg-status-noshow/10 px-3 py-2 text-sm text-status-noshow">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={status === 'loading'}
            className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {status === 'loading' ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-400">
          Access is by invitation only. Contact your salon owner if you need an account.
        </p>
      </div>
    </div>
  );
}
