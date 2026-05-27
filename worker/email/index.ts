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
  <h1 style="font-size: 20px; margin: 0 0 16px;">GTFS·X</h1>
  ${body}
  <hr style="border: 0; border-top: 1px solid #eee; margin: 32px 0 16px;" />
  <p style="color: #888; font-size: 12px;">Sent by gtfsx.com. If you didn't request this, you can ignore this email.</p>
</body></html>`;
}

export async function sendVerifyEmail(env: Env, to: string, link: string): Promise<void> {
  await send(env, {
    to,
    subject: 'Confirm your email for GTFS·X',
    html: wrap(`
      <p>Welcome! Click the link below to confirm your email and activate your account:</p>
      <p><a href="${link}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Confirm my email</a></p>
      <p style="color: #666; font-size: 13px;">Or paste this URL into your browser: <br /><code>${link}</code></p>
      <p style="color: #666; font-size: 13px;">This link expires in 24 hours.</p>
    `),
    text: `Welcome to GTFS·X! Confirm your email by visiting: ${link}\n\nThis link expires in 24 hours.`,
  });
}

export async function sendMagicLink(env: Env, to: string, link: string): Promise<void> {
  await send(env, {
    to,
    subject: 'Your sign-in link for GTFS·X',
    html: wrap(`
      <p>Click the link below to sign in. If you didn't request this, you can safely ignore this email.</p>
      <p><a href="${link}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Sign me in</a></p>
      <p style="color: #666; font-size: 13px;">Or paste this URL into your browser: <br /><code>${link}</code></p>
      <p style="color: #666; font-size: 13px;">This link expires in 15 minutes and can only be used once.</p>
    `),
    text: `Sign in to GTFS·X: ${link}\n\nThis link expires in 15 minutes.`,
  });
}

export async function sendPasswordReset(env: Env, to: string, link: string): Promise<void> {
  await send(env, {
    to,
    subject: 'Reset your GTFS·X password',
    html: wrap(`
      <p>We received a request to reset your password. Click the link below to choose a new one:</p>
      <p><a href="${link}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Reset password</a></p>
      <p style="color: #666; font-size: 13px;">Or paste this URL into your browser: <br /><code>${link}</code></p>
      <p style="color: #666; font-size: 13px;">This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>
    `),
    text: `Reset your GTFS·X password: ${link}\n\nThis link expires in 1 hour.`,
  });
}

export async function sendInvitationEmail(
  env: Env,
  to: string,
  inviterName: string,
  orgName: string,
  role: string,
  link: string,
): Promise<void> {
  const safeInviter = escapeHtml(inviterName);
  const safeOrg = escapeHtml(orgName);
  const safeRole = escapeHtml(role);
  await send(env, {
    to,
    subject: `You're invited to ${orgName} on GTFS·X`,
    html: wrap(`
      <p><strong>${safeInviter}</strong> has invited you to join the <strong>${safeOrg}</strong> organization on GTFS·X as a <strong>${safeRole}</strong>.</p>
      <p>Click the link below to accept the invitation. If you don't already have a GTFS·X account you'll be asked to sign up with this email address first.</p>
      <p><a href="${link}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Accept invitation</a></p>
      <p style="color: #666; font-size: 13px;">Or paste this URL into your browser: <br /><code>${link}</code></p>
      <p style="color: #666; font-size: 13px;">This link expires in 7 days. If you weren't expecting this, you can ignore this email.</p>
    `),
    text: `${inviterName} has invited you to join ${orgName} on GTFS·X as a ${role}.\n\nAccept the invitation: ${link}\n\nThis link expires in 7 days.`,
  });
}

/**
 * Trial-ending reminder. Fired from the Stripe `customer.subscription.
 * trial_will_end` webhook (~3 days before trial end). Two CTAs: keep the
 * Agency plan (no action needed) or switch to Pro (link to /pricing).
 */
export async function sendTrialEndingEmail(
  env: Env,
  to: string,
  opts: {
    /** Display date like "May 31, 2026". */
    trialEndDate: string;
    /** "$299/mo" or similar — already formatted for display. */
    monthlyPriceLabel: string;
    /** App URL for managing the subscription (Stripe portal or org billing page). */
    manageLink: string;
    /** App URL for switching to Pro (typically /pricing#pro). */
    switchToProLink: string;
  },
): Promise<void> {
  const date = escapeHtml(opts.trialEndDate);
  const price = escapeHtml(opts.monthlyPriceLabel);
  const manage = escapeHtml(opts.manageLink);
  const pro = escapeHtml(opts.switchToProLink);
  await send(env, {
    to,
    subject: `Your GTFS·X Agency trial ends ${opts.trialEndDate}`,
    html: wrap(`
      <p>Your 14-day Agency trial ends on <strong>${date}</strong>. The card on file will be charged ${price} on that date unless you change plans or cancel before then.</p>
      <p style="margin: 18px 0;"><a href="${manage}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Manage subscription</a></p>
      <p>Don't need the full planning suite? You can switch to the Pro plan ($49/mo) instead — keeps your published feeds and embeds, drops the planning analyses:</p>
      <p style="margin: 12px 0;"><a href="${pro}" style="color: #8a5a3b;">Switch to Pro →</a></p>
      <p style="color: #666; font-size: 13px;">Or do nothing and stay on Agency. Either is fine.</p>
    `),
    text:
      `Your 14-day Agency trial ends on ${opts.trialEndDate}.\n\n` +
      `The card on file will be charged ${opts.monthlyPriceLabel} on that date unless you change plans or cancel before then.\n\n` +
      `Manage your subscription: ${opts.manageLink}\n` +
      `Switch to Pro ($49/mo): ${opts.switchToProLink}\n\n` +
      `Or do nothing and stay on Agency. Either is fine.`,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
