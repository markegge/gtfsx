// ───────────────────────────────────────────────────────────────────────────
// Pretty-printers for audit events. Kept in one place so both the per-project
// and per-user audit views render the same labels. Unrecognized actions fall
// back to a lightly cleaned-up version of the raw string (e.g.
// "foo.bar_baz" → "Foo bar baz").
// ───────────────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  // Project / feed
  'project.create': 'Created project',
  'project.update': 'Updated project',
  'project.delete': 'Deleted project',
  'project.save_working_state': 'Saved draft',
  'project.create_snapshot': 'Saved snapshot',
  'project.restore_snapshot': 'Restored snapshot',
  'project.delete_snapshot': 'Deleted snapshot',
  // Legacy entries from before the version → snapshot rename (kept so old
  // audit_event rows still render with a friendly label).
  'project.create_version': 'Saved snapshot',
  'project.restore_version': 'Restored snapshot',
  'project.delete_version': 'Deleted snapshot',
  'project.publish': 'Published',
  'project.unpublish': 'Unpublished',
  'project.create_draft_link': 'Created draft link',
  'project.revoke_draft_link': 'Revoked draft link',
  'project.catalog_opt_in': 'Opted in to catalog',
  'project.catalog_opt_out': 'Opted out of catalog',
  'project.rt_feeds_update': 'Updated RT feeds',
  'project.rt_feed_delete': 'Removed RT feed',
  'project.imported_from_local': 'Imported from local',

  // User / account
  'user.signup': 'Signed up',
  'user.signup.email_failed': 'Signup email failed',
  'user.verify_email': 'Verified email',
  'user.update_profile': 'Updated profile',
  'user.change_email_requested': 'Requested email change',
  'user.change_email': 'Changed email',
  'user.change_password': 'Changed password',
  'user.delete': 'Deleted account',
  'user.data_export': 'Exported account data',

  // Sessions
  'session.login': 'Signed in',
  'session.logout': 'Signed out',
  'session.logout_all': 'Signed out of all devices',

  // Orgs
  'org.create': 'Created organization',
  'org.update': 'Updated organization',
  'org.delete': 'Deleted organization',
  'org.invitation_sent': 'Sent org invitation',
  'org.invitation_rescinded': 'Rescinded org invitation',
  'org.member_joined': 'Joined organization',
  'org.member_removed': 'Removed org member',
  'org.member_left': 'Left organization',
  'org.member_role_changed': 'Changed org member role',
  'org.ownership_transferred': 'Transferred ownership',

  // Admin
  'admin.user.patch': 'Admin — updated user',
  'admin.user.resend_verification': 'Admin — resent verification',
  'admin.user.delete': 'Admin — deleted user',
  'admin.impersonate.start': 'Admin — started impersonation',
  'admin.impersonate.end': 'Admin — ended impersonation',
  'admin.org.member.patch': 'Admin — updated org member',
  'admin.org.member.remove': 'Admin — removed org member',
};

export function prettyAction(action: string): string {
  if (ACTION_LABELS[action]) return ACTION_LABELS[action];
  // Fallback: "project.save_working_state" → "Project save working state"
  const cleaned = action
    .replace(/_/g, ' ')
    .replace(/\./g, ' ')
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function summarizeMetadata(metadataJson: string | null): string {
  if (!metadataJson) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadataJson);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return '';

  const parts: string[] = [];
  for (const key of keys) {
    const value = obj[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      // Flatten shallowly — e.g. {removed: {agencies: 3}}
      parts.push(`${key}: …`);
      continue;
    }
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.slice(0, 4).join(' · ');
}

export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
