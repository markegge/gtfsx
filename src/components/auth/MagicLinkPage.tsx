import { Link } from 'react-router-dom';
import { AuthLayout } from './AuthLayout';

export function MagicLinkPage() {
  return (
    <AuthLayout title="Sign-in link">
      <p className="text-sm text-dark-brown">
        If you came from a sign-in email, you should have been redirected already. If not, the link may be
        invalid —{' '}
        <Link to="/login?tab=magic" className="text-coral font-semibold hover:underline">
          request a new one
        </Link>
        .
      </p>
    </AuthLayout>
  );
}
