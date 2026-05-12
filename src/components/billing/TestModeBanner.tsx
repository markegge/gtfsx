// Renders a discreet "Stripe test mode" hint when the publishable key is a
// test-mode key. Visible on pricing, welcome, and billing pages so a tester
// can confirm at a glance that no real money will move, plus the canonical
// test card so they don't have to look it up.
//
// Stripe's hosted Checkout shows its own bright orange test-mode badge, so we
// keep this banner soft — informational, not alarming.

import { stripePublishableKey } from '../../utils/featureFlags';

export function TestModeBanner({ className = '' }: { className?: string }) {
  if (!stripePublishableKey.startsWith('pk_test_')) return null;
  return (
    <div className={`rounded-xl border border-gold bg-gold-light/40 px-4 py-3 text-xs text-amber-900 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-bold uppercase tracking-wide">Stripe test mode</span>
        <span className="text-amber-800">
          No real charges. Use card{' '}
          <code className="rounded bg-white/60 px-1 py-0.5 font-mono">4242 4242 4242 4242</code>
          {' '}with any future expiry, any 3-digit CVC, and any ZIP.
        </span>
        <a
          href="https://docs.stripe.com/testing#cards"
          target="_blank"
          rel="noopener noreferrer"
          className="text-amber-900 underline hover:no-underline"
        >
          More test cards →
        </a>
      </div>
    </div>
  );
}
