/**
 * src/pages/StaffManagement.tsx
 *
 * Minimal, per the Phase 5 brief: a roster, an invite form, a
 * copyable link. No invite list/revoke UI yet (see auth.ts's scope
 * note on the backend) — an owner who mistypes an email currently has
 * to wait out the 72-hour expiry, which is a known gap, not an
 * oversight.
 *
 * ROLE-RESTRICTED INVITE FORM:
 * salon_owner only sees "Staff member" as the role (no dropdown —
 * there's only one legal choice, so we don't render a picker with one
 * option). agency_admin sees a real dropdown across all three roles.
 * This mirrors ROLES_INVITABLE_BY on the backend exactly, but is a UX
 * courtesy — the backend enforces the actual restriction regardless.
 */

import { useState, FormEvent } from 'react';
import { Copy, Check } from 'lucide-react';
import { UserRole } from '@theslotbot/shared/types';
import type { CreateInviteResponseDto } from '@theslotbot/shared/types';
import { useTeam, useCreateInvite } from '@/hooks/useStaff';
import { useAuthStore } from '@/stores/auth.store';
import { ApiError } from '@/api/client';

const ROLE_LABELS: Record<UserRole, string> = {
  [UserRole.AGENCY_ADMIN]: 'Agency admin',
  [UserRole.SALON_OWNER]: 'Salon owner',
  [UserRole.SALON_STAFF]: 'Staff member',
};

export function StaffManagement() {
  const { data: team, isLoading } = useTeam();

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-ink-900">Staff</h1>
        <p className="mt-1 text-sm text-ink-500">
          Invite team members and see who currently has access.
        </p>
      </header>

      <InviteForm />

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-ink-900">Current team</h2>
        {isLoading && <p className="text-sm text-ink-500">Loading…</p>}
        {team && (
          <div className="overflow-hidden rounded-lg border border-ink-200 bg-white">
            {team.map((member) => (
              <div
                key={member.id}
                className="flex items-center justify-between border-b border-ink-100 px-4 py-3 last:border-b-0"
              >
                <div>
                  <p className="text-sm font-medium text-ink-900">{member.name}</p>
                  <p className="text-xs text-ink-500">{member.email}</p>
                </div>
                <span className="rounded-full bg-ink-100 px-2.5 py-0.5 text-xs font-medium text-ink-600">
                  {ROLE_LABELS[member.role]}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function InviteForm() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UserRole>(UserRole.SALON_STAFF);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateInviteResponseDto | null>(null);
  const [copied, setCopied] = useState(false);

  const currentUser = useAuthStore((s) => s.user);
  const isAgencyAdmin = currentUser?.role === UserRole.AGENCY_ADMIN;
  const createInvite = useCreateInvite();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);
    setCopied(false);

    try {
      const invite = await createInvite.mutateAsync({ email, role });
      setResult(invite);
      setEmail('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create invite.');
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    await navigator.clipboard.writeText(result.inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-ink-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-ink-900">Invite someone</h2>

      <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <label htmlFor="invite-email" className="block text-xs font-medium text-ink-600">
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-ink-200 px-3 py-1.5 text-sm focus:border-accent"
          />
        </div>

        {isAgencyAdmin ? (
          <div>
            <label htmlFor="invite-role" className="block text-xs font-medium text-ink-600">
              Role
            </label>
            <select
              id="invite-role"
              value={role}
              onChange={(e) => setRole(e.target.value as UserRole)}
              className="mt-1 rounded-md border border-ink-200 px-3 py-1.5 text-sm"
            >
              {Object.values(UserRole).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        ) : (
          // salon_owner can only invite staff — no picker needed for one option.
          <input type="hidden" value={UserRole.SALON_STAFF} readOnly />
        )}

        <button
          type="submit"
          disabled={createInvite.isPending}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {createInvite.isPending ? 'Sending…' : 'Generate invite'}
        </button>
      </form>

      {error && (
        <p className="mt-3 rounded-md bg-status-noshow/10 px-3 py-2 text-sm text-status-noshow">
          {error}
        </p>
      )}

      {result && (
        <div className="mt-3 rounded-md bg-status-completed/10 px-3 py-2">
          <p className="text-xs text-ink-600">
            Invite created for <strong>{result.email}</strong> — share this link with them.
            It expires {new Date(result.expiresAt).toLocaleDateString('en-IN')}.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-white px-2 py-1 text-xs text-ink-700">
              {result.inviteUrl}
            </code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="flex items-center gap-1 rounded-md bg-white px-2 py-1 text-xs font-medium text-ink-700 hover:bg-ink-50"
            >
              {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
