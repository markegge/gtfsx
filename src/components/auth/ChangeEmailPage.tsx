import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from './AuthLayout';
import { confirmChangeEmail, ApiError } from '../../services/authApi';

export function ChangeEmailPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const [error, setError] = useState<string | null>(
    token ? null : 'No confirmation token found. Use the link from your email.'
  );
  const [working, setWorking] = useState(!!token);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) return;
    confirmChangeEmail({ token })
      .then(() => navigate('/account?email_changed=1'))
      .catch((err) => {
        const msg = err instanceof ApiError ? err.message : 'Confirmation failed';
        setError(msg);
        setWorking(false);
      });
  }, [token, navigate]);

  return (
    <AuthLayout
      title={working ? 'Confirming email change…' : 'Confirmation failed'}
      footer={
        <Link to="/account" className="text-coral font-semibold hover:underline">
          Back to account settings
        </Link>
      }
    >
      {working && <p className="text-sm text-warm-gray">Hang on a sec.</p>}
      {error && (
        <div className="px-3 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          {error}
        </div>
      )}
    </AuthLayout>
  );
}
