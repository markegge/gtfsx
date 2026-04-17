import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FormField } from '../ui/FormField';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import { confirmPasswordReset, requestPasswordReset, ApiError } from '../../services/authApi';

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await requestPasswordReset({ email: email.trim() });
      setSent(true);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send reset email';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setError(null);
    setLoading(true);
    try {
      await confirmPasswordReset({ token, password });
      navigate('/login?reset=1');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not set password';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (token) {
    return (
      <AuthLayout title="Set a new password">
        <form onSubmit={handleConfirm}>
          <FormField
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            error={error ?? undefined}
          />
          <div className="-mt-2 mb-3 text-xs text-warm-gray">Use at least 10 characters.</div>
          <AuthButton type="submit" fullWidth disabled={loading || !password}>
            {loading ? 'Saving…' : 'Save new password'}
          </AuthButton>
        </form>
      </AuthLayout>
    );
  }

  if (sent) {
    return (
      <AuthLayout
        title="Check your email"
        footer={
          <Link to="/login" className="text-coral font-semibold hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="px-3 py-3 rounded-lg bg-teal-light text-teal text-sm">
          If an account exists for that email, we've sent a password reset link.
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset your password"
      subtitle="Enter the email on your account and we'll send a reset link."
      footer={
        <Link to="/login" className="text-coral font-semibold hover:underline">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={handleRequest}>
        <FormField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          required
          error={error ?? undefined}
        />
        <AuthButton type="submit" fullWidth disabled={loading || !email}>
          {loading ? 'Sending…' : 'Send reset link'}
        </AuthButton>
      </form>
    </AuthLayout>
  );
}
