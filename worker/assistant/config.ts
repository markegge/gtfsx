// "Ask GTFS·X" assistant — central config. One place to swap the model or tune
// quotas / limits. See docs/REQUIREMENTS.md + issue #68.

import type { Plan } from '../projects/quotas';

// Model id in ONE constant so it can be swapped without touching the routes.
// claude-sonnet-5: help answers need judgment about "possible vs. awkward vs.
// impossible" — not a place to cheap out. Called via direct Claude API fetch.
export const ASSISTANT_MODEL = 'claude-sonnet-5';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

// Output cap per answer. Help answers are short; streaming isn't gated by this.
export const ASSISTANT_MAX_TOKENS = 1024;

// Per-plan daily message quota (server-enforced). Free-tier users are exactly
// who has "how do I" questions and every deflected support email is the point,
// so all tiers get access — the differentiation is the daily cap.
export const ASSISTANT_DAILY_QUOTA: Record<Plan, number> = {
  free: 10,
  agency: 100,
  enterprise: 500,
};

// Conversation caps (defence-in-depth against oversized requests; the client
// also trims). Counted in turns and characters.
export const MAX_CONVERSATION_TURNS = 24;
export const MAX_MESSAGE_CHARS = 4000;

// Whether the assistant is configured to run in this environment. When the key
// is absent the endpoint returns a clean 503 the UI surfaces gracefully rather
// than 500-ing.
export function assistantConfigured(env: { ANTHROPIC_API_KEY?: string }): boolean {
  return typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.length > 0;
}
