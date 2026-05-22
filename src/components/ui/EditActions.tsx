/** Duplicate / Delete action buttons for an entity edit sub-panel header.
 * Rendered top-right across the route, stop, calendar, and fare editors so the
 * pattern is consistent. Styled as clearly-visible bordered buttons (not bare
 * text). Either action can be omitted. */
export function EditActions({
  onDuplicate,
  onDelete,
  duplicateTitle = 'Duplicate',
  deleteTitle = 'Delete',
}: {
  onDuplicate?: () => void;
  onDelete?: () => void;
  duplicateTitle?: string;
  deleteTitle?: string;
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      {onDuplicate && (
        <button
          onClick={onDuplicate}
          title={duplicateTitle}
          className="px-2.5 h-7 rounded-md border border-sand bg-white text-[12px] font-heading font-semibold text-warm-gray hover:border-coral hover:text-coral transition-colors"
        >
          Duplicate
        </button>
      )}
      {onDelete && (
        <button
          onClick={onDelete}
          title={deleteTitle}
          className="px-2.5 h-7 rounded-md border border-red-200 bg-white text-[12px] font-heading font-semibold text-red-600 hover:bg-red-50 hover:border-red-300 transition-colors"
        >
          Delete
        </button>
      )}
    </div>
  );
}
