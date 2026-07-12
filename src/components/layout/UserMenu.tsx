import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { useStore } from '../../store';
import { logout as apiLogout } from '../../services/authApi';
import { createOrg, type OrgRole } from '../../services/orgsApi';
import { FormField } from '../ui/FormField';
import { PlanBadge } from '../billing/PlanBadge';
import { shouldShowUpgradeEntry } from '../../services/proIntent';

const ROLE_COLORS: Record<OrgRole, string> = {
  owner: 'bg-coral/15 text-coral border-coral/30',
  admin: 'bg-gold/15 text-[#9c7100] border-gold/30',
  editor: 'bg-teal-light text-teal border-teal/30',
  viewer: 'bg-sand text-warm-gray border-sand',
};

export function RoleBadge({ role }: { role: OrgRole }) {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border ${ROLE_COLORS[role]}`}
    >
      {role}
    </span>
  );
}

function initialsFromName(nameOrEmail: string): string {
  const src = (nameOrEmail || '').trim();
  if (!src) return '?';
  if (src.includes('@')) {
    return src[0]!.toUpperCase();
  }
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * The list of menu items for the account / signed-in user — extracted so the
 * mobile hamburger can render them inside its own dropdown without duplicating
 * the markup. Each item invokes `onClose?.()` before navigating so the host
 * popover can dismiss. Renders the CreateOrgDialog modal as a sibling.
 */
export function UserMenuItems({ onClose }: { onClose?: () => void } = {}) {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const userOrgs = useStore((s) => s.userOrgs);
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const upsertUserOrg = useStore((s) => s.upsertUserOrg);
  const clearAuth = useStore((s) => s.clearAuth);
  const [showCreateOrg, setShowCreateOrg] = useState(false);
  const close = () => onClose?.();
  const go = (path: string) => { close(); navigate(path); };

  if (!currentUser) {
    return (
      <>
        <button
          onClick={() => go('/login')}
          className="w-full text-left px-3 py-2 rounded-md hover:bg-cream transition-colors"
        >
          <div className="text-sm font-heading font-bold text-coral">Sign in</div>
          <div className="text-[11px] text-warm-gray">Existing users</div>
        </button>
        <button
          onClick={() => go('/signup')}
          className="w-full text-left px-3 py-2 rounded-md hover:bg-cream transition-colors"
        >
          <div className="text-sm font-heading font-bold text-teal">Sign up</div>
          <div className="text-[11px] text-warm-gray">Create a new account</div>
        </button>
        <div className="border-t border-sand my-1" />
        <button
          onClick={() => go('/pricing')}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
        >
          Pricing &amp; plans
        </button>
        <a
          href="/about/"
          onClick={close}
          className="block w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
        >
          About
        </a>
      </>
    );
  }

  return (
    <>
      <div className="px-3 py-2 border-b border-sand mb-1">
        <div className="text-sm font-semibold text-dark-brown truncate">
          {currentUser.displayName}
        </div>
        <div className="text-xs text-warm-gray truncate">{currentUser.email}</div>
      </div>

      {/* Upgrade entry — logged-in free users only (hidden for agency/
          enterprise). Gives a free user who decides to pay a one-click path to
          /pricing instead of hunting through Billing. */}
      {shouldShowUpgradeEntry(true, currentUser.plan) && (
        <>
          <button
            onClick={() => go('/pricing')}
            className="w-full text-left px-3 py-2 mb-1 rounded-md bg-coral-light text-coral hover:bg-coral hover:text-white transition-colors flex items-center justify-between gap-2"
          >
            <span className="text-sm font-heading font-bold">Upgrade</span>
            <span aria-hidden>→</span>
          </button>
          <div className="border-t border-sand my-1" />
        </>
      )}

      <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
        Workspace
      </div>
      <button
        onClick={() => {
          setActiveWorkspace({ type: 'personal' });
          go('/feeds');
        }}
        className={`w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors flex items-center justify-between gap-2 ${
          activeWorkspace.type === 'personal'
            ? 'bg-cream text-dark-brown font-semibold'
            : 'text-dark-brown hover:bg-cream'
        }`}
      >
        <span className="truncate">My personal feeds</span>
        {activeWorkspace.type === 'personal' && <span className="text-coral text-xs">✓</span>}
      </button>
      {userOrgs.map((org) => {
        const active = activeWorkspace.type === 'org' && activeWorkspace.orgId === org.id;
        return (
          <button
            key={org.id}
            onClick={() => {
              setActiveWorkspace({ type: 'org', orgId: org.id, role: org.role });
              go('/feeds');
            }}
            className={`w-full text-left px-3 py-1.5 rounded-md text-sm transition-colors flex items-center justify-between gap-2 ${
              active ? 'bg-cream text-dark-brown font-semibold' : 'text-dark-brown hover:bg-cream'
            }`}
          >
            <span className="truncate flex-1">{org.name}</span>
            <RoleBadge role={org.role} />
          </button>
        );
      })}
      {currentUser.plan === 'agency' || currentUser.plan === 'enterprise' ? (
        <button
          onClick={() => setShowCreateOrg(true)}
          className="w-full text-left px-3 py-1.5 rounded-md text-sm text-coral hover:bg-cream transition-colors"
        >
          + Create organization…
        </button>
      ) : (
        <button
          onClick={() => go('/pricing?feature=org_workspace')}
          className="w-full text-left px-3 py-1.5 rounded-md text-sm text-coral hover:bg-cream transition-colors flex items-center justify-between gap-2"
          title="Organizations are a Planner plan feature"
        >
          <span>+ Create organization…</span>
          <span className="text-[10px] font-bold uppercase tracking-wide bg-cream text-warm-gray px-1.5 py-0.5 rounded border border-sand">
            Planner
          </span>
        </button>
      )}

      <div className="border-t border-sand my-1" />
      <button
        onClick={() => go('/feeds')}
        className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
      >
        My Feeds
      </button>
      <button
        onClick={() => go('/community')}
        className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors flex items-center justify-between gap-2"
      >
        <span>Community</span>
        <span className="text-[10px] font-bold uppercase tracking-wide bg-teal-light text-teal px-1.5 py-0.5 rounded">
          New
        </span>
      </button>
      <button
        onClick={() => go('/account')}
        className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
      >
        Account settings
      </button>
      <button
        onClick={() => go('/account/billing')}
        className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors flex items-center justify-between gap-2"
      >
        <span>Billing & plan</span>
        {currentUser.plan && currentUser.plan !== 'free' && (
          <PlanBadge plan={currentUser.plan} />
        )}
      </button>
      {activeWorkspace.type === 'org' &&
        (() => {
          const activeOrg = userOrgs.find((o) => o.id === activeWorkspace.orgId);
          if (!activeOrg) return null;
          return (
            <button
              onClick={() => go(`/orgs/${encodeURIComponent(activeOrg.slug)}`)}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors flex items-center justify-between gap-2"
            >
              <span>Organization settings &amp; billing</span>
              {activeOrg.plan && activeOrg.plan !== 'free' && <PlanBadge plan={activeOrg.plan} />}
            </button>
          );
        })()}
      {currentUser.staff && (
        <button
          onClick={() => go('/admin')}
          className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
        >
          Admin console
        </button>
      )}
      <button
        onClick={async () => {
          close();
          try { await apiLogout(); } catch { /* still clear local */ }
          clearAuth();
          navigate('/');
        }}
        className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
      >
        Sign out
      </button>

      {showCreateOrg && (
        <CreateOrgDialog
          onClose={() => setShowCreateOrg(false)}
          onCreated={(org) => {
            upsertUserOrg(org);
            setActiveWorkspace({ type: 'org', orgId: org.id, role: org.role });
            setShowCreateOrg(false);
            navigate('/feeds');
          }}
        />
      )}
    </>
  );
}

/**
 * Shared account menu — renders the signed-in user popover (workspace switcher,
 * My Feeds, Account settings, Admin console, Sign out) when there's a user,
 * or the "Sign in" CTA otherwise. Use this on every page that needs
 * consistent account navigation.
 */
export function UserMenu() {
  const currentUser = useStore((s) => s.currentUser);
  const triggerClasses = currentUser
    ? 'w-9 h-9 rounded-full bg-coral text-white font-heading font-bold text-sm flex items-center justify-center hover:bg-[#d4603a] transition-colors shrink-0'
    : 'w-9 h-9 rounded-full bg-white border-2 border-sand text-warm-gray hover:border-coral hover:text-coral transition-colors flex items-center justify-center shrink-0';
  return (
    <div className="flex items-center pl-2 sm:pl-3 ml-1 border-l border-sand h-9">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className={triggerClasses}
            title={currentUser ? currentUser.email : 'Sign in or sign up'}
            aria-label={currentUser ? 'Account menu' : 'Sign in or sign up'}
          >
            {currentUser ? initialsFromName(currentUser.displayName || currentUser.email) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
                <path d="M5 20c0-3.5 3-6.5 7-6.5s7 3 7 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            className={`bg-white rounded-xl shadow-lg border border-sand p-2 ${currentUser ? 'w-64' : 'w-56'} z-50`}
          >
            <UserMenuItems />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

function CreateOrgDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (org: {
    id: string;
    slug: string;
    name: string;
    role: OrgRole;
    memberCount: number;
    projectCount: number;
    createdAt: number;
  }) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const autoSlug = name
    .toLowerCase()
    .replace(/[^a-z0-9-\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 63);
  const effectiveSlug = slugTouched ? slug : autoSlug;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await createOrg({ slug: effectiveSlug, name: name.trim() });
      onCreated({ ...res.organization, memberCount: 1, projectCount: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create organization');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-lg p-5 max-w-sm w-full mx-4">
        <h3 className="font-heading font-bold text-base text-dark-brown mb-3">Create organization</h3>
        <form onSubmit={handleSubmit}>
          <FormField label="Name" value={name} onChange={setName} placeholder="Streamline Transit" required />
          <FormField
            label="Slug"
            value={effectiveSlug}
            onChange={(v) => {
              setSlug(v);
              setSlugTouched(true);
            }}
            placeholder="streamline-transit"
            required
          />
          {error && (
            <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 px-3 py-2 bg-sand text-brown rounded-lg font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !effectiveSlug}
              className="flex-1 px-3 py-2 bg-coral text-white rounded-lg font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors disabled:opacity-50"
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
