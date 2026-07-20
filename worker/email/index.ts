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
  /** Optional Resend top-level `reply_to`. Omitted from the body when empty. */
  replyTo?: string;
  /** Optional Resend top-level `bcc`. Omitted from the body when empty. */
  bcc?: string;
}

async function send(env: Env, opts: SendOpts): Promise<void> {
  const body: Record<string, unknown> = {
    from: env.AUTH_EMAIL_FROM,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  };
  // Only attach reply_to / bcc when actually set — Resend rejects an empty
  // string, and most transactional mails want neither.
  if (opts.replyTo) body.reply_to = opts.replyTo;
  if (opts.bcc) body.bcc = opts.bcc;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Resend send failed: ${res.status} ${errBody}`);
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

/**
 * One-time welcome email, sent best-effort when an account FIRST becomes active
 * (password verify pending→active, or a brand-new Google-OAuth user). The
 * activation nudge for Campaign A: confirms they're in, points at the
 * quick-start + hosted-publishing docs, nudges the first save/publish, and opens
 * a reply channel for done-for-you feed help.
 *
 * `reply_to` comes from `WELCOME_REPLY_TO` (falls back to `AUTH_EMAIL_FROM`).
 * The owner is NOT bcc'd here — per-signup owner notifications were replaced by
 * the daily owner digest (see `sendOwnerDigest` + worker/cron).
 */
export async function sendWelcomeEmail(env: Env, to: string): Promise<void> {
  const editor = `${env.APP_ORIGIN}/`;
  const quickStart = `${env.APP_ORIGIN}/docs/quick-start/`;
  const hostedPublishing = `${env.APP_ORIGIN}/docs/hosted-publishing/`;
  await send(env, {
    to,
    subject: 'Welcome to GTFS·X — your account is ready',
    replyTo: env.WELCOME_REPLY_TO || env.AUTH_EMAIL_FROM,
    html: wrap(`
      <p>Your GTFS·X account is active. You can build, validate, and publish GTFS feeds right in the browser.</p>
      <p><a href="${editor}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Open the editor</a></p>
      <p>Two good places to start:</p>
      <ul style="padding-left: 18px; color: #333;">
        <li><a href="${quickStart}" style="color: #8a5a3b;">Quick start</a> walks you through building or importing your first feed.</li>
        <li><a href="${hostedPublishing}" style="color: #8a5a3b;">Hosted publishing</a> puts your feed on a stable public URL for riders and apps.</li>
      </ul>
      <p>The fastest way to see it click: import or draw a route, then save (or publish) your first feed.</p>
      <p style="color: #666; font-size: 13px;">Rather not build it yourself? Just reply. We also fix and publish feeds for agencies.</p>
    `),
    text:
      `Your GTFS·X account is active. You can build, validate, and publish GTFS feeds right in the browser.\n\n` +
      `Open the editor: ${editor}\n\n` +
      `Two good places to start:\n` +
      `- Quick start: ${quickStart}\n` +
      `- Hosted publishing: ${hostedPublishing}\n\n` +
      `The fastest way to see it click: import or draw a route, then save (or publish) your first feed.\n\n` +
      `Rather not build it yourself? Just reply. We also fix and publish feeds for agencies.`,
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
 * trial_will_end` webhook (~3 days before trial end). One CTA: manage (keep
 * or cancel) the Planner subscription before the card is charged.
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
    /**
     * Whether a card is on file. The in-app no-credit-card trial has none, so
     * the copy must NOT promise a charge or a cancel-to-avoid-billing step —
     * the workspace just drops back to the free Editor. Defaults to true to
     * preserve the original Stripe-trial copy for any legacy caller.
     */
    hasCard?: boolean;
  },
): Promise<void> {
  const date = escapeHtml(opts.trialEndDate);
  const price = escapeHtml(opts.monthlyPriceLabel);
  const manage = escapeHtml(opts.manageLink);
  const hasCard = opts.hasCard ?? true;

  if (!hasCard) {
    await send(env, {
      to,
      subject: `Your GTFS·X Planner trial ends ${opts.trialEndDate}`,
      html: wrap(`
        <p>Your 14-day Planner trial ends on <strong>${date}</strong>. There's no credit card on file, so nothing will be charged, your workspace simply returns to the free Editor on that date.</p>
        <p style="margin: 18px 0;"><a href="${manage}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Subscribe to keep Planner</a></p>
        <p style="color: #666; font-size: 13px;">Planner is ${price}. Subscribe any time to keep your hosted feeds, embeds, and the full planning suite.</p>
      `),
      text:
        `Your 14-day Planner trial ends on ${opts.trialEndDate}.\n\n` +
        `There's no credit card on file, so nothing will be charged, your workspace simply returns to the free Editor on that date.\n\n` +
        `Planner is ${opts.monthlyPriceLabel}. Subscribe any time to keep Planner: ${opts.manageLink}`,
    });
    return;
  }

  await send(env, {
    to,
    subject: `Your GTFS·X Planner trial ends ${opts.trialEndDate}`,
    html: wrap(`
      <p>Your 14-day Planner trial ends on <strong>${date}</strong>. The card on file will be charged ${price} on that date unless you cancel before then.</p>
      <p style="margin: 18px 0;"><a href="${manage}" style="display: inline-block; background: #8a5a3b; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none;">Manage subscription</a></p>
      <p style="color: #666; font-size: 13px;">Or do nothing and stay on Planner. Either is fine.</p>
    `),
    text:
      `Your 14-day Planner trial ends on ${opts.trialEndDate}.\n\n` +
      `The card on file will be charged ${opts.monthlyPriceLabel} on that date unless you cancel before then.\n\n` +
      `Manage your subscription: ${opts.manageLink}\n\n` +
      `Or do nothing and stay on Planner. Either is fine.`,
  });
}

// Internal notification to the GTFS·X owner inbox whenever someone subscribes to
// a paid plan (Planner). Fired best-effort from the checkout webhook; no-op
// when OWNER_NOTIFY_EMAIL isn't configured. Does NOT fire for comp/manual grants
// (those never go through Stripe checkout).
export async function sendUpgradeNotification(
  env: Env,
  opts: { plan: 'agency'; ownerType: string; email: string; amountTotal: number | null },
): Promise<void> {
  const to = env.OWNER_NOTIFY_EMAIL;
  if (!to) return;
  const planLabel = 'Planner';
  const email = escapeHtml(opts.email);
  const billedTo = opts.ownerType === 'org' ? 'an organization' : 'a user';
  const amount = opts.amountTotal != null ? `$${(opts.amountTotal / 100).toFixed(2)}` : '—';
  await send(env, {
    to,
    subject: `New ${planLabel} subscriber: ${opts.email}`,
    html: wrap(`
      <p>🎉 A new <strong>${planLabel}</strong> subscription was just created on gtfsx.com.</p>
      <p><strong>Customer:</strong> ${email}<br />
         <strong>Billed to:</strong> ${billedTo}<br />
         <strong>Checkout total:</strong> ${amount}</p>
    `),
    text: `New ${planLabel} subscriber: ${opts.email} (billed to ${billedTo}). Checkout total: ${amount}.`,
  });
}

// Internal notification to the GTFS·X owner inbox whenever someone submits the
// /book-demo lead form (POST /api/demo-leads). Fired best-effort by the lead
// handler and no-op when OWNER_NOTIFY_EMAIL isn't configured. `reply_to` is set
// to the lead's own email so the owner can reply straight to them.
export async function sendDemoLeadNotification(
  env: Env,
  lead: { name: string; email: string; org: string; message: string | null; src: string | null },
): Promise<void> {
  const to = env.OWNER_NOTIFY_EMAIL;
  if (!to) return;
  const name = escapeHtml(lead.name);
  const email = escapeHtml(lead.email);
  const org = escapeHtml(lead.org);
  const src = lead.src ? escapeHtml(lead.src) : '—';
  const messageHtml = lead.message
    ? `<p style="margin: 14px 0 0;"><strong>What they want to see:</strong><br />${escapeHtml(lead.message)}</p>`
    : '';
  await send(env, {
    to,
    subject: `New demo request: ${lead.org} (${lead.email})`,
    replyTo: lead.email,
    html: wrap(`
      <p>📅 A new demo request came in from the /book-demo form.</p>
      <p><strong>Name:</strong> ${name}<br />
         <strong>Email:</strong> ${email}<br />
         <strong>Agency / org:</strong> ${org}<br />
         <strong>Source:</strong> ${src}</p>
      ${messageHtml}
      <p style="color: #666; font-size: 13px; margin: 18px 0 0;">Reply to this email to reach them directly.</p>
    `),
    text:
      `New demo request from the /book-demo form.\n\n` +
      `Name:        ${lead.name}\n` +
      `Email:       ${lead.email}\n` +
      `Agency/org:  ${lead.org}\n` +
      `Source:      ${lead.src ?? '—'}\n` +
      (lead.message ? `\nWhat they want to see:\n${lead.message}\n` : '') +
      `\nReply to this email to reach them directly.`,
  });
}

// Internal alert to the GTFS·X owner inbox when the Google Ads OCI uploader has
// trouble — any row failures, permanent-failure flags, or a fatal (auth) error.
// Best-effort and no-op when OWNER_NOTIFY_EMAIL is unset. This is the guard
// against the failure mode that hid a month-long outage: the uploader marking
// Google's rejections as "uploaded" with nobody watching. The sample error
// text is included verbatim so the actual Google message (e.g.
// CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE) lands in Mark's inbox.
export interface OciAlertSummary {
  attempted: number;
  uploaded: number;
  failedThisRun: number;
  markedPermanentlyFailed: number;
  /** A few representative Google error messages from this run. */
  sampleErrors: string[];
  /** Present when the whole run threw (e.g. OAuth token exchange failed). */
  fatal?: string;
}

export async function sendOciAlert(env: Env, summary: OciAlertSummary): Promise<void> {
  const to = env.OWNER_NOTIFY_EMAIL;
  if (!to) return;
  const statusUrl = `${env.APP_ORIGIN}/api/admin/events/oci-status`;
  const headline = summary.fatal
    ? 'The Google Ads conversion uploader failed to run.'
    : `The Google Ads conversion uploader had ${summary.failedThisRun} rejected `
      + `row(s)${summary.markedPermanentlyFailed ? ` (${summary.markedPermanentlyFailed} now permanently failed)` : ''}.`;
  const samples = summary.sampleErrors.slice(0, 5);
  const samplesHtml = summary.fatal
    ? `<p style="margin:14px 0 0;"><strong>Error:</strong><br /><code>${escapeHtml(summary.fatal)}</code></p>`
    : samples.length
      ? `<p style="margin:14px 0 0;"><strong>Sample errors from Google:</strong></p><ul>`
        + samples.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('') + `</ul>`
      : '';
  await send(env, {
    to,
    subject: 'GTFS·X: Google Ads conversion upload needs attention',
    html: wrap(`
      <p>⚠️ ${escapeHtml(headline)}</p>
      <p><strong>Attempted:</strong> ${summary.attempted} &nbsp;·&nbsp;
         <strong>Uploaded:</strong> ${summary.uploaded} &nbsp;·&nbsp;
         <strong>Failed:</strong> ${summary.failedThisRun}</p>
      ${samplesHtml}
      <p style="margin:18px 0 0;"><a href="${escapeHtml(statusUrl)}">Open the OCI status page</a> for detail.</p>
    `),
    text:
      `${headline}\n\n` +
      `Attempted: ${summary.attempted}\nUploaded: ${summary.uploaded}\nFailed: ${summary.failedThisRun}\n` +
      (summary.markedPermanentlyFailed ? `Permanently failed: ${summary.markedPermanentlyFailed}\n` : '') +
      (summary.fatal ? `\nError:\n${summary.fatal}\n` : samples.length ? `\nSample errors from Google:\n${samples.map((s) => `- ${s}`).join('\n')}\n` : '') +
      `\nStatus page: ${statusUrl}`,
  });
}

/** Metrics rendered by the daily owner digest. Computed in worker/cron/tasks.ts. */
export interface OwnerDigestMetrics {
  /** New user rows created in the last 24h (matches Admin "signups"). */
  signups24h: number;
  /** Distinct users with a session active in the last 24h (matches Admin "active users / 24h"). */
  activeUsers24h: number;
  /** Paid subscription rows first recorded in the last 24h. */
  newPaidSubs24h: number;
  /** Running total: all user rows ever (matches Admin "signups all-time"). */
  totalUsers: number;
  /** Running total: currently active/trialing paid subscriptions. */
  activePaidSubs: number;
  /** Window label, e.g. "Jun 26 → Jun 27, 2026 (UTC)". */
  windowLabel: string;
}

/**
 * Daily owner digest — replaces the per-signup BCC. Three headline numbers over
 * the trailing 24h (new sign-ups, active users, new paid subscriptions) plus
 * cheap running totals. Sent best-effort to the owner inbox; the caller
 * (worker/cron/tasks.ts → runOwnerDigest) handles the enable flag + recipient
 * resolution and swallows failures so a Resend hiccup never breaks the cron.
 */
export async function sendOwnerDigest(
  env: Env,
  to: string,
  m: OwnerDigestMetrics,
): Promise<void> {
  const row = (label: string, value: number, hint: string) => `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
          <div style="font-size: 13px; color: #666;">${label}</div>
          <div style="font-size: 12px; color: #aaa;">${hint}</div>
        </td>
        <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0; text-align: right; font-size: 24px; font-weight: 600; color: #1a1a1a;">${value.toLocaleString('en-US')}</td>
      </tr>`;
  await send(env, {
    to,
    subject: `GTFS·X daily: ${m.signups24h} new · ${m.activeUsers24h} active · ${m.newPaidSubs24h} paid`,
    html: wrap(`
      <p style="margin: 0 0 4px;">Activity for the last 24 hours.</p>
      <p style="color: #888; font-size: 12px; margin: 0 0 16px;">${escapeHtml(m.windowLabel)}</p>
      <table style="width: 100%; border-collapse: collapse;">
        ${row('New sign-ups', m.signups24h, 'accounts created')}
        ${row('Active users', m.activeUsers24h, 'distinct sessions used')}
        ${row('New paid subscriptions', m.newPaidSubs24h, 'Planner / Enterprise')}
      </table>
      <p style="color: #666; font-size: 13px; margin: 18px 0 0;">
        Running totals: <strong>${m.totalUsers.toLocaleString('en-US')}</strong> users ·
        <strong>${m.activePaidSubs.toLocaleString('en-US')}</strong> active paid subscriptions.
      </p>
      <p style="margin: 18px 0 0;"><a href="${env.APP_ORIGIN}/admin" style="color: #8a5a3b;">Open the admin dashboard →</a></p>
    `),
    text:
      `GTFS·X daily digest — ${m.windowLabel}\n\n` +
      `New sign-ups (24h):          ${m.signups24h}\n` +
      `Active users (24h):          ${m.activeUsers24h}\n` +
      `New paid subscriptions (24h): ${m.newPaidSubs24h}\n\n` +
      `Running totals: ${m.totalUsers} users, ${m.activePaidSubs} active paid subscriptions.\n\n` +
      `Admin dashboard: ${env.APP_ORIGIN}/admin`,
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
