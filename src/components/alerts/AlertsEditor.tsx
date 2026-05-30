import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  listAlerts,
  createAlert,
  updateAlert,
  setAlertStatus,
  deleteAlert,
  adoptManagedAlertsFeed,
  CAUSE_OPTIONS,
  EFFECT_OPTIONS,
  SEVERITY_OPTIONS,
  type ServiceAlert,
  type AlertInput,
  type ActivePeriod,
  type InformedEntity,
  type RtCoexistence,
} from '../../services/alertsApi';
import { ApiError } from '../../services/authApi';

// ─── datetime-local ⇄ epoch-seconds helpers ──────────────────────────────────

function toLocalInput(sec: number | null | undefined): string {
  if (sec == null) return '';
  const d = new Date(sec * 1000);
  // Render in the browser's local zone as the value <input type=datetime-local> expects.
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function periodLabel(p: ActivePeriod): string {
  const fmt = (s: number) => new Date(s * 1000).toLocaleString();
  if (p.start != null && p.end != null) return `${fmt(p.start)} → ${fmt(p.end)}`;
  if (p.start != null) return `From ${fmt(p.start)}`;
  if (p.end != null) return `Until ${fmt(p.end)}`;
  return 'Always active';
}

function isCurrentlyActive(a: ServiceAlert, nowSec: number): boolean {
  if (a.status !== 'active') return false;
  if (a.active_periods.length === 0) return true;
  return a.active_periods.some((p) => {
    if (p.start != null && nowSec < p.start) return false;
    if (p.end != null && nowSec >= p.end) return false;
    return true;
  });
}

// ─── Entity selector type ─────────────────────────────────────────────────────

type EntityKind = 'route' | 'stop' | 'agency';

function entityKind(e: InformedEntity): EntityKind {
  if (e.stop_id) return 'stop';
  if (e.route_id) return 'route';
  return 'agency';
}

const EMPTY_INPUT: AlertInput = {
  cause: 'UNKNOWN_CAUSE',
  effect: 'SIGNIFICANT_DELAYS',
  severity_level: 'WARNING',
  header_text: '',
  description_text: '',
  url: '',
  active_periods: [],
  informed_entities: [{ route_id: '' }],
  status: 'draft',
};

export function AlertsEditor() {
  const projectId = useStore((s) => s.activeServerProjectId);
  const routes = useStore((s) => s.routes);
  const stops = useStore((s) => s.stops);
  const agencies = useStore((s) => s.agencies);

  const [alerts, setAlerts] = useState<ServiceAlert[] | null>(null);
  const [coexistence, setCoexistence] = useState<RtCoexistence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ServiceAlert | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await listAlerts(projectId);
      setAlerts(res.alerts);
      setCoexistence(res.rt_coexistence);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load alerts.');
    }
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!projectId) {
    return (
      <div className="text-sm text-warm-gray">
        Service alerts are only available for feeds saved to your account. Save this feed to the
        cloud to start posting GTFS-Realtime alerts.
      </div>
    );
  }

  const nowSec = Math.floor(Date.now() / 1000);

  async function handleSave(input: AlertInput) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      if (editing && editing !== 'new') {
        await updateAlert(projectId, editing.id, input);
      } else {
        await createAlert(projectId, input);
      }
      setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the alert.');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggle(a: ServiceAlert) {
    if (!projectId) return;
    setBusy(true);
    try {
      await setAlertStatus(projectId, a.id, a.status === 'active' ? 'draft' : 'active');
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not change alert status.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(a: ServiceAlert) {
    if (!projectId) return;
    setBusy(true);
    try {
      await deleteAlert(projectId, a.id);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not delete the alert.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAdopt() {
    if (!projectId) return;
    setBusy(true);
    try {
      const res = await adoptManagedAlertsFeed(projectId);
      setCoexistence(res.rt_coexistence);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not adopt the alerts feed.');
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    // New alerts default to "entire agency" scope when the feed has an agency,
    // so the form is immediately valid/savable; the editor narrows it to a
    // route/stop as needed. Falls back to an (unselected) route row otherwise.
    const newAlertInput: AlertInput = {
      ...EMPTY_INPUT,
      informed_entities: [agencies[0] ? { agency_id: agencies[0].agency_id } : { route_id: '' }],
    };
    return (
      <AlertForm
        initial={editing === 'new' ? newAlertInput : alertToInput(editing)}
        routes={routes}
        stops={stops}
        agencies={agencies}
        busy={busy}
        error={error}
        onCancel={() => { setEditing(null); setError(null); }}
        onSave={handleSave}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-warm-gray">
          Post GTFS-Realtime Service Alerts — detours, delays, stop closures — served live without
          republishing your schedule.
        </p>
        <button
          onClick={() => { setEditing('new'); setError(null); }}
          className="shrink-0 bg-coral text-white px-3 py-1.5 rounded-lg font-semibold text-sm hover:brightness-95"
        >
          + New alert
        </button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {coexistence?.external_alerts_feed && !coexistence.managed_feed_url && (
        <div className="rounded-md bg-gold-light border border-amber-300 px-3 py-2 text-sm text-amber-800">
          You already advertise an external alerts feed
          (<code className="text-xs break-all">{coexistence.external_alerts_feed.url}</code>). A feed
          can only advertise one alerts source.
          <button
            onClick={handleAdopt}
            disabled={busy}
            className="ml-2 underline font-semibold hover:text-amber-900 disabled:opacity-50"
          >
            Replace it with the GTFS·X feed
          </button>
        </div>
      )}

      {coexistence?.managed_feed_url && (
        <div className="text-xs text-warm-gray">
          Live feed: <code className="break-all">{coexistence.managed_feed_url}</code> ·{' '}
          <code className="break-all">{coexistence.managed_feed_url.replace(/\.pb$/, '.json')}</code>
        </div>
      )}

      {alerts == null ? (
        <p className="text-sm text-warm-gray">Loading…</p>
      ) : alerts.length === 0 ? (
        <p className="text-sm text-warm-gray">No alerts yet. Create one to publish it to your live feed.</p>
      ) : (
        <ul className="space-y-2">
          {alerts.map((a) => {
            const live = isCurrentlyActive(a, nowSec);
            const effectLabel = EFFECT_OPTIONS.find((o) => o.value === a.effect)?.label ?? a.effect;
            return (
              <li key={a.id} className="rounded-xl border border-sand bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot live={live} status={a.status} />
                      <span className="font-semibold text-dark-brown truncate">{a.header_text || '(no header)'}</span>
                    </div>
                    <div className="mt-1 text-[12px] text-warm-gray">
                      {effectLabel} · {a.informed_entities.length} affected ·{' '}
                      {a.active_periods.length === 0 ? 'always active' : periodLabel(a.active_periods[0])}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => handleToggle(a)}
                      disabled={busy}
                      className="text-xs font-semibold px-2 py-1 rounded-md text-coral hover:bg-cream disabled:opacity-50"
                    >
                      {a.status === 'active' ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => { setEditing(a); setError(null); }}
                      className="text-xs font-semibold px-2 py-1 rounded-md text-brown hover:bg-cream"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(a)}
                      disabled={busy}
                      className="text-xs font-semibold px-2 py-1 rounded-md text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StatusDot({ live, status }: { live: boolean; status: string }) {
  const cls = live ? 'bg-teal' : status === 'active' ? 'bg-amber-400' : 'bg-sand';
  const title = live ? 'Currently broadcasting' : status === 'active' ? 'Active but outside its time window' : 'Draft';
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} title={title} aria-hidden />;
}

function alertToInput(a: ServiceAlert): AlertInput {
  return {
    cause: a.cause,
    effect: a.effect,
    severity_level: a.severity_level,
    header_text: a.header_text,
    description_text: a.description_text ?? '',
    url: a.url ?? '',
    active_periods: a.active_periods,
    informed_entities: a.informed_entities.length ? a.informed_entities : [{ route_id: '' }],
    status: a.status,
  };
}

// ─── Create / edit form ───────────────────────────────────────────────────────

interface RouteLite { route_id: string; route_short_name: string; route_long_name: string }
interface StopLite { stop_id: string; stop_name: string }
interface AgencyLite { agency_id: string; agency_name: string }

function AlertForm({
  initial,
  routes,
  stops,
  agencies,
  busy,
  error,
  onCancel,
  onSave,
}: {
  initial: AlertInput;
  routes: RouteLite[];
  stops: StopLite[];
  agencies: AgencyLite[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (input: AlertInput) => void;
}) {
  const [form, setForm] = useState<AlertInput>(initial);
  const defaultAgencyId = agencies[0]?.agency_id ?? '';

  const set = <K extends keyof AlertInput>(key: K, value: AlertInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const valid = useMemo(() => {
    if (!form.header_text.trim()) return false;
    if (form.informed_entities.length === 0) return false;
    // every entity must select something
    for (const e of form.informed_entities) {
      if (!e.agency_id && !e.route_id && !e.stop_id) return false;
    }
    // periods with both ends must satisfy end > start
    for (const p of form.active_periods) {
      if (p.start != null && p.end != null && p.end <= p.start) return false;
    }
    return true;
  }, [form]);

  // Explains why Save is disabled — authoring needs no published feed, so a
  // disabled button is always a fixable form-completeness issue.
  const hint = useMemo(() => {
    if (!form.header_text.trim()) return 'Add a header summary to enable Save.';
    for (const e of form.informed_entities) {
      if (!e.agency_id && !e.route_id && !e.stop_id) {
        return 'Pick an affected route, stop, or “Entire agency” for each row.';
      }
    }
    for (const p of form.active_periods) {
      if (p.start != null && p.end != null && p.end <= p.start) return 'Each window’s end must be after its start.';
    }
    return null;
  }, [form]);

  function submit() {
    // Normalize empty strings to nulls for optional text fields.
    onSave({
      ...form,
      description_text: form.description_text?.trim() ? form.description_text : null,
      url: form.url?.trim() ? form.url : null,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-heading font-bold text-dark-brown">{initial.header_text ? 'Edit alert' : 'New alert'}</h3>
        <button onClick={onCancel} className="text-sm text-warm-gray hover:text-coral">Cancel</button>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      <Field label="Header (rider-facing summary)">
        <input
          value={form.header_text}
          onChange={(e) => set('header_text', e.target.value)}
          placeholder="Route 5 detour around Main St"
          className={`${inputCls} w-full`}
        />
      </Field>

      <Field label="Description (optional)">
        <textarea
          value={form.description_text ?? ''}
          onChange={(e) => set('description_text', e.target.value)}
          rows={3}
          placeholder="Buses are detouring via 2nd Ave until further notice."
          className={`${inputCls} w-full`}
        />
      </Field>

      <div className="grid grid-cols-3 gap-2">
        <Field label="Cause">
          <select value={form.cause} onChange={(e) => set('cause', e.target.value)} className={`${inputCls} w-full`}>
            {CAUSE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Effect">
          <select value={form.effect} onChange={(e) => set('effect', e.target.value)} className={`${inputCls} w-full`}>
            {EFFECT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Severity">
          <select value={form.severity_level} onChange={(e) => set('severity_level', e.target.value)} className={`${inputCls} w-full`}>
            {SEVERITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Field>
      </div>

      <Field label="More info URL (optional)">
        <input
          value={form.url ?? ''}
          onChange={(e) => set('url', e.target.value)}
          placeholder="https://agency.gov/alerts/route-5"
          className={`${inputCls} w-full`}
        />
      </Field>

      {/* Affected entities */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide">Affected (≥ 1 required)</label>
          <button
            onClick={() => set('informed_entities', [...form.informed_entities, { route_id: '' }])}
            className="text-xs font-semibold text-coral hover:underline"
          >
            + Add
          </button>
        </div>
        <div className="space-y-2">
          {form.informed_entities.map((e, i) => (
            <EntityRow
              key={i}
              entity={e}
              routes={routes}
              stops={stops}
              defaultAgencyId={defaultAgencyId}
              onChange={(next) => {
                const copy = form.informed_entities.slice();
                copy[i] = next;
                set('informed_entities', copy);
              }}
              onRemove={() => set('informed_entities', form.informed_entities.filter((_, j) => j !== i))}
              canRemove={form.informed_entities.length > 1}
            />
          ))}
        </div>
      </div>

      {/* Active periods */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide">Active windows (none = always active)</label>
          <button
            onClick={() => set('active_periods', [...form.active_periods, { start: Math.floor(Date.now() / 1000), end: null }])}
            className="text-xs font-semibold text-coral hover:underline"
          >
            + Add window
          </button>
        </div>
        <div className="space-y-2">
          {form.active_periods.map((p, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                type="datetime-local"
                value={toLocalInput(p.start)}
                onChange={(e) => {
                  const copy = form.active_periods.slice();
                  copy[i] = { ...p, start: fromLocalInput(e.target.value) };
                  set('active_periods', copy);
                }}
                className={`${inputCls} flex-1 min-w-0`}
              />
              <span className="text-warm-gray text-xs">to</span>
              <input
                type="datetime-local"
                value={toLocalInput(p.end)}
                onChange={(e) => {
                  const copy = form.active_periods.slice();
                  copy[i] = { ...p, end: fromLocalInput(e.target.value) };
                  set('active_periods', copy);
                }}
                className={`${inputCls} flex-1 min-w-0`}
              />
              <button
                onClick={() => set('active_periods', form.active_periods.filter((_, j) => j !== i))}
                className="text-warm-gray hover:text-red-600 text-sm px-1"
                title="Remove window"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {hint && <p className="text-xs text-amber-700">{hint}</p>}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-sand">
        <label className="mr-auto flex items-center gap-2 text-sm text-brown">
          <input
            type="checkbox"
            checked={form.status === 'active'}
            onChange={(e) => set('status', e.target.checked ? 'active' : 'draft')}
          />
          Active (broadcast on the live feed)
        </label>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-sm font-semibold text-warm-gray hover:bg-cream">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !valid}
          className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-coral text-white hover:brightness-95 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save alert'}
        </button>
      </div>
    </div>
  );
}

function EntityRow({
  entity,
  routes,
  stops,
  defaultAgencyId,
  onChange,
  onRemove,
  canRemove,
}: {
  entity: InformedEntity;
  routes: RouteLite[];
  stops: StopLite[];
  defaultAgencyId: string;
  onChange: (e: InformedEntity) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const kind = entityKind(entity);
  return (
    <div className="flex items-center gap-2">
      <select
        value={kind}
        onChange={(e) => {
          const k = e.target.value as EntityKind;
          if (k === 'route') onChange({ route_id: routes[0]?.route_id ?? '' });
          else if (k === 'stop') onChange({ stop_id: stops[0]?.stop_id ?? '' });
          else onChange({ agency_id: defaultAgencyId });
        }}
        className={`${inputCls} w-28 shrink-0`}
      >
        <option value="route">Route</option>
        <option value="stop">Stop</option>
        <option value="agency">Entire agency</option>
      </select>

      {kind === 'route' && (
        <>
          <select
            value={entity.route_id ?? ''}
            onChange={(e) => onChange({ ...entity, route_id: e.target.value })}
            className={`${inputCls} flex-1 min-w-0`}
          >
            <option value="">— select route —</option>
            {routes.map((r) => (
              <option key={r.route_id} value={r.route_id}>
                {r.route_short_name || r.route_long_name || r.route_id}
              </option>
            ))}
          </select>
          <select
            value={entity.direction_id ?? ''}
            onChange={(e) =>
              onChange({ ...entity, direction_id: e.target.value === '' ? undefined : Number(e.target.value) })
            }
            className={`${inputCls} w-24 shrink-0`}
            title="Direction (optional)"
          >
            <option value="">Both dir.</option>
            <option value="0">Dir 0</option>
            <option value="1">Dir 1</option>
          </select>
        </>
      )}

      {kind === 'stop' && (
        <select
          value={entity.stop_id ?? ''}
          onChange={(e) => onChange({ stop_id: e.target.value })}
          className={`${inputCls} flex-1 min-w-0`}
        >
          <option value="">— select stop —</option>
          {stops.map((s) => (
            <option key={s.stop_id} value={s.stop_id}>
              {s.stop_name || s.stop_id}
            </option>
          ))}
        </select>
      )}

      {kind === 'agency' && (
        <span className="flex-1 min-w-0 text-sm text-warm-gray italic">Applies to the whole feed</span>
      )}

      {canRemove && (
        <button onClick={onRemove} className="text-warm-gray hover:text-red-600 text-sm px-1" title="Remove">
          ✕
        </button>
      )}
    </div>
  );
}

// NOTE: no width utility here — callers add `w-full` or a fixed `w-NN`. Putting
// `w-full` in the shared class lets it win over a later `w-28`/`w-24` in the
// compiled CSS (class order in JSX doesn't decide the cascade), which made the
// "fixed-width" selects render full-width and overflow the rail.
const inputCls =
  'rounded-lg border-2 border-sand bg-cream px-3 py-2 text-sm text-dark-brown focus:outline-none focus:border-coral focus:bg-white';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-warm-gray uppercase tracking-wide mb-1">{label}</label>
      {children}
    </div>
  );
}
