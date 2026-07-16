import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';
import { formatTimeShort, normalizeTimeInput } from '../../utils/time';
import { Toggle } from '../ui/Toggle';
import { navFrom, navTab, useAnchoredMenuPosition, useDismiss, type RowActionStyle } from './timetableGridHelpers';

/* ============================================================================
   One editable time input (single mode + arr/dep parts)
   ========================================================================== */

interface CellInputProps {
  value: string; // stored time (HH:MM:SS or raw) or '' = blank
  placeholder?: string;
  ti: number;
  si: number;
  part?: 'a' | 'd';
  totalStops: number;
  /** Enable ↑↓←→ + Tab navigation (off for the mirrored departure input). */
  nav: boolean;
  timeError?: boolean;
  onCommit: (normalized: string) => void;
}

/** Format-on-blur time input with red invalid/out-of-order highlight. Local
 *  editing state so an in-progress draft isn't clobbered by the store. */
function CellInput({ value, placeholder, ti, si, part, totalStops, nav, timeError, onCommit }: CellInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const elRef = useRef<HTMLInputElement | null>(null);
  const display = value ? formatTimeShort(value) : '';
  const editing = draft !== null;

  const commit = useCallback((raw: string | null) => {
    if (raw === null) return;
    const trimmed = raw.trim();
    if (!trimmed) { onCommit(''); setInvalid(false); return; }
    const normalized = normalizeTimeInput(trimmed);
    if (normalized) { onCommit(normalized); setInvalid(false); }
    else setInvalid(true);
  }, [onCommit]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Escape') { setDraft(null); setInvalid(false); el.blur(); return; }
    if (e.key === 'Tab') {
      commit(draft);
      setDraft(null);
      if (nav) { e.preventDefault(); if (!navTab(el, e.shiftKey ? -1 : 1, totalStops)) el.blur(); }
      return;
    }
    if (!nav) {
      if (e.key === 'Enter') { commit(draft); setDraft(null); el.blur(); }
      return;
    }
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      commit(draft); setDraft(null);
      if (!navFrom(el, 1, 0)) el.blur();
      return;
    }
    if (e.key === 'ArrowUp') { e.preventDefault(); commit(draft); setDraft(null); navFrom(el, -1, 0); return; }
    if (e.key === 'ArrowLeft' && el.selectionStart === 0 && el.selectionEnd === 0) {
      commit(draft); setDraft(null); navFrom(el, 0, -1); e.preventDefault(); return;
    }
    if (e.key === 'ArrowRight' && el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
      commit(draft); setDraft(null); navFrom(el, 0, 1); e.preventDefault(); return;
    }
  };

  return (
    <input
      ref={elRef}
      value={editing ? (draft as string) : display}
      placeholder={placeholder ?? '--:--'}
      spellCheck={false}
      data-ti={ti}
      data-si={si}
      data-part={part}
      onFocus={() => { setDraft(display); setInvalid(false); requestAnimationFrame(() => elRef.current?.select()); }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { commit(draft); setDraft(null); }}
      onKeyDown={onKeyDown}
      className={`w-full h-full px-2 bg-transparent text-left font-mono text-[13px] text-dark-brown outline-none rounded-[2px] tabular-nums placeholder:text-warm-gray/40 focus:bg-white focus:shadow-[inset_0_0_0_2px_var(--color-coral)] ${
        invalid || timeError ? 'bg-red-50 text-red-500 shadow-[inset_0_0_0_2px_#ef4444]' : ''
      }`}
    />
  );
}

/* ============================================================================
   TimeCell — one grid <td>: timed / blank / skipped, + hover-× skip
   ========================================================================== */

interface TimeCellProps {
  value: string | null; // string ('' = blank), null = skipped
  arrDep: boolean;
  isTimepoint: boolean;
  pinned: boolean;
  pinnedLeft: number;
  highlighted: boolean;
  timeError: boolean;
  ti: number;
  si: number;
  totalStops: number;
  onHover: () => void;
  onCommit: (v: string) => void; // single/mirrored commit
  onCommitArr: (v: string) => void;
  onCommitDep: (v: string) => void;
  onSkip: () => void;
  onRestore: () => void;
}

export function TimeCell(props: TimeCellProps) {
  const {
    value, arrDep, isTimepoint, pinned, pinnedLeft, highlighted, timeError,
    ti, si, totalStops, onHover, onCommit, onCommitArr, onCommitDep, onSkip, onRestore,
  } = props;

  const bg = isTimepoint
    ? (highlighted ? 'bg-[#FCE9DC]' : 'bg-[#FFF4EE]')
    : (highlighted ? 'bg-[#FCF4EA]' : 'bg-white');
  const cls = `relative group h-9 border-b border-[#F5F0EB] ${bg} ${
    pinned ? 'sticky z-[2] border-r-2 border-r-sand' : ''
  }`;
  const style = pinned ? { left: pinnedLeft } : undefined;

  if (value === null) {
    return (
      <td className={cls} style={style} onMouseEnter={onHover}>
        <button
          type="button"
          onClick={onRestore}
          title="Skipped — this trip doesn't serve this stop. Click to serve it again."
          aria-label="Stop skipped on this trip. Click to serve it again."
          className="mx-auto flex items-center justify-center w-[calc(100%-12px)] h-[calc(100%-12px)] rounded border-[1.5px] border-dashed border-warm-gray/50 font-heading font-bold text-[9.5px] tracking-widest text-warm-gray hover:border-teal hover:text-teal"
        >
          SKIP
        </button>
      </td>
    );
  }

  const skipBtn = (
    <button
      type="button"
      tabIndex={-1}
      onClick={onSkip}
      title="Skip this stop on this trip (the trip won't serve it)"
      aria-label="Skip this stop on this trip"
      className="absolute top-0.5 right-0.5 z-[1] w-[15px] h-[15px] flex items-center justify-center rounded bg-red-50 text-red-500 text-[9px] leading-none opacity-0 group-hover:opacity-100"
    >
      ✕
    </button>
  );

  if (arrDep) {
    const [a, d] = value.includes('/') ? value.split('/') : [value, value];
    const commit = (which: 'a' | 'd', raw: string) => {
      if (!raw) { onCommit(''); return; }
      if (which === 'a') onCommitArr(raw);
      else onCommitDep(raw);
    };
    return (
      <td className={cls} style={style} onMouseEnter={onHover}>
        <div className="flex flex-col h-full">
          <div className="h-1/2">
            <CellInput value={a} placeholder="arr" ti={ti} si={si} part="a" totalStops={totalStops} nav timeError={timeError} onCommit={(r) => commit('a', r)} />
          </div>
          <div className="h-1/2 border-t border-dotted border-sand">
            <CellInput value={d} placeholder="dep" ti={ti} si={si} part="d" totalStops={totalStops} nav={false} onCommit={(r) => commit('d', r)} />
          </div>
        </div>
        {skipBtn}
      </td>
    );
  }

  return (
    <td className={cls} style={style} onMouseEnter={onHover}>
      <CellInput value={value} ti={ti} si={si} totalStops={totalStops} nav timeError={timeError} onCommit={onCommit} />
      {skipBtn}
    </td>
  );
}

/* ============================================================================
   TripCell — sticky Trip-ID column with inline rename + headway hint
   ========================================================================== */

interface TripCellProps {
  tripId: string;
  isDuplicate: boolean;
  width: number;
  headway: string | null; // e.g. "+30m", or null when hints are off
  irregular: boolean;
  onRename: (id: string) => void;
}

export function TripCell({ tripId, isDuplicate, width, headway, irregular, onRename }: TripCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tripId);
  return (
    <th
      scope="row"
      className="sticky left-0 z-[2] bg-white border-r border-sand border-b border-[#F5F0EB] px-2 whitespace-nowrap overflow-hidden text-left"
      style={{ width, maxWidth: width }}
    >
      <span className="inline-flex items-center gap-1.5">
        {editing ? (
          <input
            autoFocus
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { setEditing(false); onRename(draft.trim() || tripId); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            className={`w-14 px-1 font-heading font-bold text-xs rounded border outline-none ${
              isDuplicate ? 'border-red-400 shadow-[0_0_0_2px_rgba(248,113,113,0.3)]' : 'border-coral'
            }`}
          />
        ) : (
          <span
            title={isDuplicate ? 'Duplicate trip ID' : 'Click to rename this trip'}
            onClick={() => { setDraft(tripId); setEditing(true); }}
            className={`inline-block min-w-[34px] px-1 py-px rounded cursor-text font-heading font-bold text-xs text-dark-brown hover:bg-cream ${
              isDuplicate ? 'text-red-500' : ''
            }`}
          >
            {tripId}
          </span>
        )}
        {headway != null && (
          <span
            title={irregular ? "Irregular headway — differs from this pattern's usual interval" : 'Interval since the previous trip'}
            className={`font-mono text-[9.5px] ${
              irregular ? 'text-amber-700 bg-gold-light px-1 rounded font-medium' : 'text-warm-gray/80'
            }`}
          >
            {headway}
          </span>
        )}
      </span>
    </th>
  );
}

/* ============================================================================
   ActionCell — sticky per-trip actions column, three presentations
   ========================================================================== */

type ActionKind = 'interpolate' | 'estimate' | 'duplicate' | 'applyall' | 'delete';

const ROW_ACTIONS: [action: ActionKind, label: string][] = [
  ['interpolate', 'Interpolate stop times — fill blanks from set times'],
  ['estimate', 'Estimate times from road network…'],
  ['duplicate', 'Duplicate trip…'],
  ['applyall', "Apply this trip's pattern to all trips…"],
  ['delete', 'Delete trip'],
];

// Stroke-based SVG icons (defined geometry → perfectly centered, unlike the
// symbol glyphs they replace, which rode the text baseline unevenly). Match the
// meanings of the prototype's ⟿ / ◷ / ⧉ / ⇶ / ✕ and the wrench's line style.
const ACTION_PATHS: Record<ActionKind, ReactNode> = {
  interpolate: (<><path d="M3 12h10.5" strokeDasharray="2.5 2.5" /><path d="M13 7l5 5-5 5" /></>),
  estimate: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3.2 2" /></>),
  duplicate: (<><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6.5A2 2 0 0 0 13.5 4.5h-7A2 2 0 0 0 4.5 6.5v7A2 2 0 0 0 6.5 15.5h2" /></>),
  applyall: (<><path d="M4 8h10M4 12h10M4 16h10" /><path d="M16 9l3 3-3 3" /></>),
  delete: (<path d="M6 6l12 12M18 6L6 18" />),
};

function ActionGlyph({ kind, size = 14 }: { kind: ActionKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ACTION_PATHS[kind]}
    </svg>
  );
}

const WrenchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.7 6.3a4.5 4.5 0 0 0-5.9 5.9L3 18v3h3l5.8-5.8a4.5 4.5 0 0 0 5.9-5.9l-3 3-2.5-.5-.5-2.5 3-3z" />
  </svg>
);

interface ActionCellProps {
  mode: RowActionStyle;
  open: boolean;
  stickyLeft: number;
  canApplyAll: boolean;
  canEstimate: boolean;
  onMenu: (rect: DOMRect) => void;
  onAct: (action: string) => void;
}

export function ActionCell({ mode, open, stickyLeft, canApplyAll, canEstimate, onMenu, onAct }: ActionCellProps) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const enabled = (id: string) => (id === 'applyall' ? canApplyAll : id === 'estimate' ? canEstimate : true);
  const iconBtns = ROW_ACTIONS.filter(([id]) => enabled(id)).map(([id, label]) => (
    <button
      key={id}
      type="button"
      tabIndex={-1}
      title={label}
      aria-label={label}
      onClick={() => onAct(id)}
      className={`w-6 h-6 flex items-center justify-center rounded text-warm-gray hover:bg-coral-light ${
        id === 'delete' ? 'hover:text-red-500 hover:bg-red-50' : 'hover:text-[#d4603a]'
      }`}
    >
      <ActionGlyph kind={id} size={13} />
    </button>
  ));

  if (mode === 'strip') {
    return (
      <td className="sticky z-[2] bg-white border-r-2 border-r-sand border-b border-[#F5F0EB] p-0 text-center" style={{ left: stickyLeft }}>
        <div className="flex gap-0.5 justify-center items-center">{iconBtns}</div>
      </td>
    );
  }

  const wrench = (
    <button
      ref={btnRef}
      type="button"
      tabIndex={-1}
      data-rowmenu-trigger
      aria-haspopup="menu"
      aria-expanded={open}
      title="Trip actions — interpolate, estimate, duplicate, apply to all, delete"
      onClick={() => btnRef.current && onMenu(btnRef.current.getBoundingClientRect())}
      className={`w-[22px] h-[22px] flex items-center justify-center rounded-md border hover:bg-coral-light hover:text-[#d4603a] hover:border-coral ${
        open ? 'bg-coral-light text-[#d4603a] border-coral' : 'bg-white text-warm-gray border-sand'
      }`}
    >
      <WrenchIcon />
    </button>
  );

  if (mode === 'flyout') {
    return (
      <td className="sticky z-[2] bg-white border-r-2 border-r-sand border-b border-[#F5F0EB] p-0 overflow-visible group/act" style={{ left: stickyLeft }}>
        {/* flex-center the wrench: a display:flex button ignores the cell's
            text-align, so center it explicitly on the column's centerline. */}
        <div className="flex items-center justify-center">{wrench}</div>
        <div className="hidden group-hover/act:flex absolute left-[30px] top-1/2 -translate-y-1/2 z-[5] gap-0.5 p-1 bg-white border border-sand rounded-lg shadow-md">
          {iconBtns}
        </div>
      </td>
    );
  }

  // "menu"
  return (
    <td className="sticky z-[2] bg-white border-r-2 border-r-sand border-b border-[#F5F0EB] p-0" style={{ left: stickyLeft }}>
      <div className="flex items-center justify-center">{wrench}</div>
    </td>
  );
}

/* ============================================================================
   RowMenu — the labeled per-trip actions dropdown (fixed position)
   ========================================================================== */

interface MenuItem { id: ActionKind; chip: string; label: string; sub?: string; danger?: boolean }

const ROW_MENU_ITEMS: MenuItem[] = [
  { id: 'interpolate', chip: 'bg-teal-light text-teal', label: 'Interpolate stop times', sub: 'Fill blanks from distance between set times' },
  { id: 'estimate', chip: 'bg-gold-light text-[#b8860b]', label: 'Estimate times…', sub: 'From road-network driving time' },
  { id: 'duplicate', chip: 'bg-coral-light text-coral', label: 'Duplicate trip…', sub: 'Same pattern, offset start time' },
  { id: 'applyall', chip: 'bg-purple-light text-purple', label: 'Apply to all trips…', sub: 'Push this pattern; others keep their starts' },
  { id: 'delete', chip: 'bg-red-50 text-red-500', label: 'Delete trip', danger: true },
];

export function RowMenu({
  rect, canApplyAll, canEstimate, onPick, onClose,
}: {
  rect: DOMRect;
  canApplyAll: boolean;
  canEstimate: boolean;
  onPick: (action: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, onClose, '[data-rowmenu-trigger]');
  const pos = useAnchoredMenuPosition(ref, rect, 4);
  const items = ROW_MENU_ITEMS.filter((it) =>
    (it.id !== 'applyall' || canApplyAll) && (it.id !== 'estimate' || canEstimate));
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[80] min-w-[235px] p-1.5 bg-white border border-sand rounded-xl shadow-[0_8px_28px_rgba(61,46,34,0.18)]"
      style={pos}
    >
      {items.map((it, i) => (
        <div key={it.id}>
          {it.danger && i > 0 && <div className="h-px bg-sand mx-2 my-1.5" />}
          <button
            type="button"
            role="menuitem"
            onClick={() => onPick(it.id)}
            className={`flex items-center gap-2.5 w-full text-left px-2.5 py-2 rounded-md text-xs ${
              it.danger ? 'text-red-500 hover:bg-red-50' : 'text-dark-brown hover:bg-cream'
            }`}
          >
            <span className={`w-[22px] h-[22px] flex items-center justify-center rounded-md shrink-0 ${it.chip}`}><ActionGlyph kind={it.id} size={14} /></span>
            <span>
              <span className="block font-semibold">{it.label}</span>
              {it.sub && <span className="block text-[11px] text-warm-gray font-normal mt-px">{it.sub}</span>}
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}

/* ============================================================================
   ColumnMenu — the ▾ header config popover (HANDOFF §6)
   ========================================================================== */

export function ColumnMenu({
  stopName, rect, isTimepoint, arrDepOn, showContinuous, continuousValue,
  onTimepoint, onArrDep, onContinuous, onClose,
}: {
  stopName: string;
  rect: DOMRect;
  isTimepoint: boolean;
  arrDepOn: boolean;
  showContinuous: boolean;
  continuousValue: 'default' | 'none' | 'phone';
  onTimepoint: (on: boolean) => void;
  onArrDep: (on: boolean) => void;
  onContinuous: (v: 'default' | 'none' | 'phone') => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(ref, onClose, '[data-colmenu-trigger]');
  const pos = useAnchoredMenuPosition(ref, rect);
  return (
    <div
      ref={ref}
      className="fixed z-[90] w-[270px] p-4 bg-white border border-sand rounded-xl shadow-[0_8px_28px_rgba(61,46,34,0.18)] text-left"
      style={pos}
    >
      <div className="font-heading font-extrabold text-[13px] text-dark-brown mb-0.5">{stopName}</div>
      <button type="button" onClick={() => onTimepoint(!isTimepoint)} className="flex items-center gap-2.5 w-full text-left px-1.5 py-1.5 rounded-md hover:bg-cream">
        <span className="w-[22px] h-[22px] flex items-center justify-center rounded-md text-xs shrink-0 bg-coral-light text-coral">◆</span>
        <span className="flex-1">
          <span className="block font-semibold text-xs text-dark-brown">Key timepoint</span>
          <span className="block text-[11px] text-warm-gray">{isTimepoint ? 'Published time — coral tint' : 'Off — times interpolate through here'}</span>
        </span>
        <Toggle on={isTimepoint} />
      </button>
      <button type="button" onClick={() => onArrDep(!arrDepOn)} className="flex items-center gap-2.5 w-full text-left px-1.5 py-1.5 rounded-md hover:bg-cream">
        <span className="w-[22px] h-[22px] flex items-center justify-center rounded-md text-[9px] font-mono shrink-0 bg-teal-light text-teal">a/d</span>
        <span className="flex-1">
          <span className="block font-semibold text-xs text-dark-brown">Separate arrival &amp; departure</span>
          <span className="block text-[11px] text-warm-gray">{arrDepOn ? 'On — two times per trip, for dwell' : 'Off — one time per trip (the usual case)'}</span>
        </span>
        <Toggle on={arrDepOn} />
      </button>
      {showContinuous && (
        <>
          <div className="h-px bg-sand mx-0.5 my-1.5" />
          <div className="text-[11px] text-warm-gray mx-0.5 mb-1">⚑ Continuous pickup/drop-off — applies across every trip</div>
          {([
            ['default', 'Route default (continuous pickup)'],
            ['none', 'No continuous pickup here'],
            ['phone', 'Phone agency to arrange'],
          ] as const).map(([val, label]) => (
            <label key={val} className="flex items-center gap-1.5 px-0.5 py-1 text-[12.5px] text-brown cursor-pointer">
              <input type="radio" checked={continuousValue === val} onChange={() => onContinuous(val)} className="accent-coral" />
              {label}
            </label>
          ))}
        </>
      )}
    </div>
  );
}

/* ============================================================================
   ColResizer — coral drag handle at a column's right edge (HANDOFF §5)
   ========================================================================== */

export function ColResizer({ onResize }: { onResize: (dx: number | null) => void }) {
  const [active, setActive] = useState(false);
  const start = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(true);
    const x0 = e.clientX;
    const move = (ev: MouseEvent) => onResize(ev.clientX - x0);
    const up = () => {
      setActive(false);
      onResize(null);
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  };
  return (
    <span
      onMouseDown={start}
      title="Drag to resize column"
      className="group/rz absolute top-0 -right-px w-[9px] h-full cursor-col-resize z-[2]"
    >
      <span className={`absolute right-[3px] top-[22%] bottom-[22%] w-0.5 rounded-full ${active ? 'bg-coral' : 'bg-transparent group-hover/rz:bg-coral'}`} />
    </span>
  );
}

/* ============================================================================
   HeadwayToggle — the tiny "+m" toggle in the Trip header
   ========================================================================== */

export function HeadwayToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Headway hints — show the interval since the previous trip next to each trip ID; irregular intervals get flagged"
      className={`h-[17px] px-1.5 rounded border font-mono text-[9px] leading-none ${
        on ? 'bg-coral-light border-coral text-[#d4603a]' : 'bg-white border-sand text-warm-gray hover:border-coral hover:text-[#d4603a]'
      }`}
    >
      +m
    </button>
  );
}
