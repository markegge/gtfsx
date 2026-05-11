import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import { useStore } from '../../store';
import { logout as apiLogout } from '../../services/authApi';
import { createOrg, type OrgRole } from '../../services/orgsApi';
import { FormField } from '../ui/FormField';
import { backendEnabled } from '../../utils/featureFlags';

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
 * Shared account menu — renders the signed-in user popover (workspace switcher,
 * My Feeds, Account settings, Admin console, Sign out) when there's a user,
 * or the "Sign in" CTA otherwise. Use this on every page that needs
 * consistent account navigation.
 *
 * Returns null when backend features are disabled.
 */
export function UserMenu() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.currentUser);
  const userOrgs = useStore((s) => s.userOrgs);
  const activeWorkspace = useStore((s) => s.activeWorkspace);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const upsertUserOrg = useStore((s) => s.upsertUserOrg);
  const clearAuth = useStore((s) => s.clearAuth);
  const [showCreateOrg, setShowCreateOrg] = useState(false);

  if (!backendEnabled) return null;

  if (!currentUser) {
    return (
      <div className="flex items-center pl-2 sm:pl-3 ml-1 border-l border-sand h-9">
        <button
          onClick={() => navigate('/login')}
          title="Sign in"
          aria-label="Sign in"
          className="w-9 h-9 rounded-full bg-white border-2 border-sand text-warm-gray hover:border-coral hover:text-coral transition-colors flex items-center justify-center shrink-0"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
            <path
              d="M5 20c0-3.5 3-6.5 7-6.5s7 3 7 6.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center pl-2 sm:pl-3 ml-1 border-l border-sand h-9">
      <Popover.Root>
        <Popover.Trigger asChild>
          <button
            className="w-9 h-9 rounded-full bg-coral text-white font-heading font-bold text-sm flex items-center justify-center hover:bg-[#d4603a] transition-colors shrink-0"
            title={currentUser.email}
            aria-label="Account menu"
          >
            {initialsFromName(currentUser.displayName || currentUser.email)}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={8}
            className="bg-white rounded-xl shadow-lg border border-sand p-2 w-64 z-50"
          >
            <div className="px-3 py-2 border-b border-sand mb-1">
              <div className="text-sm font-semibold text-dark-brown truncate">
                {currentUser.displayName}
              </div>
              <div className="text-xs text-warm-gray truncate">{currentUser.email}</div>
            </div>

            <div className="px-3 pt-2 pb-1 text-[11px] font-semibold text-warm-gray uppercase tracking-wide">
              Workspace
            </div>
            <button
              onClick={() => {
                setActiveWorkspace({ type: 'personal' });
                navigate('/feeds');
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
                    navigate('/feeds');
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
            <button
              onClick={() => setShowCreateOrg(true)}
              className="w-full text-left px-3 py-1.5 rounded-md text-sm text-coral hover:bg-cream transition-colors"
            >
              + Create organization…
            </button>

            <div className="border-t border-sand my-1" />
            <button
              onClick={() => navigate('/feeds')}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
            >
              My Feeds
            </button>
            <button
              onClick={() => navigate('/account')}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
            >
              Account settings
            </button>
            {activeWorkspace.type === 'org' &&
              (() => {
                const activeOrg = userOrgs.find((o) => o.id === activeWorkspace.orgId);
                if (!activeOrg) return null;
                return (
                  <button
                    onClick={() => navigate(`/orgs/${encodeURIComponent(activeOrg.slug)}`)}
                    className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
                  >
                    Organization settings
                  </button>
                );
              })()}
            {currentUser.staff && (
              <button
                onClick={() => navigate('/admin')}
                className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
              >
                Admin console
              </button>
            )}
            <button
              onClick={async () => {
                try {
                  await apiLogout();
                } catch {
                  // ignore — still clear local state
                }
                clearAuth();
                navigate('/');
              }}
              className="w-full text-left px-3 py-2 rounded-md text-sm text-dark-brown hover:bg-cream transition-colors"
            >
              Sign out
            </button>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      </div>
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
