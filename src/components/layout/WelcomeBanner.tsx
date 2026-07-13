import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Banner } from '../ui/Banner';

export function WelcomeBanner() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  const show = !dismissed && searchParams.get('welcome') === '1';

  if (!show) return null;

  const handleDismiss = () => {
    setDismissed(true);
    const next = new URLSearchParams(searchParams);
    next.delete('welcome');
    setSearchParams(next, { replace: true });
  };

  return (
    <Banner variant="info" onDismiss={handleDismiss}>
      Welcome! Your account is ready — you can now save feeds across devices.
    </Banner>
  );
}
