interface EmptyStateProps {
  icon?: string;
  title: string;
  description: string;
  /** Primary action. Rendered as a coral pill with a leading "+" by default. */
  actionLabel?: string;
  onAction?: () => void;
  /** Leading glyph on the primary pill. Defaults to "+ " (an add/create cue);
   *  pass "" for actions that aren't creating a freshly-named thing. */
  actionPrefix?: string;
  /** Optional secondary action, rendered as a sand pill to the left of the primary. */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
}

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  actionPrefix = '+ ',
  secondaryActionLabel,
  onSecondaryAction,
}: EmptyStateProps) {
  const hasPrimary = actionLabel && onAction;
  const hasSecondary = secondaryActionLabel && onSecondaryAction;
  return (
    <div className="text-center py-10 px-6">
      {icon && <div className="text-5xl mb-4 opacity-60">{icon}</div>}
      <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">{title}</h3>
      <p className="text-warm-gray text-sm mb-5">{description}</p>
      {(hasPrimary || hasSecondary) && (
        <div className="flex items-center justify-center gap-2">
          {hasSecondary && (
            <button
              onClick={onSecondaryAction}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-sand text-brown rounded-full font-heading font-bold text-sm hover:bg-coral-light hover:text-coral transition-colors"
            >
              {secondaryActionLabel}
            </button>
          )}
          {hasPrimary && (
            <button
              onClick={onAction}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-coral text-white rounded-full font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
            >
              {actionPrefix}{actionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
