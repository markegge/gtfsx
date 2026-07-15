import { useState } from 'react';
import { Banner } from '../ui/Banner';

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
    <Banner variant="info" onDismiss={handleDismiss} dismissLabel="Dismiss partner banner">
      Loaded from <strong className="font-semibold">{partner}</strong>
    </Banner>
  );
}
