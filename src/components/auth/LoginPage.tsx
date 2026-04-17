import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FormField } from '../ui/FormField';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import { login, requestMagicLink, resendVerification, ApiError } from '../../services/authApi';
import { useStore } from '../../store';

type Tab = 'password' | 'magic';

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const setCurrentUser = useStore((s) => s.setCurrentUser);

  const initialTab: Tab = searchParams.get('tab') === 'magic' ? 'magic' : 'password';
  const [tab, setTab] = useState<Tab>(initialTab);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [magicEmail, setMagicEmail] = useState('');

  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [magicError, setMagicError] = useState<string | null>(null);
  const [magicSent, setMagicSent] = useState(false);

  // Set when login is blocked because the account hasn't verified its email —
  // we offer a one-click resend tied to the attempted email.
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | { error: string }>('idle');

  const [loading, setLoading] = useState(false);

  const magicLinkInvalid = searchParams.get('error') === 'magic_link_invalid';
  const resetSuccess = searchParams.get('reset') === '1';

  useEffect(() => {
    if (searchParams.get('tab') === 'magic') setTab('magic');
  }, [searchParams]);

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setUnverifiedEmail(null);
    setResendState('idle');
    setLoading(true);
    try {
      const { user } = await login({ email: email.trim(), password });
      setCurrentUser(user);
      const next = searchParams.get('next');
      navigate(next && next.startsWith('/') ? next : '/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'email_unverified') {
        const echoed = typeof err.extra.email === 'string' ? err.extra.email : email.trim();
        setUnverifiedEmail(echoed);
      } else {
        const msg = err instanceof ApiError ? err.message : 'Sign-in failed';
        setPasswordError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!unverifiedEmail) return;
    setResendState('sending');
    try {
      await resendVerification({ email: unverifiedEmail });
      setResendState('sent');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send verification email';
      setResendState({ error: msg });
    }
  };

  const handleMagicLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setMagicError(null);
    setLoading(true);
    try {
      await requestMagicLink({ email: magicEmail.trim() });
      setMagicSent(true);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send link';
      setMagicError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back to GTFS Builder."
      footer={
        <>
          New here?{' '}
          <Link to="/signup" className="text-coral font-semibold hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      {magicLinkInvalid && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
          That sign-in link is invalid or has expired. Request a new one below.
        </div>
      )}
      {resetSuccess && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-teal-light text-teal text-sm">
          Password updated — sign in with your new password.
        </div>
      )}

      <div className="flex gap-1 p-1 bg-cream rounded-lg mb-5">
        <button
          type="button"
          onClick={() => setTab('password')}
          className={`flex-1 px-3 py-2 rounded-md text-sm font-heading font-bold transition-colors ${
            tab === 'password' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'
          }`}
        >
          Password
        </button>
        <button
          type="button"
          onClick={() => setTab('magic')}
          className={`flex-1 px-3 py-2 rounded-md text-sm font-heading font-bold transition-colors ${
            tab === 'magic' ? 'bg-white text-dark-brown shadow-sm' : 'text-warm-gray hover:text-dark-brown'
          }`}
        >
          Email me a link
        </button>
      </div>

      {tab === 'password' ? (
        <form onSubmit={handlePasswordLogin}>
          {unverifiedEmail && (
            <div className="mb-4 px-3 py-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
              <p className="font-semibold mb-1">Email not verified</p>
              <p className="mb-3">
                Please verify <span className="font-mono">{unverifiedEmail}</span> before signing in.
                If you can't find the confirmation email, we can send a new one.
              </p>
              {resendState === 'sent' ? (
                <div className="px-2 py-1.5 rounded-md bg-teal-light text-teal text-xs">
                  Sent — check your inbox for a link from gtfsbuilder.net.
                </div>
              ) : (
                <>
                  {typeof resendState === 'object' && 'error' in resendState && (
                    <div className="mb-2 px-2 py-1.5 rounded-md bg-red-50 border border-red-200 text-red-700 text-xs">
                      {resendState.error}
                    </div>
                  )}
                  <AuthButton
                    type="button"
                    variant="secondary"
                    onClick={handleResendVerification}
                    disabled={resendState === 'sending'}
                  >
                    {resendState === 'sending' ? 'Sending…' : 'Send a new verification email'}
                  </AuthButton>
                </>
              )}
            </div>
          )}
          <FormField
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            required
          />
          <FormField
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            required
            error={passwordError ?? undefined}
          />
          <AuthButton type="submit" fullWidth disabled={loading || !email || !password}>
            {loading ? 'Signing in…' : 'Sign in'}
          </AuthButton>
          <div className="flex justify-between mt-4 text-sm">
            <Link to="/reset-password" className="text-coral hover:underline">
              Forgot password?
            </Link>
            <Link to="/signup" className="text-warm-gray hover:text-dark-brown">
              Sign up
            </Link>
          </div>
        </form>
      ) : magicSent ? (
        <div>
          <div className="px-3 py-3 rounded-lg bg-teal-light text-teal text-sm mb-4">
            Check your email for a sign-in link from gtfsbuilder.net.
          </div>
          <AuthButton
            variant="secondary"
            fullWidth
            onClick={() => {
              setMagicSent(false);
              setMagicEmail('');
            }}
          >
            Use a different email
          </AuthButton>
        </div>
      ) : (
        <form onSubmit={handleMagicLink}>
          <FormField
            label="Email"
            type="email"
            value={magicEmail}
            onChange={setMagicEmail}
            placeholder="you@example.com"
            required
            error={magicError ?? undefined}
          />
          <AuthButton type="submit" fullWidth disabled={loading || !magicEmail}>
            {loading ? 'Sending…' : 'Email me a link'}
          </AuthButton>
          <p className="text-xs text-warm-gray mt-3">
            We'll email you a one-time link to sign in — no password needed.
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
