import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FormField } from '../ui/FormField';
import { Badge } from '../ui/Badge';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import {
  ApiError,
  changeEmail,
  changePassword,
  confirmTwofa,
  deleteAccount,
  disableTwofa,
  enableTwofa,
  getTwofa,
  logout,
  logoutAll,
  updateProfile,
  type TwofaStatus,
} from '../../services/authApi';
import {
  downloadMyExport,
  listMyAudit,
  type AuditEvent,
} from '../../services/distributionApi';
import { AuditTable } from '../audit/AuditTable';
import { useStore } from '../../store';

export function AccountSettingsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentUser = useStore((s) => s.currentUser);
  const authChecked = useStore((s) => s.authChecked);
  const setCurrentUser = useStore((s) => s.setCurrentUser);
  const clearAuth = useStore((s) => s.clearAuth);
  const hydrateAuth = useStore((s) => s.hydrateAuth);

  const emailChanged = searchParams.get('email_changed') === '1';

  useEffect(() => {
    if (!authChecked) hydrateAuth();
  }, [authChecked, hydrateAuth]);

  useEffect(() => {
    if (emailChanged) {
      hydrateAuth();
    }
  }, [emailChanged, hydrateAuth]);

  if (!authChecked) {
    return (
      <AuthLayout title="Account">
        <p className="text-sm text-warm-gray">Loading…</p>
      </AuthLayout>
    );
  }

  if (!currentUser) {
    return (
      <AuthLayout
        title="Sign in required"
        footer={
          <Link to="/login" className="text-coral font-semibold hover:underline">
            Sign in
          </Link>
        }
      >
        <p className="text-sm text-warm-gray">You need to sign in to view account settings.</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Account settings"
      subtitle={
        <span>
          Signed in as <span className="font-semibold text-dark-brown">{currentUser.email}</span>{' '}
          <StatusBadge status={currentUser.status} />
        </span>
      }
      footer={
        <Link to="/" className="text-coral font-semibold hover:underline">
          Back to editor
        </Link>
      }
    >
      {emailChanged && (
        <div className="mb-5 px-3 py-2 rounded-lg bg-teal-light text-teal text-sm flex items-center justify-between gap-3">
          <span>Email updated successfully.</span>
          <button
            onClick={() => {
              searchParams.delete('email_changed');
              setSearchParams(searchParams, { replace: true });
            }}
            className="text-teal hover:opacity-70"
          >
            ×
          </button>
        </div>
      )}

      <ProfileSection
        currentDisplayName={currentUser.displayName}
        onUpdated={(user) => setCurrentUser(user)}
      />
      <Divider />
      <ChangeEmailSection />
      <Divider />
      <ChangePasswordSection />
      <Divider />
      <TwoFactorSection email={currentUser.email} />
      <Divider />
      <SessionsSection onSignedOut={() => {
        clearAuth();
        navigate('/');
      }} />
      <Divider />
      <RecentActivitySection currentUserId={currentUser.id} />
      <Divider />
      <DataExportSection />
      <Divider />
      <DeleteAccountSection
        email={currentUser.email}
        onDeleted={() => {
          clearAuth();
          navigate('/');
        }}
      />
    </AuthLayout>
  );
}

function Divider() {
  return <div className="h-px bg-sand my-6" />;
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') return <Badge variant="success">Verified</Badge>;
  if (status === 'pending') return <Badge variant="warning">Unverified</Badge>;
  return <Badge variant="info">{status}</Badge>;
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h2 className="font-heading font-bold text-base text-dark-brown">{title}</h2>
      {description && <p className="text-xs text-warm-gray mt-0.5">{description}</p>}
    </div>
  );
}

function ProfileSection({
  currentDisplayName,
  onUpdated,
}: {
  currentDisplayName: string;
  onUpdated: (user: { id: string; email: string; displayName: string; status: string; staff: boolean }) => void;
}) {
  const [displayName, setDisplayName] = useState(currentDisplayName);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = displayName.trim() !== currentDisplayName && displayName.trim().length > 0;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const { user } = await updateProfile({ displayName: displayName.trim() });
      onUpdated(user);
      setSaved(true);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <SectionHeader title="Profile" />
      <form onSubmit={handleSave}>
        <FormField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          error={error ?? undefined}
          required
        />
        <div className="flex items-center gap-3">
          <AuthButton type="submit" disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save'}
          </AuthButton>
          {saved && <span className="text-sm text-teal">Saved.</span>}
        </div>
      </form>
    </section>
  );
}

function ChangeEmailSection() {
  const [newEmail, setNewEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await changeEmail({ newEmail: newEmail.trim() });
      setSent(true);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not submit';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Change email"
        description="We'll send a confirmation link to your new address."
      />
      {sent ? (
        <div className="px-3 py-2 rounded-lg bg-teal-light text-teal text-sm">
          Check your new inbox ({newEmail.trim()}) to confirm the change.
        </div>
      ) : (
        <form onSubmit={handleSubmit}>
          <FormField
            label="New email"
            type="email"
            value={newEmail}
            onChange={setNewEmail}
            placeholder="new-email@example.com"
            required
            error={error ?? undefined}
          />
          <AuthButton type="submit" disabled={submitting || !newEmail}>
            {submitting ? 'Sending…' : 'Send confirmation'}
          </AuthButton>
        </form>
      )}
    </section>
  );
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      await changePassword({ currentPassword, newPassword });
      setSaved(true);
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not change password';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <SectionHeader title="Change password" />
      <form onSubmit={handleSave}>
        <FormField
          label="Current password"
          type="password"
          value={currentPassword}
          onChange={setCurrentPassword}
          required
        />
        <FormField
          label="New password"
          type="password"
          value={newPassword}
          onChange={setNewPassword}
          required
          error={error ?? undefined}
        />
        <div className="flex items-center gap-3">
          <AuthButton type="submit" disabled={saving || !currentPassword || !newPassword}>
            {saving ? 'Saving…' : 'Change password'}
          </AuthButton>
          {saved && <span className="text-sm text-teal">Password updated.</span>}
        </div>
      </form>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Two-factor authentication — optional, off by default. Email codes only for
// now; SMS is shown as a disabled option until Twilio Verify is wired up.
// ───────────────────────────────────────────────────────────────────────────

function TwoFactorSection({ email }: { email: string }) {
  const [status, setStatus] = useState<TwofaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [pending, setPending] = useState<'enroll' | 'disable' | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await getTwofa());
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load two-factor status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startEnable = async () => {
    setActionError(null);
    setNotice(null);
    setWorking(true);
    try {
      const res = await enableTwofa({ method: 'email' });
      setChallenge(res.challenge);
      setPending('enroll');
      setCode('');
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not start enrollment');
    } finally {
      setWorking(false);
    }
  };

  const startDisable = async () => {
    setActionError(null);
    setNotice(null);
    setWorking(true);
    try {
      const res = await disableTwofa();
      setChallenge(res.challenge);
      setPending('disable');
      setCode('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'twofa_org_required') {
        setActionError("Your organization requires two-factor authentication, so it can't be turned off here.");
      } else {
        setActionError(err instanceof ApiError ? err.message : 'Could not start');
      }
    } finally {
      setWorking(false);
    }
  };

  const cancelPending = () => {
    setPending(null);
    setChallenge(null);
    setCode('');
    setActionError(null);
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pending || !challenge) return;
    setActionError(null);
    setWorking(true);
    try {
      await confirmTwofa({ challenge, code: code.trim() });
      setNotice(pending === 'enroll' ? 'Two-factor authentication is on.' : 'Two-factor authentication is off.');
      setPending(null);
      setChallenge(null);
      setCode('');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'twofa_invalid_code') {
        const attemptsLeft = typeof err.extra.attempts_left === 'number' ? err.extra.attempts_left : undefined;
        setActionError(
          attemptsLeft !== undefined
            ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`
            : 'Incorrect code.',
        );
        setCode('');
      } else if (err instanceof ApiError && err.code === 'twofa_expired') {
        setActionError('That code expired. Start again.');
        setPending(null);
        setChallenge(null);
      } else {
        setActionError(err instanceof ApiError ? err.message : 'Could not confirm');
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Two-factor authentication"
        description="Add a one-time code to your sign-in, sent by email. Optional, and off by default."
      />
      {loading && <p className="text-sm text-warm-gray">Loading…</p>}
      {loadError && (
        <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">{loadError}</div>
      )}
      {!loading && !loadError && status && (
        <>
          {status.org_required && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
              Your organization requires two-factor authentication for all members.
              {status.method === 'none' && " You'll be emailed a code the next time you sign in."}
            </div>
          )}
          {notice && !pending && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-teal-light text-teal text-sm">{notice}</div>
          )}
          {actionError && !pending && (
            <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
              {actionError}
            </div>
          )}

          {pending ? (
            <form onSubmit={handleConfirm} className="border border-sand rounded-lg p-4 bg-cream">
              <p className="text-sm text-dark-brown mb-3">
                Enter the 6-digit code we sent to <span className="font-mono">{email}</span>.
              </p>
              <FormField label="Verification code" error={actionError ?? undefined}>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  className="w-full px-3 py-2 border-2 rounded-lg text-lg font-mono tracking-[0.4em] text-center text-dark-brown bg-cream transition-colors border-sand focus:outline-none focus:border-coral focus:bg-white"
                />
              </FormField>
              <div className="flex items-center gap-3">
                <AuthButton type="submit" disabled={working || code.length !== 6}>
                  {working ? 'Confirming…' : pending === 'enroll' ? 'Turn on' : 'Turn off'}
                </AuthButton>
                <AuthButton type="button" variant="secondary" onClick={cancelPending} disabled={working}>
                  Cancel
                </AuthButton>
              </div>
            </form>
          ) : status.method === 'none' ? (
            <div>
              <div className="space-y-2 mb-3">
                <label className="flex items-center gap-2 text-sm text-dark-brown">
                  <input type="radio" name="twofa-method" checked readOnly />
                  Email code
                </label>
                <label className="flex items-center gap-2 text-sm text-warm-gray cursor-not-allowed">
                  <input type="radio" name="twofa-method" disabled />
                  Text message (coming soon)
                </label>
              </div>
              <AuthButton onClick={startEnable} disabled={working}>
                {working ? 'Starting…' : 'Enable two-factor authentication'}
              </AuthButton>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="success">On</Badge>
                <span className="text-sm text-dark-brown">Email code</span>
              </div>
              <AuthButton variant="secondary" onClick={startDisable} disabled={working || status.org_required}>
                {working ? 'Starting…' : 'Disable'}
              </AuthButton>
              {status.org_required && (
                <p className="mt-2 text-xs text-warm-gray">
                  Your organization requires 2FA, so it can't be turned off here.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SessionsSection({ onSignedOut }: { onSignedOut: () => void }) {
  const [signingOut, setSigningOut] = useState(false);
  const [signingOutAll, setSigningOutAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = async () => {
    setError(null);
    setSigningOut(true);
    try {
      await logout();
      onSignedOut();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not sign out';
      setError(msg);
    } finally {
      setSigningOut(false);
    }
  };

  const handleSignOutAll = async () => {
    setError(null);
    setSigningOutAll(true);
    try {
      await logoutAll();
      onSignedOut();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not sign out of all devices';
      setError(msg);
    } finally {
      setSigningOutAll(false);
    }
  };

  return (
    <section>
      <SectionHeader title="Sessions" />
      {error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <AuthButton variant="secondary" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </AuthButton>
        <AuthButton variant="secondary" onClick={handleSignOutAll} disabled={signingOutAll}>
          {signingOutAll ? 'Working…' : 'Sign out of all devices'}
        </AuthButton>
      </div>
    </section>
  );
}

function DeleteAccountSection({
  email,
  onDeleted,
}: {
  email: string;
  onDeleted: () => void;
}) {
  const [step, setStep] = useState<'idle' | 'confirm'>('idle');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [password, setPassword] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emailMatches = confirmEmail.trim().toLowerCase() === email.toLowerCase();

  const handleDelete = async () => {
    setError(null);
    setWorking(true);
    try {
      await deleteAccount(password ? { password } : {});
      onDeleted();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not delete account';
      setError(msg);
    } finally {
      setWorking(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Delete account"
        description="Your data will be permanently removed 30 days after deletion (grace period). Published feeds remain available unless you take them down. Sign back in within 30 days to cancel."
      />
      {step === 'idle' ? (
        <AuthButton variant="danger" onClick={() => setStep('confirm')}>
          Delete my account
        </AuthButton>
      ) : (
        <div className="border-2 border-red-300 rounded-lg p-4 bg-red-50">
          <p className="text-sm text-dark-brown mb-3">
            Type <span className="font-semibold">{email}</span> to confirm. This will sign you out of all
            devices.
          </p>
          <FormField
            label="Your email"
            type="email"
            value={confirmEmail}
            onChange={setConfirmEmail}
            placeholder={email}
          />
          <FormField
            label="Password (optional — required if you use password login)"
            type="password"
            value={password}
            onChange={setPassword}
            error={error ?? undefined}
          />
          <div className="flex gap-2">
            <AuthButton
              variant="secondary"
              onClick={() => {
                setStep('idle');
                setConfirmEmail('');
                setPassword('');
                setError(null);
              }}
            >
              Cancel
            </AuthButton>
            <AuthButton variant="danger" onClick={handleDelete} disabled={!emailMatches || working}>
              {working ? 'Deleting…' : 'Permanently delete'}
            </AuthButton>
          </div>
        </div>
      )}
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Recent activity — last 50 events visible to this user. Modal expands to
// the same data (pagination happens inside).
// ───────────────────────────────────────────────────────────────────────────

function RecentActivitySection({ currentUserId }: { currentUserId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listMyAudit({ limit: 50 });
      setEvents(res.events);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load activity');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section>
      <SectionHeader
        title="Recent activity"
        description="The most recent audit events tied to your account and feeds."
      />
      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
      <div className="border border-sand rounded-lg overflow-hidden">
        {loading && events.length === 0 ? (
          <p className="p-4 text-sm text-warm-gray">Loading…</p>
        ) : (
          <div className="max-h-80 overflow-auto">
            <AuditTable
              events={events.slice(0, 10)}
              currentUserId={currentUserId}
              compact
            />
          </div>
        )}
      </div>
      {events.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setExpanded(true)}
            className="text-sm text-coral font-semibold hover:underline"
          >
            View all
          </button>
        </div>
      )}

      {expanded && (
        <ActivityModal
          events={events}
          currentUserId={currentUserId}
          onClose={() => setExpanded(false)}
        />
      )}
    </section>
  );
}

function ActivityModal({
  events,
  currentUserId,
  onClose,
}: {
  events: AuditEvent[];
  currentUserId: string;
  onClose: () => void;
}) {
  const [allEvents, setAllEvents] = useState<AuditEvent[]>(events);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(events.length < 50);

  const loadMore = async () => {
    if (allEvents.length === 0 || done) return;
    setLoadingMore(true);
    setError(null);
    try {
      const last = allEvents[allEvents.length - 1];
      const res = await listMyAudit({ limit: 50, before: last.id });
      setAllEvents((prev) => [...prev, ...res.events]);
      if (res.events.length < 50) setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load more');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-lg w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-sand">
          <h3 className="font-heading font-bold text-lg text-dark-brown">Recent activity</h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded hover:bg-sand text-warm-gray"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          <AuditTable events={allEvents} currentUserId={currentUserId} />
          {error && (
            <div className="mx-4 my-2 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
              {error}
            </div>
          )}
          {!done && (
            <div className="flex justify-center py-3">
              <AuthButton variant="secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </AuthButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Data export — "Download all my data" button. Streams a ZIP from the
// server; rate-limited to 1 per 24 hours (server enforces, we surface the
// 429 message).
// ───────────────────────────────────────────────────────────────────────────

function DataExportSection() {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleExport = async () => {
    setWorking(true);
    setError(null);
    setDone(false);
    try {
      await downloadMyExport();
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'rate_limited') {
          setError(err.message || 'Data export limit: 1 per 24 hours. Try again later.');
        } else {
          setError(err.message);
        }
      } else {
        setError('Could not prepare export');
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Download your data"
        description="Get a ZIP of your profile, audit history, and every feed you own. Available once per 24 hours."
      />
      {error && (
        <div className="mb-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
      {done && !error && (
        <div className="mb-3 px-3 py-2 rounded-lg bg-teal-light text-teal text-sm">
          Export ready — check your downloads.
        </div>
      )}
      <AuthButton onClick={handleExport} disabled={working}>
        {working ? 'Preparing your export…' : 'Download all my data'}
      </AuthButton>
    </section>
  );
}
