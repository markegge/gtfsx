import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FormField } from '../ui/FormField';
import { AuthLayout } from './AuthLayout';
import { AuthButton } from './AuthButton';
import { signup, ApiError } from '../../services/authApi';

export function SignupPage() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setNameError(null);
    setPasswordError(null);
    setGeneralError(null);
    setLoading(true);
    try {
      await signup({
        email: email.trim(),
        displayName: displayName.trim(),
        password,
      });
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'conflict') {
          setEmailError(err.message);
        } else if (err.code === 'validation_failed') {
          const msg = err.message.toLowerCase();
          if (msg.includes('password')) setPasswordError(err.message);
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
          Check your email for a confirmation link from gtfsbuilder.net.
        </div>
        <p className="text-sm text-warm-gray">
          We sent a message to <span className="font-semibold text-dark-brown">{email.trim()}</span>. Click the
          link to activate your account.
        </p>
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
          <Link to="/login" className="text-coral font-semibold hover:underline">
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
        {generalError && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">
            {generalError}
          </div>
        )}
        <AuthButton
          type="submit"
          fullWidth
          disabled={loading || !email || !displayName || !password}
        >
          {loading ? 'Creating account…' : 'Create account'}
        </AuthButton>
      </form>
    </AuthLayout>
  );
}
