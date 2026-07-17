import { Modal } from '../ui/Modal';
import { AuthButton } from '../auth/AuthButton';

interface VariantSaveGateDialogProps {
  /** Name of the non-baseline variant currently active in the live store. */
  variantName: string;
  saving: boolean;
  error: string | null;
  /** Primary: persist the baseline feed, leave the user on their variant. */
  onSaveBaseline: () => void;
  /** Secondary: overwrite the baseline feed with this variant (consented). */
  onOverwrite: () => void;
  onCancel: () => void;
}

/**
 * #66 stopgap — intercepts Save while a NON-baseline variant is active so it
 * can't silently overwrite the project's baseline feed with the experiment.
 * Offers an explicit choice: save the baseline (default, safe) or knowingly
 * overwrite it with the variant. Variants are session-only today, so the copy
 * spells out that they aren't persisted.
 */
export function VariantSaveGateDialog({
  variantName,
  saving,
  error,
  onSaveBaseline,
  onOverwrite,
  onCancel,
}: VariantSaveGateDialogProps) {
  return (
    <Modal
      open
      onClose={onCancel}
      title="Save your baseline feed?"
      showClose={!saving}
      dismissable={!saving}
      maxWidthClassName="max-w-md"
      footer={
        <>
          <AuthButton variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </AuthButton>
          <AuthButton variant="secondary" onClick={onOverwrite} disabled={saving}>
            Overwrite baseline
          </AuthButton>
          <AuthButton variant="primary" onClick={onSaveBaseline} disabled={saving}>
            {saving ? 'Saving…' : 'Switch to baseline and save'}
          </AuthButton>
        </>
      }
    >
      <div className="text-sm text-warm-gray space-y-2">
        <p>
          You're editing the variant{' '}
          <strong className="text-dark-brown">{variantName}</strong>. Variants are
          session-only experiments — they aren't saved and disappear when you reload.
        </p>
        <p>
          <strong className="text-dark-brown">Switch to baseline and save</strong>{' '}
          stores your real (baseline) feed and keeps you working in{' '}
          <strong className="text-dark-brown">{variantName}</strong>.
        </p>
        <p>
          <strong className="text-dark-brown">Overwrite baseline</strong> replaces your
          saved feed with the changes in{' '}
          <strong className="text-dark-brown">{variantName}</strong>. Your previous
          baseline can't be recovered afterward.
        </p>
      </div>
      {error && <p className="text-sm text-red-600 mt-3">{error}</p>}
    </Modal>
  );
}
