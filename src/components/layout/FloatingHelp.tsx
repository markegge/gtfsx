import { useEffect, useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useStore } from '../../store';
import { isPaidPlan } from '../../utils/planRank';

const SUPPORT_EMAIL = 'support@gtfsx.com';

/**
 * Floating "?" help button with a click-to-toggle quick-links menu.
 *
 * Renders in the bottom-left of the editor over the map. Clicking the pill
 * toggles a menu above it with links to the quick-start guide, full
 * documentation, and community forum — all in new tabs so the user does not
 * lose editor state. Clicking outside or pressing Escape closes the menu.
 * Paid (Planner/Enterprise) users also see a support-email row with a
 * copy-to-clipboard button.
 *
 * Accessibility:
 *   - Trigger: aria-haspopup / aria-expanded managed by Radix Popover.Trigger.
 *   - Menu closes on Escape and outside-click (Radix built-in).
 *   - Copy button has an aria-label that updates to "Copied to clipboard".
 *   - External links carry rel="noopener noreferrer".
 */
export function FloatingHelp() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const currentUser = useStore((s) => s.currentUser);
  const userOrgs = useStore((s) => s.userOrgs);

  // Hide on narrow viewports when the right-rail panel overlays the screen
  // (z-20), because the help button (z-30, absolute) would appear on top of
  // and obscure the panel's last content row.
  const sidebarSection = useStore((s) => s.sidebarSection);
  const rightRailOpen = useStore((s) => s.rightRailOpen);
  const [isNarrow, setIsNarrow] = useState(
    typeof window !== 'undefined' && window.innerWidth < 600,
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 600);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Show support email for a paid personal plan OR any agency / enterprise org.
  const showSupportEmail = useMemo(() => {
    if (isPaidPlan(currentUser?.plan)) return true;
    return userOrgs.some((o) => o.plan === 'agency' || o.plan === 'enterprise');
  }, [currentUser, userOrgs]);

  // ── Narrow-viewport guard ──────────────────────────────────────
  // When the right-rail panel fills the screen on mobile, this button sits
  // at z-30 (above the z-20 panel) and covers the last content row. Hide it.
  if (isNarrow && sidebarSection && rightRailOpen) return null;

  // ── Clipboard copy ─────────────────────────────────────────────
  const handleCopy = () => {
    const finish = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(SUPPORT_EMAIL).then(finish).catch(() => {
        copyViaExecCommand();
        finish();
      });
    } else {
      copyViaExecCommand();
      finish();
    }
  };

  const copyViaExecCommand = () => {
    const el = document.createElement('textarea');
    el.value = SUPPORT_EMAIL;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    document.body.removeChild(el);
  };

  // ── Shared link classes ────────────────────────────────────────
  const linkCls =
    'flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm text-dark-brown hover:bg-cream transition-colors';

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          aria-label="Help"
          className="absolute bottom-10 left-3 h-8 px-3 rounded-full bg-white border border-sand shadow-md text-warm-gray hover:text-coral hover:border-coral hover:shadow-lg flex items-center gap-1.5 text-xs font-heading font-bold uppercase tracking-wide transition-all z-30"
        >
          <span className="text-sm leading-none">?</span>
          <span>Help</span>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 bg-white rounded-xl shadow-lg border border-sand p-1.5 w-52 outline-none"
        >
          <a
            href="/docs/quick-start/"
            target="_blank"
            rel="noopener noreferrer"
            className={linkCls}
          >
            <span>Quick start guide</span>
            <ExternalIcon />
          </a>
          <a
            href="/docs/"
            target="_blank"
            rel="noopener noreferrer"
            className={linkCls}
          >
            <span>Full documentation</span>
            <ExternalIcon />
          </a>
          <a
            href="/community"
            target="_blank"
            rel="noopener noreferrer"
            className={linkCls}
          >
            <span>Community forum</span>
            <ExternalIcon />
          </a>

          {showSupportEmail && (
            <>
              <div className="my-1 border-t border-sand" aria-hidden />
              <div className="flex items-center gap-1.5 px-3 py-2">
                <span className="text-xs text-warm-gray flex-1 truncate select-all">
                  {SUPPORT_EMAIL}
                </span>
                <button
                  type="button"
                  onClick={handleCopy}
                  aria-label={copied ? 'Copied to clipboard' : 'Copy support email address'}
                  title={copied ? 'Copied!' : 'Copy'}
                  className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-warm-gray hover:text-coral hover:bg-cream transition-colors"
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                </button>
              </div>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ExternalIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-warm-gray"
      aria-hidden
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-teal"
      aria-hidden
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
