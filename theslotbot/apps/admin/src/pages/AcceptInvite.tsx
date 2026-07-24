/**
 * src/pages/AcceptInvite.tsx
 *
 * Reads ?token= from the URL, collects name + password, and calls
 * POST /api/auth/invite/accept. This does NOT call supabase.auth
 * directly — account creation only happens server-side, in
 * invite.service.ts, which is the one place in the whole system that
 * calls the Supabase Admin API to create a user. This page is purely
 * the form; it has no capability to create an account on its own.
 *
 * On success, redirects to the login page rather than attempting to
 * auto-sign-in — keeping the "how do I get a session" logic in exactly
 * one place (Login.tsx / auth.store.ts) rather than duplicating a
 * sign-in flow here.
 */

import { useState, FormEvent, ReactNode } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { apiClient, ApiError } from '@/api/client';
import type { CurrentUserDto } from '@theslotbot/shared/types';

export function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!token) {
    return (
      <CenteredCard>
        <p className="text-sm font-medium text-status-noshow">Invalid invite link</p>
        <p className="mt-2 text-sm text-ink-500">
          This link is missing its invite token. Ask whoever invited you to send a new link.
        </p>
      </CenteredCard>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }

    setSubmitting(true);
    try {
      await apiClient.post<CurrentUserDto>('/auth/invite/accept', { token, password, name });
      setSuccess(true);
      setTimeout(() => navigate('/'), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <CenteredCard>
        <p className="text-sm font-medium text-status-completed">Account created!</p>
        <p className="mt-2 text-sm text-ink-500">Redirecting you to sign in…</p>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard>
      <h1 className="text-lg font-semibold text-ink-900">Set up your account</h1>
      <p className="mt-1 text-sm text-ink-500">You've been invited to join theslotbot.</p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-ink-700">
            Your name
          </label>
          <input
            id="name"
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
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
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
          />
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-sm font-medium text-ink-700">
            Confirm password
          </label>
          <input
            id="confirmPassword"
            type="password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent"
          />
        </div>

        {error && (
          <p className="rounded-md bg-status-noshow/10 px-3 py-2 text-sm text-status-noshow">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-ink-200 bg-white p-6">
        {children}
      </div>
    </div>
  );
}
