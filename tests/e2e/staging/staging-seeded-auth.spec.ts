import { test } from '@playwright/test';

/**
 * Seeded-auth staging tests — STUBS ONLY (test.fixme), not implemented yet.
 *
 * These require a signed-in user against staging, which needs a seeded
 * account rather than a real signup flow. See ../README.md ("Seeding an
 * auth'd user for staging tests") for the seeding approach
 * (scripts/dev-seed-user.ts --env staging --remote) and why it isn't wired
 * into a fixture yet. NEVER point this at production; NEVER commit
 * production credentials.
 *
 * Each stub below is test.fixme() with its intended steps as comments, so
 * the suite structure exists and a follow-up pass can fill them in behind a
 * real seeded-session fixture.
 */

test.fixme('feed kebab actions (rename, duplicate, lock, delete/trash+restore)', async () => {
  // 1. Seed a user via `tsx scripts/dev-seed-user.ts --env staging --remote
  //    <email> <name> <password>` (or a fixture that does this once and
  //    reuses the account — see README.md), then storageState-login as that
  //    user (POST /auth/login or drive the /login form) before navigating.
  // 2. Go to /feeds (My Feeds). Create (or reuse) a seeded feed row.
  // 3. Open the feed's kebab (⋮) menu; assert Rename / Duplicate / Lock /
  //    Delete are present.
  // 4. Rename: assert the row's name updates.
  // 5. Duplicate: assert a second row appears, same content.
  // 6. Delete: assert the feed moves to Trash, not gone outright; Restore
  //    from Trash brings it back to the active list.
  // 7. Lock: assert opening a locked feed shows the "Locked — changes won't
  //    be saved here" banner (App.tsx ServerEditorRoute) and Save routes to
  //    Save As instead of autosaving in place.
});

test.fixme('org settings (members, invites, plan)', async () => {
  // 1. Seed a user + org (dev-seed-user.ts seeds a user only, not an org —
  //    creating an org may need to go through the real UI flow once signed
  //    in, or a separate seeding step; check org-creation entrypoints first).
  // 2. Go to /orgs/<slug>. Assert the members list, pending-invites panel,
  //    and billing/plan section render.
  // 3. Invite flow: submit an invite email, assert it appears in the
  //    pending-invites list with revoke/resend actions (no real email is
  //    sent to a real inbox in CI — use a throwaway address and only assert
  //    on the UI state, not on receiving the email).
  // 4. Revoke an invite; assert it's removed from the pending list.
});

test.fixme('publish panel (managed publishing + distribution)', async () => {
  // 1. Seed a user, sign in, open a seeded feed with enough content to
  //    publish (agency + at least one route/stop/trip).
  // 2. Open the bottom panel's "Share & Publish" tab (PublishWithDistribution).
  //    On a free plan this is gated by PaywallOverlay (managed_publishing) —
  //    either seed/grant a paid plan first, or assert the gate card renders
  //    (cheaper, and arguably the more useful assertion for a seeded-but-free
  //    test user).
  // 3. If plan allows: Publish; assert a public feed URL is produced and
  //    the "Open in editor" / distribution links render.
  // 4. Never publish to a real public subdomain against production — this
  //    is staging-only, and even there prefer a throwaway feed.
});
