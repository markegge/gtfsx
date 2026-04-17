import type { Env } from '../env';

// Thin wrapper around the Resend REST API. We don't pull in `resend` the npm
// package because it adds weight and the REST surface we need is tiny.
//
// All emails are plain + html; plain-text fallback is auto-generated from
// the html by Resend if omitted, but we provide our own for control.

interface SendOpts {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function send(env: Env, opts: SendOpts): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed: ${res.status} ${body}`);
  }
}

function wrap(body: string): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px; margin: 32px auto; padding: 24px; color: #1a1a1a; line-height: 1.5;">
  <h1 style="font-size: 20px; margin: 0 0 16px;">GTFS Builder</h1>
  ${body}
  <hr style="border: 0; border-top: 1px solid #eee; margin: 32px 0 16px;" />
  <p style="color: #888; font-size: 12px;">Sent by gtfsbuilder.net. If you didn't request this, you can ignore this email.</p>
</body></html>`;
}

export async function sendVerifyEmail(env: Env, to: string, link: string): Promise<void> {
  await send(env, {
    to,
    subject: 'Confirm your email for GTFS Builder',
    html: wrap(`
      <p>Welcome! Click the link below to confirm your email and activate your account:</p>
      <p><a href="${link}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Confirm my email</a></p>
      <p style="color: #666; font-size: 13px;">Or paste this URL into your browser: <br /><code>${link}</code></p>
      <p style="color: #666; font-size: 13px;">This link expires in 24 hours.</p>
    `),
    text: `Welcome to GTFS Builder! Confirm your email by visiting: ${link}\n\nThis link expires in 24 hours.`,
  });
}

export async function sendMagicLink(env: Env, to: string, link: string): Promise<void> {
  await send(env, {
    to,
    subject: 'Your sign-in link for GTFS Builder',
    html: wrap(`
      <p>Click the link below to sign in. If you didn't request this, you can safely ignore this email.</p>
      <p><a href="${link}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Sign me in</a></p>
      <p style="color: #666; font-size: 13px;">Or paste this URL into your browser: <br /><code>${link}</code></p>
      <p style="color: #666; font-size: 13px;">This link expires in 15 minutes and can only be used once.</p>
    `),
    text: `Sign in to GTFS Builder: ${link}\n\nThis link expires in 15 minutes.`,
  });
}

export async function sendPasswordReset(env: Env, to: string, link: string): Promise<void> {
  await send(env, {
    to,
    subject: 'Reset your GTFS Builder password',
    html: wrap(`
      <p>We received a request to reset your password. Click the link below to choose a new one:</p>
      <p><a href="${link}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Reset password</a></p>
      <p style="color: #666; font-size: 13px;">Or paste this URL into your browser: <br /><code>${link}</code></p>
      <p style="color: #666; font-size: 13px;">This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>
    `),
    text: `Reset your GTFS Builder password: ${link}\n\nThis link expires in 1 hour.`,
  });
}
