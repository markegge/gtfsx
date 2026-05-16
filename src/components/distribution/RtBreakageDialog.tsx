import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AuthButton } from '../auth/AuthButton';

export interface RtBreakageRemoved {
  agencies: string[];
  routes: string[];
  stops: string[];
  trips: string[];
}

export interface RtBreakageEventDetail {
  removed: RtBreakageRemoved;
  retry: () => void;
}

// Global listener for the `gb:rt-breakage` custom event. The PublishPanel
// dispatches this when it gets a 409 from POST /api/projects/:id/publish with
// the RT-breakage shape; it passes `retry` as a closure that re-publishes with
// `ignoreRtBreakage: true`. This dialog owns only the "show the user what's
// about to break and let them confirm or back out" interaction.
export function RtBreakageDialog() {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RtBreakageEventDetail | null>(null);

  useEffect(() => {
    const onBreakage = (e: Event) => {
      const custom = e as CustomEvent<RtBreakageEventDetail>;
      if (!custom.detail) return;
      setDetail(custom.detail);
      setOpen(true);
    };
    window.addEventListener('gb:rt-breakage', onBreakage);
    return () => window.removeEventListener('gb:rt-breakage', onBreakage);
  }, []);

  const close = () => {
    setOpen(false);
    // Defer clearing detail so the dialog can fade out if we ever add animation.
    setTimeout(() => setDetail(null), 150);
  };

  const publishAnyway = () => {
    detail?.retry();
    close();
  };

  if (!detail) return null;

  const totals = {
    agencies: detail.removed.agencies?.length ?? 0,
    routes: detail.removed.routes?.length ?? 0,
    stops: detail.removed.stops?.length ?? 0,
    trips: detail.removed.trips?.length ?? 0,
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30 z-50" />
        <Dialog.Content
          className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                     bg-white rounded-2xl shadow-lg p-6 w-full max-w-xl mx-4
                     max-h-[85vh] overflow-auto"
        >
          <Dialog.Title className="font-heading font-bold text-lg text-dark-brown mb-2">
            This will break your GTFS-Realtime feed
          </Dialog.Title>
          <Dialog.Description className="text-sm text-warm-gray mb-4">
            Your real-time feed references IDs that are being removed in this snapshot. Once you
            publish, downstream apps will keep receiving RT updates for IDs that no longer match
            your schedule — vehicles won't appear on maps, predictions will drop, and alerts may
            silently point at nothing.
          </Dialog.Description>

          <div className="space-y-3 mb-5">
            <RemovedList label="Agencies" ids={detail.removed.agencies} total={totals.agencies} />
            <RemovedList label="Routes" ids={detail.removed.routes} total={totals.routes} />
            <RemovedList label="Stops" ids={detail.removed.stops} total={totals.stops} />
            <RemovedList label="Trips" ids={detail.removed.trips} total={totals.trips} />
          </div>

          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <AuthButton variant="secondary" onClick={close}>
                Cancel
              </AuthButton>
            </Dialog.Close>
            <AuthButton variant="danger" onClick={publishAnyway}>
              Publish anyway
            </AuthButton>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RemovedList({ label, ids, total }: { label: string; ids: string[]; total: number }) {
  if (total === 0) return null;
  const shown = ids.slice(0, 20);
  const more = total - shown.length;
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-warm-gray mb-1">
        {label} ({total})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((id) => (
          <code
            key={id}
            className="px-2 py-0.5 rounded bg-sand/60 text-dark-brown text-xs font-mono"
          >
            {id}
          </code>
        ))}
        {more > 0 && (
          <span className="px-2 py-0.5 text-xs text-warm-gray italic">+{more} more</span>
        )}
      </div>
    </div>
  );
}
