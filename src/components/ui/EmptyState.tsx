

interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({ icon, title, description, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="text-center py-10 px-6">
      <div className="text-5xl mb-4 opacity-60">{icon}</div>
      <h3 className="font-heading font-bold text-lg text-dark-brown mb-2">{title}</h3>
      <p className="text-warm-gray text-sm mb-5">{description}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="inline-flex items-center gap-1.5 px-5 py-2.5 bg-coral text-white rounded-full font-heading font-bold text-sm hover:bg-[#d4603a] transition-colors"
        >
          + {actionLabel}
        </button>
      )}
    </div>
  );
}
