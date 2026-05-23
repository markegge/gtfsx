import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';

// Top-level URL prefixes for prerendered marketing/docs pages (served as
// static HTML by the Worker's assets binding). The SPA bundle doesn't ship
// React routes for these, so an in-app navigation to e.g. /compare/x hits
// the catchall below — without the reload, the user sees "page not found"
// even though hitting the URL directly (or refreshing) loads fine.
const PRERENDERED_PREFIXES = [
  '/about/',
  '/compare/',
  '/docs/',
  '/embed-demo/',
  '/learn/',
  '/privacy-policy/',
  '/pricing/',
  '/demo/',
  '/use-cases/',
];

export function NotFoundPage() {
  // If the missing path is actually a prerendered static page, force a full
  // navigation to the same URL so the server can serve the static HTML. The
  // prerendered pages don't include the SPA script, so this can't loop.
  useEffect(() => {
    const path = window.location.pathname;
    if (PRERENDERED_PREFIXES.some((p) => path === p || path.startsWith(p))) {
      window.location.replace(window.location.href);
    }
  }, []);

  return (
    <AuthLayout
      title="Page not found"
      footer={
        <Link to="/" className="text-coral font-semibold hover:underline">
          Back to editor
        </Link>
      }
    >
      <p className="text-sm text-warm-gray">We couldn't find that page.</p>
    </AuthLayout>
  );
}
