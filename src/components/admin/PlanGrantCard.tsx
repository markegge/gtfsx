import { useState } from 'react';
import { AuthButton } from '../auth/AuthButton';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from './adminShared';
import { PlanPill } from './AdminUsersPage';
import { planDisplayName } from '../billing/planConfig';
import {
  EXPIRY_OPTIONS,
  customDateToTimestamp,
  describeExpiry,
  expiryToTimestamp,
} from './planGrant';
import {
  grantOrgPlan,
  grantUserPlan,
  revokeOrgPlan,
  revokeUserPlan,
  type GrantPlan,
  type Plan,
  type PlanStatus,
} from '../../services/adminApi';
import { ApiError } from '../../services/authApi';

// Staff-only control to comp-grant a time-limited Agency/Enterprise plan to a
// user or org (no Stripe), show the current grant, and revoke it. Rendered on
// the admin user + org detail pages, which are already staff-gated.
export function PlanGrantCard({
  kind,
  id,
  plan,
  planStatus,
  planExpiresAt,
  onChanged,
}: {
  kind: 'user' | 'org';
  id: string;
  plan: Plan;
  planStatus: PlanStatus;
  planExpiresAt: number | null;
  onChanged: () => void | Promise<void>;
}) {
  const [showGrant, setShowGrant] = useState(false);
  const [showRevoke, setShowRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const granted = plan !== 'free';
  const label = kind === 'user' ? 'user' : 'organization';

  const onGrant = async (input: { plan: GrantPlan; expiresAt: number | null; note?: string }) => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'user') await grantUserPlan(id, input);
      else await grantOrgPlan(id, input);
      setShowGrant(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Grant failed');
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'user') await revokeUserPlan(id);
      else await revokeOrgPlan(id);
      setShowRevoke(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Revoke failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3 className="font-heading font-bold text-lg text-dark-brown mb-3">Plan &amp; billing</h3>
      <div className="bg-white border border-sand rounded-2xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <PlanPill plan={plan} planStatus={planStatus} />
              <span className="text-sm text-warm-gray">{describeExpiry(planExpiresAt)}</span>
            </div>
            <p className="text-xs text-warm-gray max-w-md">
              Comp grants bypass Stripe. A grant with an expiry auto-reverts this {label} to Free
              on its date; “No expiry” stays until revoked.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AuthButton
              variant="secondary"
              onClick={() => {
                setError(null);
                setShowGrant(true);
              }}
            >
              {granted ? 'Change plan' : 'Grant plan'}
            </AuthButton>
            {granted && (
              <AuthButton
                variant="danger"
                onClick={() => {
                  setError(null);
                  setShowRevoke(true);
                }}
              >
                Revoke
              </AuthButton>
            )}
          </div>
        </div>
        {error && !showGrant && !showRevoke && (
          <p className="mt-3 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
            {error}
          </p>
        )}
      </div>

      {showGrant && (
        <PlanGrantDialog
          label={label}
          defaultPlan={plan === 'agency' || plan === 'enterprise' ? plan : 'enterprise'}
          busy={busy}
          error={error}
          onCancel={() => {
            setShowGrant(false);
            setError(null);
          }}
          onConfirm={onGrant}
        />
      )}

      {showRevoke && (
        <ConfirmDialog
          title="Revoke plan grant?"
          body={
            <>
              <p className="mb-2">
                This {label} will drop back to <strong>Free</strong> immediately. Stripe is not
                involved.
              </p>
              {error && (
                <p className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                  {error}
                </p>
              )}
            </>
          }
          confirmLabel="Revoke"
          danger
          busy={busy}
          onCancel={() => {
            setShowRevoke(false);
            setError(null);
          }}
          onConfirm={onRevoke}
        />
      )}
    </section>
  );
}

const GRANT_PLANS: GrantPlan[] = ['agency', 'enterprise'];

function PlanGrantDialog({
  label,
  defaultPlan,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  label: string;
  defaultPlan: GrantPlan;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (input: { plan: GrantPlan; expiresAt: number | null; note?: string }) => void;
}) {
  const [plan, setPlan] = useState<GrantPlan>(defaultPlan);
  // Index into EXPIRY_OPTIONS, or 'custom'.
  const [expiryChoice, setExpiryChoice] = useState<string>('1'); // default 30 days
  const [customDate, setCustomDate] = useState('');
  const [note, setNote] = useState('');

  const isCustom = expiryChoice === 'custom';
  const expiresAt = isCustom
    ? customDateToTimestamp(customDate)
    : expiryToTimestamp(EXPIRY_OPTIONS[Number(expiryChoice)]?.days ?? null);
  const customInvalid = isCustom && customDate !== '' && expiresAt === null;

  const submit = () => {
    if (busy) return;
    if (isCustom && customDate === '') return;
    onConfirm({ plan, expiresAt, note: note.trim() || undefined });
  };

  return (
    <Modal
      open
      onClose={onCancel}
      dismissable={!busy}
      maxWidthClassName="max-w-md"
      title="Grant plan"
      description={`Comp this ${label} a plan with no Stripe subscription.`}
      footer={
        <>
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </AuthButton>
          <AuthButton
            variant="primary"
            onClick={submit}
            disabled={busy || customInvalid || (isCustom && customDate === '')}
          >
            {busy ? 'Working…' : `Grant ${planDisplayName(plan)}`}
          </AuthButton>
        </>
      }
    >
      <label className="block text-xs font-semibold uppercase tracking-wide text-warm-gray mb-1">
        Plan
      </label>
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as GrantPlan)}
          disabled={busy}
          className="w-full mb-4 px-3 py-2 border border-sand rounded-lg bg-white text-sm text-dark-brown focus:outline-none focus:border-coral"
        >
          {GRANT_PLANS.map((p) => (
            <option key={p} value={p}>
              {planDisplayName(p)}
            </option>
          ))}
        </select>

        <label className="block text-xs font-semibold uppercase tracking-wide text-warm-gray mb-1">
          Expires
        </label>
        <select
          value={expiryChoice}
          onChange={(e) => setExpiryChoice(e.target.value)}
          disabled={busy}
          className="w-full mb-2 px-3 py-2 border border-sand rounded-lg bg-white text-sm text-dark-brown focus:outline-none focus:border-coral"
        >
          {EXPIRY_OPTIONS.map((opt, i) => (
            <option key={opt.label} value={String(i)}>
              {opt.label}
            </option>
          ))}
          <option value="custom">Custom date…</option>
        </select>
        {isCustom && (
          <input
            type="date"
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            disabled={busy}
            className="w-full mb-2 px-3 py-2 border border-sand rounded-lg bg-white text-sm text-dark-brown focus:outline-none focus:border-coral"
          />
        )}
        <p className="text-xs text-warm-gray mb-4">
          {expiresAt === null
            ? isCustom
              ? 'Pick a date.'
              : 'No expiry — stays until revoked.'
            : describeExpiry(expiresAt)}
        </p>

        <label className="block text-xs font-semibold uppercase tracking-wide text-warm-gray mb-1">
          Note <span className="normal-case font-normal">(optional)</span>
        </label>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
          maxLength={500}
          placeholder="e.g. pilot through Q3"
          className="w-full mb-4 px-3 py-2 border border-sand rounded-lg bg-white text-sm text-dark-brown focus:outline-none focus:border-coral"
        />

        {error && (
          <p className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
            {error}
          </p>
        )}
    </Modal>
  );
}
