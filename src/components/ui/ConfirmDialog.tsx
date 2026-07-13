import type { ReactNode } from 'react';
import { Modal } from './Modal';
import { AuthButton } from '../auth/AuthButton';

interface ConfirmDialogProps {
  /** Defaults to true — most callers mount the dialog conditionally. */
  open?: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
  /** Disables only the confirm button (e.g. nothing valid to act on yet). */
  confirmDisabled?: boolean;
  /** Disables both buttons and locks dismissal while an action is in flight. */
  busy?: boolean;
  /** Confirm-button label shown while `busy`. Default "Working…". */
  busyLabel?: string;
  /** Optional inline error, shown above the footer. */
  error?: ReactNode;
  /** Extra content between body and footer (e.g. a set of choices). */
  children?: ReactNode;
}

/**
 * Canonical confirm dialog — a Cancel / confirm pair over the shared Modal.
 * Footer order is always [Cancel, then primary/destructive]. Set `danger` for
 * destructive confirms (red confirm button).
 */
export function ConfirmDialog({
  open = true,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  danger,
  confirmDisabled,
  busy,
  busyLabel = 'Working…',
  error,
  children,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      showClose={false}
      dismissable={!busy}
      footer={
        <>
          <AuthButton variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </AuthButton>
          <AuthButton
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy || confirmDisabled}
          >
            {busy ? busyLabel : confirmLabel}
          </AuthButton>
        </>
      }
    >
      <div className="text-sm text-warm-gray">{body}</div>
      {children}
      {error && (
        <div className="mt-4 px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
          {error}
        </div>
      )}
    </Modal>
  );
}
