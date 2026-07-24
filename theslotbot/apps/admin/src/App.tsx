/**
 * src/App.tsx
 *
 * ROUTE STRUCTURE:
 *   /accept-invite   — PUBLIC. Rendered outside the auth gate entirely,
 *                       since someone accepting an invite has no
 *                       Supabase session yet by definition. This is
 *                       the one route in the whole app that doesn't
 *                       wait on useAuthStore's status.
 *   /                — everything else, gated on auth status. Once
 *                       authenticated, Layout + nested routes render.
 *
 * Auth gating for the protected routes happens once, here, exactly as
 * it did in Phase 4 — individual pages still never re-check auth
 * themselves.
 */

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import { Login } from '@/pages/Login';
import { AcceptInvite } from '@/pages/AcceptInvite';
import { Layout } from '@/components/Layout';
import { Dashboard } from '@/pages/Dashboard';
import { Slots } from '@/pages/Slots';
import { Reports } from '@/pages/Reports';
import { StaffManagement } from '@/pages/StaffManagement';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/accept-invite" element={<AcceptInvite />} />
        <Route path="/*" element={<AuthenticatedApp />} />
      </Routes>
    </BrowserRouter>
  );
}

function AuthenticatedApp() {
  const status = useAuthStore((s) => s.status);
  const errorMessage = useAuthStore((s) => s.errorMessage);
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    const unsubscribe = initialize();
    return unsubscribe;
  }, [initialize]);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-50">
        <p className="text-sm text-ink-500">Loading…</p>
      </div>
    );
  }

  if (status === 'unauthorized') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
        <div className="max-w-sm rounded-lg border border-status-noshow/30 bg-white p-6 text-center">
          <p className="text-sm font-medium text-ink-900">Not authorized</p>
          <p className="mt-2 text-sm text-ink-500">
            {errorMessage ?? 'This account is not authorized to access theslotbot.'}
          </p>
        </div>
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return <Login />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="slots" element={<Slots />} />
        <Route path="reports" element={<Reports />} />
        <Route path="staff" element={<StaffManagement />} />
      </Route>
    </Routes>
  );
}
