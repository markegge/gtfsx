import { NavLink, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useStore } from '../../store';
import { NotFoundPage } from '../misc/NotFoundPage';
import { AppBrand } from '../layout/AppBrand';
import { UserMenu } from '../layout/UserMenu';

interface AdminLayoutProps {
  title?: string;
  subtitle?: ReactNode;
  children: ReactNode;
  headerExtra?: ReactNode;
}

const NAV_ITEMS = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/orgs', label: 'Organizations' },
  { to: '/admin/audit', label: 'Audit log' },
  { to: '/admin/events', label: 'Events' },
];

export function AdminLayout({ title, subtitle, children, headerExtra }: AdminLayoutProps) {
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const navigate = useNavigate();

  if (!authChecked) {
    return (
      <div className="min-h-full bg-cream flex items-center justify-center">
        <p className="text-sm text-warm-gray">Loading…</p>
      </div>
    );
  }

  if (!currentUser || currentUser.staff !== true) {
    return <NotFoundPage />;
  }

  return (
    <div className="min-h-full bg-cream flex flex-col">
      <header className="h-14 bg-white border-b border-sand flex items-center px-3 sm:px-5 shrink-0 gap-2 sm:gap-3">
        <AppBrand mode="link" showTagline={false} />
        <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide bg-dark-brown text-white whitespace-nowrap">
          Admin
        </span>
        <div className="flex-1" />
        <button
          onClick={() => navigate('/feeds')}
          className="text-sm text-warm-gray hover:text-coral transition-colors whitespace-nowrap"
        >
          Exit admin
        </button>
        <UserMenu />
      </header>

      <div className="flex-1 flex">
        <nav className="w-56 border-r border-sand bg-white/60 py-5 px-3 shrink-0">
          <div className="px-3 mb-3 text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
            Console
          </div>
          <ul className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `block px-3 py-2 rounded-md text-sm font-semibold transition-colors ${
                      isActive
                        ? 'bg-coral text-white'
                        : 'text-dark-brown hover:bg-cream'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
          <div className="mt-6 px-3 text-[11px] text-warm-gray leading-relaxed">
            Signed in as<br />
            <span className="font-semibold text-dark-brown">{currentUser.email}</span>
          </div>
        </nav>

        <main className="flex-1 px-8 py-8 overflow-y-auto">
          {(title || headerExtra) && (
            <div className="flex items-start justify-between mb-6 gap-4">
              <div>
                {title && (
                  <h1 className="font-heading font-extrabold text-3xl text-dark-brown">
                    {title}
                  </h1>
                )}
                {subtitle && (
                  <div className="text-sm text-warm-gray mt-1">{subtitle}</div>
                )}
              </div>
              {headerExtra && <div className="shrink-0">{headerExtra}</div>}
            </div>
          )}
          {children}
        </main>
      </div>
    </div>
  );
}
