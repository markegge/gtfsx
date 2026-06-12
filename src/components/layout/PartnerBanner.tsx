import { useState } from 'react';

/**
 * Dismissible "Loaded from <partner>" banner shown in the editor after a
 * deep-link import that carried a known attribution source or ref param.
 *
 * The partner name is read from sessionStorage (`gb_import_partner`), which
 * DeepLinkImportPage writes before redirecting to the editor. When the user
 * dismisses the banner the key is removed so it doesn't reappear within the
 * same tab session.
 */
export function PartnerBanner() {
  const [partner, setPartner] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('gb_import_partner');
    } catch {
      return null;
    }
  });

  if (!partner) return null;

  const handleDismiss = () => {
    try {
      sessionStorage.removeItem('gb_import_partner');
    } catch {
      // ignore
    }
    setPartner(null);
  };

  return (
    <div className="bg-teal-light border-b border-sand px-5 py-2 flex items-center gap-3 shrink-0">
      <span className="text-sm text-teal">
        Loaded from <strong className="font-semibold">{partner}</strong>
      </span>
      <div className="flex-1" />
      <button
        onClick={handleDismiss}
        className="text-teal hover:opacity-70 text-lg leading-none px-2"
        aria-label="Dismiss partner banner"
      >
        ×
      </button>
    </div>
  );
}
