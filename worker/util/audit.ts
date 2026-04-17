import { ulid } from 'ulidx';
import type { Env } from '../env';

// Append-only audit log. Never throws — a failed audit write should not break
// a user action. Callers pass ip from the Hono context when available.

export interface AuditInput {
  actorUserId?: string | null;
  subjectType: 'user' | 'session' | 'project' | 'org' | 'version' | 'publication';
  subjectId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}

export async function logAudit(env: Env, input: AuditInput): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_event (id, actor_user_id, subject_type, subject_id, action, metadata_json, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        ulid(),
        input.actorUserId ?? null,
        input.subjectType,
        input.subjectId ?? null,
        input.action,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.ip ?? null,
        Date.now(),
      )
      .run();
  } catch (err) {
    // We deliberately swallow — logging is best-effort.
    console.error('audit write failed', input.action, err);
  }
}
