import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import { resendVerification, ApiError } from '../../services/authApi';
import { useStore } from '../../store';

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const status = searchParams.get('status');
  const currentUser = useStore((s) => s.currentUser);

  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  const handleResend = async () => {
    setResending(true);
    setResendError(null);
    try {
      await resendVerification();
      setResent(true);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send email';
      setResendError(msg);
    } finally {
      setResending(false);
    }
  };

  if (status === 'invalid') {
    return (
      <AuthLayout title="Link expired">
        <p className="text-sm text-dark-brown mb-5">
          This verification link has expired or is invalid — request a new one.
        </p>
        {currentUser ? (
          <>
            {resent ? (
              <div className="px-3 py-2 rounded-lg bg-teal-light text-teal text-sm">
                Sent — check your email for a new verification link.
              </div>
            ) : (
              <>
                {resendError && (
                  <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                    {resendError}
                  </div>
                )}
                <AuthButton fullWidth onClick={handleResend} disabled={resending}>
                  {resending ? 'Sending…' : 'Send a new link'}
                </AuthButton>
              </>
            )}
          </>
        ) : (
          <Link to="/signup" className="text-coral font-semibold hover:underline text-sm">
            Try signing up again
          </Link>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Verify your email">
      <p className="text-sm text-dark-brown">
        Please click the link we emailed you to finish setting up your account.
      </p>
      {currentUser && (
        <div className="mt-5">
          {resent ? (
            <div className="px-3 py-2 rounded-lg bg-teal-light text-teal text-sm">
              Sent — check your email.
            </div>
          ) : (
            <>
              {resendError && (
                <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  {resendError}
                </div>
              )}
              <AuthButton variant="secondary" fullWidth onClick={handleResend} disabled={resending}>
                {resending ? 'Sending…' : 'Resend verification email'}
              </AuthButton>
            </>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
