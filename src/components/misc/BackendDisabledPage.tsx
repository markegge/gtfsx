import { Link } from 'react-router-dom';
import { AuthLayout } from '../auth/AuthLayout';

export function BackendDisabledPage() {
  return (
    <AuthLayout
      title="Backend coming soon"
      footer={
        <Link to="/" className="text-coral font-semibold hover:underline">
          Back to editor
        </Link>
      }
    >
      <p className="text-sm text-warm-gray">
        Accounts and cloud-backed feeds aren't available yet. You can still use the editor and save
        locally in your browser.
      </p>
    </AuthLayout>
  );
}
