/**
 * src/components/Layout.tsx
 *
 * Nav visibility follows the same role rules the backend enforces —
 * Reports and Staff links only render for salon_owner+. This is a UX
 * courtesy, not a security boundary: the backend rejects the request
 * regardless of whether the link was visible, so hiding a link here
 * never substitutes for the requireRole guard on the actual route.
 */

import { NavLink, Outlet } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { UserRole } from '@theslotbot/shared/types';
import { useAuthStore } from '@/stores/auth.store';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? 'bg-accent/10 text-accent' : 'text-ink-600 hover:bg-ink-100'
  }`;

export function Layout() {
  const user = useAuthStore((s) => s.user);
  const hasRole = useAuthStore((s) => s.hasRole);
  const signOut = useAuthStore((s) => s.signOut);

  return (
    <div className="min-h-screen bg-ink-50">
      <nav className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
          <div className="flex items-center gap-1">
            <span className="mr-4 text-sm font-semibold text-ink-900">theslotbot</span>
            <NavLink to="/" end className={navLinkClass}>
              Dashboard
            </NavLink>
            <NavLink to="/slots" className={navLinkClass}>
              Slots
            </NavLink>
            {hasRole(UserRole.SALON_OWNER) && (
              <>
                <NavLink to="/reports" className={navLinkClass}>
                  Reports
                </NavLink>
                <NavLink to="/staff" className={navLinkClass}>
                  Staff
                </NavLink>
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-ink-500">{user?.name}</span>
            <button
              type="button"
              onClick={() => void signOut()}
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-500 hover:bg-ink-100"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <Outlet />
    </div>
  );
}
