// Per-user data export. Builds a ZIP containing:
//   - profile.json       (user row + memberships; no password hash)
//   - audit.json         (all audit events where user is actor or subject)
//   - projects/<slug>/working-state.json         (decoded from R2 blob)
//   - projects/<slug>/versions/<vid>/state.json  (decoded)
//   - projects/<slug>/versions/<vid>/summary.json
//
// The ZIP is streamed to the client via JSZip's internal stream helper piped
// through a ReadableStream, so we never fully buffer a 50 MB feed in memory.

import JSZip from 'jszip';
import type { Env, AuthedUser } from '../env';
import { getFeedBlob } from '../projects/r2';

export const EXPORT_RATE_KEY_PREFIX = 'me:export:';
export const EXPORT_RATE_WINDOW_SEC = 24 * 60 * 60; // 24 hours

export interface BuiltExport {
  body: ReadableStream<Uint8Array>;
  filename: string;
}

export async function buildUserExport(env: Env, user: AuthedUser): Promise<BuiltExport> {
  const zip = new JSZip();

  // ── profile.json ─────────────────────────────────────────────────────────
  const profileRow = await env.DB.prepare(
    `SELECT id, email, display_name, status, staff, created_at, updated_at, deleted_at
       FROM user WHERE id = ?`,
  )
    .bind(user.id)
    .first<{
      id: string;
      email: string;
      display_name: string;
      status: string;
      staff: number;
      created_at: number;
      updated_at: number;
      deleted_at: number | null;
    }>();

  const memberships = await env.DB.prepare(
    `SELECT m.org_id, m.role, m.created_at, o.slug AS org_slug, o.name AS org_name
       FROM organization_membership m
       JOIN organization o ON o.id = m.org_id
      WHERE m.user_id = ?`,
  )
    .bind(user.id)
    .all<{
      org_id: string;
      role: string;
      created_at: number;
      org_slug: string;
      org_name: string;
    }>();

  const profile = {
    user: profileRow
      ? {
          id: profileRow.id,
          email: profileRow.email,
          displayName: profileRow.display_name,
          status: profileRow.status,
          staff: profileRow.staff === 1,
          createdAt: profileRow.created_at,
          updatedAt: profileRow.updated_at,
          deletedAt: profileRow.deleted_at,
        }
      : null,
    memberships: (memberships.results ?? []).map((m) => ({
      orgId: m.org_id,
      orgSlug: m.org_slug,
      orgName: m.org_name,
      role: m.role,
      createdAt: m.created_at,
    })),
    exportedAt: Date.now(),
  };
  zip.file('profile.json', JSON.stringify(profile, null, 2));

  // ── audit.json ───────────────────────────────────────────────────────────
  const auditRows = await env.DB.prepare(
    `SELECT e.id, e.actor_user_id, e.subject_type, e.subject_id, e.action,
            e.metadata_json, e.created_at
       FROM audit_event e
      WHERE e.actor_user_id = ?
         OR (e.subject_type = 'user' AND e.subject_id = ?)
      ORDER BY e.id ASC`,
  )
    .bind(user.id, user.id)
    .all<{
      id: string;
      actor_user_id: string | null;
      subject_type: string;
      subject_id: string | null;
      action: string;
      metadata_json: string | null;
      created_at: number;
    }>();

  const auditEvents = (auditRows.results ?? []).map((r) => ({
    id: r.id,
    actorUserId: r.actor_user_id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    action: r.action,
    metadata: r.metadata_json ? safeJsonParse(r.metadata_json) : null,
    createdAt: r.created_at,
  }));
  zip.file('audit.json', JSON.stringify({ events: auditEvents }, null, 2));

  // ── projects/<slug>/... ──────────────────────────────────────────────────
  const projectRows = await env.DB.prepare(
    `SELECT id, slug, name, description, working_state_r2_key, working_state_version,
            working_state_size, working_state_updated_at, archived_at, created_at, updated_at
       FROM feed_project
      WHERE owner_type = 'user' AND owner_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC`,
  )
    .bind(user.id)
    .all<{
      id: string;
      slug: string;
      name: string;
      description: string | null;
      working_state_r2_key: string | null;
      working_state_version: number;
      working_state_size: number | null;
      working_state_updated_at: number | null;
      archived_at: number | null;
      created_at: number;
      updated_at: number;
    }>();

  const slugsUsed = new Set<string>();
  for (const p of projectRows.results ?? []) {
    // Make sure slug is unique within the ZIP (shouldn't collide because slugs
    // are unique per-owner but belt-and-suspenders).
    let slug = p.slug;
    let suffix = 1;
    while (slugsUsed.has(slug)) {
      slug = `${p.slug}-${suffix}`;
      suffix += 1;
    }
    slugsUsed.add(slug);

    const projectFolder = `projects/${slug}`;
    zip.file(
      `${projectFolder}/project.json`,
      JSON.stringify(
        {
          id: p.id,
          slug: p.slug,
          name: p.name,
          description: p.description,
          workingStateVersion: p.working_state_version,
          workingStateSize: p.working_state_size,
          workingStateUpdatedAt: p.working_state_updated_at,
          archivedAt: p.archived_at,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        },
        null,
        2,
      ),
    );

    if (p.working_state_r2_key) {
      const decoded = await fetchDecodedBlob(env, p.working_state_r2_key);
      if (decoded != null) {
        zip.file(`${projectFolder}/working-state.json`, decoded);
      }
    }

    const snapshotRows = await env.DB.prepare(
      `SELECT id, label, state_r2_key, zip_r2_key, zip_size, summary_json,
              validation_errors, validation_warnings, created_at, created_by_user_id
         FROM feed_snapshot WHERE project_id = ? ORDER BY created_at ASC`,
    )
      .bind(p.id)
      .all<{
        id: string;
        label: string | null;
        state_r2_key: string;
        zip_r2_key: string;
        zip_size: number;
        summary_json: string;
        validation_errors: number;
        validation_warnings: number;
        created_at: number;
        created_by_user_id: string | null;
      }>();

    for (const v of snapshotRows.results ?? []) {
      const vFolder = `${projectFolder}/snapshots/${v.id}`;
      zip.file(
        `${vFolder}/summary.json`,
        JSON.stringify(
          {
            id: v.id,
            label: v.label,
            summary: safeJsonParse(v.summary_json),
            validationErrors: v.validation_errors,
            validationWarnings: v.validation_warnings,
            zipSize: v.zip_size,
            createdAt: v.created_at,
            createdByUserId: v.created_by_user_id,
          },
          null,
          2,
        ),
      );
      if (v.state_r2_key) {
        const decoded = await fetchDecodedBlob(env, v.state_r2_key);
        if (decoded != null) {
          zip.file(`${vFolder}/state.json`, decoded);
        }
      }
    }
  }

  const body = zipToStream(zip);
  const filename = formatFilename(user.email);
  return { body, filename };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * R2 blobs are stored gzipped (Content-Encoding: gzip). For the export we want
 * plain JSON — decompress first. Returns null if the blob is missing.
 */
async function fetchDecodedBlob(env: Env, key: string): Promise<string | null> {
  const obj = await getFeedBlob(env, key);
  if (!obj) return null;
  const encoding = obj.httpMetadata?.contentEncoding;
  if (encoding === 'gzip') {
    const stream = (obj.body as ReadableStream<Uint8Array>).pipeThrough(
      new DecompressionStream('gzip'),
    );
    return await new Response(stream).text();
  }
  return await obj.text();
}

/**
 * Pipe JSZip's internal data stream into a ReadableStream the Worker can
 * return as a Response body. The chunks come as Uint8Array when we pass
 * `type: 'uint8array'`.
 */
function zipToStream(zip: JSZip): ReadableStream<Uint8Array> {
  const stream = zip.generateInternalStream({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Uint8Array) => {
        try {
          controller.enqueue(chunk);
        } catch {
          // controller might be closed if the consumer cancels.
        }
      });
      stream.on('error', (err: Error) => {
        try {
          controller.error(err);
        } catch {
          /* ignore */
        }
      });
      stream.on('end', () => {
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      });
      stream.resume();
    },
    cancel() {
      try {
        stream.pause();
      } catch {
        /* ignore */
      }
    },
  });
}

function formatFilename(email: string): string {
  const safeEmail = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `gtfs-builder-export-${safeEmail}-${yyyy}-${mm}-${dd}.zip`;
}
