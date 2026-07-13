import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Heading. Rendered as the Radix Dialog.Title (required for a11y). */
  title: ReactNode;
  /** Optional simple description text under the title (rendered as Dialog.Description). */
  description?: ReactNode;
  /** Body content. */
  children?: ReactNode;
  /** Footer node, typically AuthButtons. Rendered in a `flex justify-end gap-2` row. */
  footer?: ReactNode;
  /** Show the × close button top-right. Default true. */
  showClose?: boolean;
  /**
   * Keep the title for screen readers but don't render it visibly — for modals
   * whose body already carries its own heading (e.g. a self-contained card).
   */
  hideTitle?: boolean;
  /** Tailwind max-width class for the container. Default `max-w-sm`. */
  maxWidthClassName?: string;
  /** Override the container className entirely (rare). */
  className?: string;
  /**
   * When false, Escape / backdrop clicks are ignored — used to lock the modal
   * while an async action is in flight so the user can't dismiss mid-submit.
   * Default true.
   */
  dismissable?: boolean;
}

const OVERLAY = 'fixed inset-0 bg-black/30 z-50';
const CONTAINER =
  'fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-2xl ' +
  'shadow-lg p-6 w-full mx-4 max-h-[85vh] overflow-auto';

/**
 * Canonical app modal built on @radix-ui/react-dialog — gives every dialog the
 * same focus-trap, Escape handling, and ARIA wiring for free. Callers control
 * mount via `open`; `onClose` fires on Escape, backdrop click, or the × button.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  showClose = true,
  hideTitle = false,
  maxWidthClassName = 'max-w-sm',
  className,
  dismissable = true,
}: ModalProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o && dismissable) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY} />
        <Dialog.Content
          className={className ?? `${CONTAINER} ${maxWidthClassName}`}
          // When no description is rendered, opt out of Radix's aria-describedby
          // wiring so it doesn't warn about a dangling id; otherwise let Radix
          // link the Dialog.Description automatically.
          {...(description == null ? { 'aria-describedby': undefined } : {})}
          onEscapeKeyDown={(e) => {
            if (!dismissable) e.preventDefault();
          }}
          onInteractOutside={(e) => {
            if (!dismissable) e.preventDefault();
          }}
        >
          {showClose && (
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-lg leading-none text-warm-gray hover:text-dark-brown hover:bg-sand/50 transition-colors"
              >
                ×
              </button>
            </Dialog.Close>
          )}
          <Dialog.Title
            className={
              hideTitle
                ? 'sr-only'
                : 'font-heading font-bold text-lg text-dark-brown mb-2 pr-6'
            }
          >
            {title}
          </Dialog.Title>
          {description != null && (
            <Dialog.Description className="text-sm text-warm-gray mb-4">
              {description}
            </Dialog.Description>
          )}
          {children}
          {footer && <div className="flex justify-end gap-2 mt-5">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
