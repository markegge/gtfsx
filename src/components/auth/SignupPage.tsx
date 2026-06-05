import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FormField } from '../ui/FormField';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import { GoogleSignInButton, AuthDivider } from './GoogleSignInButton';
import { TurnstileWidget } from './TurnstileWidget';
import { signup, resendVerification, ApiError } from '../../services/authApi';
import { turnstileSiteKey } from '../../utils/featureFlags';
import { useStore } from '../../store';

export function SignupPage() {
  const navigate = useNavigate();
  const setCurrentUser = useStore((s) => s.setCurrentUser);
  const [searchParams] = useSearchParams();
  // Both pre-filled by the invitation flow. `email` populates the form;
  // `next` threads through to the verify-email redirect so the user lands
  // on /orgs/accept after confirming and bypasses the tier picker. When
  // `next` is /orgs/accept?token=…, we extract the invitation token and
  // pass it to the server so the account is auto-activated — clicking the
  // invite link already proved control of the email address.
  const initialEmail = searchParams.get('email') ?? '';
  const nextPath = searchParams.get('next') ?? '';
  const invitationToken = useMemo(() => {
    if (!nextPath.startsWith('/orgs/accept')) return undefined;
    try {
      const u = new URL(nextPath, window.location.origin);
      return u.searchParams.get('token') ?? undefined;
    } catch {
      return undefined;
    }
  }, [nextPath]);
  // Login link from the footer should preserve the `next` so users with
  // an existing account can still land in the right place.
  const loginHref = useMemo(() => {
    if (!nextPath) return '/login';
    return `/login?next=${encodeURIComponent(nextPath)}`;
  }, [nextPath]);
  const [email, setEmail] = useState(initialEmail);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  // Resend state for the "Check your email" screen, so a user who never got the
  // confirmation link can request a fresh one without going back to sign in.
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | { error: string }>('idle');

  const captchaRequired = turnstileSiteKey.length > 0;

  const handleTurnstileToken = useCallback((token: string | null) => {
    setTurnstileToken(token);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setNameError(null);
    setPasswordError(null);
    setGeneralError(null);
    setLoading(true);
    try {
      const res = await signup({
        email: email.trim(),
        displayName: displayName.trim(),
        password,
        turnstileToken: turnstileToken ?? undefined,
        next: nextPath || undefined,
        invitationToken,
      });
      // Auto-activated invitee: skip the "check your email" screen and head
      // straight to the accept page (or wherever `next` points).
      if (res.activated && res.user) {
        setCurrentUser(res.user);
        navigate(nextPath || '/feeds', { replace: true });
        return;
      }
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'conflict') {
          setEmailError(err.message);
        } else if (err.code === 'validation_failed') {
          const msg = err.message.toLowerCase();
          if (msg.includes('captcha') || msg.includes('turnstile')) {
            setGeneralError(err.message);
            // Force the user to redo the challenge.
            setTurnstileToken(null);
            if (typeof window !== 'undefined' && window.turnstile) {
              try { window.turnstile.reset(); } catch { /* widget may have unmounted */ }
            }
          } else if (msg.includes('password')) setPasswordError(err.message);
          else if (msg.includes('name')) setNameError(err.message);
          else if (msg.includes('email')) setEmailError(err.message);
          else setGeneralError(err.message);
        } else {
          setGeneralError(err.message);
        }
      } else {
        setGeneralError('Something went wrong. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResendState('sending');
    try {
      await resendVerification({ email: email.trim() });
      setResendState('sent');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send verification email';
      setResendState({ error: msg });
    }
  };

  const passwordStrengthOk = password.length >= 10;

  if (done) {
    return (
      <AuthLayout
        title="Check your email"
        footer={
          <Link to="/login" className="text-coral font-semibold hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="px-3 py-3 rounded-lg bg-teal-light text-teal text-sm mb-4">
          Check your email for a confirmation link from gtfsx.com.
        </div>
        <p className="text-sm text-warm-gray">
          We sent a message to <span className="font-semibold text-dark-brown">{email.trim()}</span>. Click the
          link to activate your account.
        </p>
        <div className="mt-5 border-t border-sand pt-4">
          {resendState === 'sent' ? (
            <div className="px-3 py-2 rounded-lg bg-teal-light text-teal text-sm">
              Sent — check your inbox for a new link from gtfsx.com.
            </div>
          ) : (
            <>
              <p className="text-sm text-warm-gray mb-2">
                Didn&rsquo;t get the link? Check your spam folder, or we can send a new one.
              </p>
              {typeof resendState === 'object' && 'error' in resendState && (
                <div className="mb-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
                  {resendState.error}
                </div>
              )}
              <AuthButton
                type="button"
                variant="secondary"
                onClick={handleResend}
                disabled={resendState === 'sending'}
              >
                {resendState === 'sending' ? 'Sending…' : 'Send a new verification email'}
              </AuthButton>
            </>
          )}
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Save feeds across devices and publish to a stable URL."
      footer={
        <>
          Already have an account?{' '}
          <Link to={loginHref} className="text-coral font-semibold hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit}>
        <FormField
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          placeholder="you@example.com"
          required
          error={emailError ?? undefined}
        />
        <FormField
          label="Display name"
          value={displayName}
          onChange={setDisplayName}
          placeholder="Your name"
          required
          error={nameError ?? undefined}
        />
        <FormField
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          required
          error={passwordError ?? undefined}
        />
        <div className="-mt-2 mb-3 text-xs text-warm-gray">
          Use at least 10 characters.{' '}
          {password.length > 0 && (
            <span className={passwordStrengthOk ? 'text-teal font-semibold' : 'text-coral'}>
              {password.length}/10
            </span>
          )}
        </div>
        {captchaRequired && (
          <TurnstileWidget siteKey={turnstileSiteKey} onToken={handleTurnstileToken} />
        )}
        {generalError && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {generalError}
          </div>
        )}
        <AuthButton
          type="submit"
          fullWidth
          disabled={
            loading ||
            !email ||
            !displayName ||
            !password ||
            (captchaRequired && !turnstileToken)
          }
        >
          {loading ? 'Creating account…' : 'Create account'}
        </AuthButton>
      </form>

      <AuthDivider />
      <GoogleSignInButton label="Sign up with Google" next={nextPath || null} />
    </AuthLayout>
  );
}
