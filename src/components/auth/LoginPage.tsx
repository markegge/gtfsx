import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FormField } from '../ui/FormField';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import { GoogleSignInButton, AuthDivider } from './GoogleSignInButton';
import { login, requestMagicLink, resendVerification, verify2fa, resend2fa, ApiError } from '../../services/authApi';
import { useStore } from '../../store';

type Tab = 'password' | 'magic';

interface TwofaChallenge {
  challenge: string;
  method: string;
  destination: string;
}

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

  // Set when password login (or the Google OAuth redirect) reports a 2FA
  // code is required. Stays local — it never touches the Zustand store,
  // since it isn't real auth state until the code is verified.
  const [twofa, setTwofa] = useState<TwofaChallenge | null>(null);
  const [twofaCode, setTwofaCode] = useState('');
  const [twofaError, setTwofaError] = useState<string | null>(null);
  const [twofaExpired, setTwofaExpired] = useState(false);
  const [verifyingTwofa, setVerifyingTwofa] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendingTwofa, setResendingTwofa] = useState(false);
  const [twofaResent, setTwofaResent] = useState(false);

  const magicLinkInvalid = searchParams.get('error') === 'magic_link_invalid';
  const resetSuccess = searchParams.get('reset') === '1';

  // Preserve `next` when sending the user to sign up — e.g. a /pricing card
  // click for a logged-out user lands here, and choosing "create an account"
  // must keep the chosen plan so checkout resumes after email verification.
  const signupHref = useMemo(() => {
    const next = searchParams.get('next');
    return next ? `/signup?next=${encodeURIComponent(next)}` : '/signup';
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get('tab') === 'magic') setTab('magic');
  }, [searchParams]);

  // Google OAuth 2FA hand-off: on success, google.ts redirects to
  // /login#twofa=<token>&method=email&dest=<masked> instead of returning
  // JSON (the token can't go in a query string / server log). Parse it once
  // on mount and strip the fragment so a refresh doesn't re-trigger it.
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#twofa=')) return;
    const params = new URLSearchParams(hash.slice(1));
    const challenge = params.get('twofa');
    const method = params.get('method') ?? 'email';
    const destination = params.get('dest') ?? '';
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!challenge) return;
    setTwofa({ challenge, method, destination });
    setResendCooldown(60);
  }, []);

  useEffect(() => {
    if (!twofa || resendCooldown <= 0) return;
    const id = window.setTimeout(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [twofa, resendCooldown]);

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
      if (err instanceof ApiError && err.code === 'twofa_required') {
        const challenge = typeof err.extra.challenge === 'string' ? err.extra.challenge : '';
        const method = typeof err.extra.method === 'string' ? err.extra.method : 'email';
        const destination = typeof err.extra.destination === 'string' ? err.extra.destination : '';
        const cooldown = typeof err.extra.resend_cooldown_sec === 'number' ? err.extra.resend_cooldown_sec : 60;
        setTwofa({ challenge, method, destination });
        setTwofaCode('');
        setTwofaError(null);
        setTwofaExpired(false);
        setResendCooldown(cooldown);
      } else if (err instanceof ApiError && err.code === 'email_unverified') {
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

  const handleVerifyTwofa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!twofa) return;
    setTwofaError(null);
    setVerifyingTwofa(true);
    try {
      const { user } = await verify2fa({ challenge: twofa.challenge, code: twofaCode.trim() });
      setCurrentUser(user);
      const next = searchParams.get('next');
      navigate(next && next.startsWith('/') ? next : '/');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'twofa_invalid_code') {
        const attemptsLeft = typeof err.extra.attempts_left === 'number' ? err.extra.attempts_left : undefined;
        setTwofaError(
          attemptsLeft !== undefined
            ? `Incorrect code. ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left.`
            : 'Incorrect code.',
        );
        setTwofaCode('');
      } else if (err instanceof ApiError && err.code === 'twofa_expired') {
        setTwofaExpired(true);
      } else {
        setTwofaError(err instanceof ApiError ? err.message : 'Could not verify code');
      }
    } finally {
      setVerifyingTwofa(false);
    }
  };

  const handleResendTwofa = async () => {
    if (!twofa || resendCooldown > 0) return;
    setResendingTwofa(true);
    setTwofaError(null);
    setTwofaResent(false);
    try {
      const { resend_cooldown_sec } = await resend2fa({ challenge: twofa.challenge });
      setResendCooldown(resend_cooldown_sec ?? 60);
      setTwofaResent(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'twofa_expired') {
        setTwofaExpired(true);
      } else {
        setTwofaError(err instanceof ApiError ? err.message : 'Could not resend code');
      }
    } finally {
      setResendingTwofa(false);
    }
  };

  const handleBackFromTwofa = () => {
    setTwofa(null);
    setTwofaCode('');
    setTwofaError(null);
    setTwofaExpired(false);
    setTwofaResent(false);
    setResendCooldown(0);
    setPassword('');
  };

  if (twofa) {
    return (
      <AuthLayout
        title="Enter your code"
        subtitle={
          twofa.destination
            ? `We sent a 6-digit code to ${twofa.destination}.`
            : 'Enter the 6-digit code we sent you.'
        }
      >
        {twofaExpired ? (
          <div>
            <div className="mb-4 px-3 py-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm">
              That code has expired or ran out of attempts. Sign in again to get a new one.
            </div>
            <AuthButton variant="secondary" fullWidth onClick={handleBackFromTwofa}>
              Back to sign in
            </AuthButton>
          </div>
        ) : (
          <form onSubmit={handleVerifyTwofa}>
            <FormField label="Verification code" error={twofaError ?? undefined}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                value={twofaCode}
                onChange={(e) => setTwofaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                className="w-full px-3 py-2 border-2 rounded-lg text-lg font-mono tracking-[0.4em] text-center text-dark-brown bg-cream transition-colors border-sand focus:outline-none focus:border-coral focus:bg-white"
              />
            </FormField>
            <AuthButton type="submit" fullWidth disabled={verifyingTwofa || twofaCode.length !== 6}>
              {verifyingTwofa ? 'Verifying…' : 'Verify'}
            </AuthButton>
            <div className="flex items-center justify-between mt-4 text-sm">
              <button type="button" onClick={handleBackFromTwofa} className="text-coral hover:underline">
                Back
              </button>
              {resendCooldown > 0 ? (
                <span className="text-warm-gray">Resend code in {resendCooldown}s</span>
              ) : (
                <button
                  type="button"
                  onClick={handleResendTwofa}
                  disabled={resendingTwofa}
                  className="text-coral hover:underline disabled:opacity-60"
                >
                  {resendingTwofa ? 'Sending…' : 'Resend code'}
                </button>
              )}
            </div>
            {twofaResent && resendCooldown > 0 && <p className="mt-2 text-xs text-teal">New code sent.</p>}
          </form>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back to GTFS·X."
      footer={
        <>
          New here?{' '}
          <Link to={signupHref} className="text-coral font-semibold hover:underline">
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
                  Sent — check your inbox for a link from gtfsx.com.
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
            <Link to={signupHref} className="text-coral hover:underline">
              Sign up
            </Link>
          </div>
        </form>
      ) : magicSent ? (
        <div>
          <div className="px-3 py-3 rounded-lg bg-teal-light text-teal text-sm mb-4">
            Check your email for a sign-in link from gtfsx.com.
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

      <AuthDivider />
      <GoogleSignInButton next={searchParams.get('next')} />
    </AuthLayout>
  );
}
