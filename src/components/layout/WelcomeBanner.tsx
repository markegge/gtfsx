import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';

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
    <div className="bg-teal-light border-b border-sand px-5 py-2 flex items-center gap-3 shrink-0">
      <span className="text-sm text-teal">
        Welcome! Your account is ready — you can now save feeds across devices.
      </span>
      <div className="flex-1" />
      <button
        onClick={handleDismiss}
        className="text-teal hover:opacity-70 text-lg leading-none px-2"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
