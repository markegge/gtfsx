// Group validation messages by rule so a feed with hundreds of the SAME issue
// (e.g. 832 trips each "missing arrival_time or departure_time") collapses to one
// "832×" summary row instead of an unscrollable wall. Pairs with the grouped
// view + right-rail fix recipe in components/validation/ValidationPanel.tsx and
// the batch fix in services/validationFixes.ts.
//
// GROUPING KEY: a message's stable rule `code` when it has one (only the
// dismissible rules carry a code — see VALIDATION_CODES in validation.ts), else
// a TEMPLATE derived from the message text by blanking the entity-specific bits
// (quoted ids/names and numbers). Severity is folded into the key so an error
// and a warning that happen to share a template never merge. The template is a
// PROXY for the rule, kept here so we don't have to mint a dismiss-enabling
// `code` on every rule just to group it (codes are the dismiss key — see ui.ts).
import type { ValidationMessage, ValidationFixId } from '../types/ui';
import { getValidationFix } from './validationFixes';

export interface ValidationGroup {
  /** Stable identity for this group across re-validations (code or severity+template). */
  key: string;
  /** Present only when every message in the group shares a dismissible rule code;
   *  lets the grouped view offer a single "dismiss this rule" affordance. */
  code?: string;
  severity: 'error' | 'warning';
  /** Templated, entity-agnostic representative summary (placeholders for ids/nums). */
  summary: string;
  /** Total messages in the group (the "832×" count). */
  count: number;
  /** How many of those carry a registered one-click fix (batch-fixable). */
  fixableCount: number;
  /** The fix id shared by the group's fixable messages (first one wins; all
   *  messages in a template group emit the same rule, so the same fix). */
  fixId?: ValidationFixId;
  /** The individual messages, in original order (rendered only when expanded). */
  messages: ValidationMessage[];
}

/**
 * Collapse a message to its rule TEMPLATE: quoted ids/names → `"…"`, numbers
 * (and percentages, times, dates — any digit run) → `#`. Two messages from the
 * same rule that differ only by which entity they name collapse to one template.
 */
export function templateOfMessage(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+(?:\.\d+)?%?/g, '#');
}

/** The grouping key for a single message: its rule code, else severity + template. */
export function groupKeyOf(m: ValidationMessage): string {
  if (m.code) return `code:${m.code}`;
  return `tpl:${m.severity}:${templateOfMessage(m.message)}`;
}

/**
 * Aggregate messages into one group per rule, ordered errors-first then by
 * descending count (the big offenders rise to the top). The representative
 * `summary` is the templated text of the group's first message. A group exposes
 * a `code` only when ALL its messages share the same code (so the grouped view
 * can safely dismiss the whole class by that code).
 */
export function groupValidationMessages(messages: ValidationMessage[]): ValidationGroup[] {
  const byKey = new Map<string, ValidationGroup>();
  for (const m of messages) {
    const key = groupKeyOf(m);
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        code: m.code,
        severity: m.severity,
        summary: templateOfMessage(m.message),
        count: 0,
        fixableCount: 0,
        messages: [],
      };
      byKey.set(key, g);
    }
    // A group's code only stands if every member shares it (defensive — same key
    // implies same code, but a template group must never claim a stray code).
    if (g.code !== m.code) g.code = undefined;
    g.messages.push(m);
    g.count++;
    if (m.fix && getValidationFix(m.fix.id)) {
      g.fixableCount++;
      if (!g.fixId) g.fixId = m.fix.id;
    }
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return b.count - a.count;
  });
}
