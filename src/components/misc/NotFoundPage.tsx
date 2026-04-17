import { Link } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';

export function NotFoundPage() {
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
