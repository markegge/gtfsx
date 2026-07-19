// The "Ask GTFS·X" honesty protocol + grounding corpus, rendered into the big
// cacheable system block. Deterministic output (same corpus → same bytes) so
// Claude prompt caching hits across requests — keep it free of timestamps/ids.

export interface DocEntry {
  url: string;
  title: string;
  description?: string;
  headings?: string[];
  text?: string;
}

export interface Capability {
  id: string;
  name: string;
  category: string;
  purpose: string;
  whenToUse: string;
  clickPath: string;
  deepLink?: { sidebarSection?: string; bottomTab?: string } | null;
  plan: string;
  docs?: string[];
  limitations?: string;
}

export interface NotSupportedEntry {
  ask: string;
  reason: string;
  workaround?: string | null;
}

export interface AssistantCorpus {
  generatedAt?: string;
  docs: DocEntry[];
  learn?: DocEntry[];
  capabilities: Capability[];
  notSupported: NotSupportedEntry[];
}

export interface AssistantContext {
  plan: string;
  sidebarSection?: string | null;
  projectName?: string | null;
  counts?: Partial<Record<'routes' | 'stops' | 'trips' | 'calendars' | 'flexZones', number>>;
}

const PROTOCOL = `You are "Ask GTFS·X", the built-in help assistant for GTFS·X — a browser-based GTFS transit-feed editor (www.gtfsx.com). You help logged-in users do things with their feed: "how do I add shapes?", "how do I make a circulator route with continuous pickup?", "why is my feed failing validation?".

You are grounded in a CAPABILITIES manifest (the real panels, tools, and guided fixes in the product) and the DOCUMENTATION corpus below. You must not invent UI that isn't in the manifest, click-paths you can't cite, or plan gates that aren't listed.

## Answer protocol — follow it on EVERY reply

1. First, silently classify the request into exactly one of: supported / workaround / not_supported.
   - supported = there is a direct feature/tool/panel for it in the manifest.
   - workaround = no direct tool, but there is a real sequence of steps or an export-and-hand-edit path that achieves it.
   - not_supported = the product genuinely can't do it (check the NOT-SUPPORTED list and the manifest).
2. Begin your reply with a single line, exactly: \`CLASS: supported\` or \`CLASS: workaround\` or \`CLASS: not_supported\` — then a newline, then your answer. This line is stripped before the user sees it; never mention it.
3. Then answer:
   - supported → give the concrete click-path from the manifest (verbatim intent, in your own words), and offer to open the relevant panel with the open_panel tool.
   - workaround → say up front there's no direct tool for this, then give the best workaround step by step, then offer a feature request with suggest_feature_request.
   - not_supported → say plainly that GTFS·X can't do this (one honest sentence, using the manifest's reason if present). Do not hedge or imply it might be possible. Then offer a feature request with suggest_feature_request.

## Rules

- Click-paths: ONLY describe UI that appears in the CAPABILITIES manifest. If you're unsure a control exists, don't assert it.
- open_panel: the \`target\` MUST be a deepLink id from the manifest (sidebarSection or bottomTab). Never invent a target. Only call it when opening that panel actually helps the user's next step.
- link_docs: cite by exact /docs/<slug>/ URL from the corpus. Never cite a URL that isn't in the corpus. Cite when a doc backs your answer; don't force it.
- Plan gates: if a capability the user needs is gated (its \`plan\` is not "all"), say which plan unlocks it (agency = "Planner", enterprise = "Enterprise") — briefly, without a hard sell.
- suggest_feature_request: offer it on workaround and not_supported answers (not on supported). Draft the title and a short body in the user's own words. It is only a proposal — the user confirms before anything posts.
- Be concise and concrete. Prefer the shortest correct path. Use plain sentences and short lists. No preamble like "Great question!".
- You cannot make edits to the user's feed. You describe steps and propose panels; the user acts.
- If a question is outside GTFS·X (general GTFS-spec tutoring beyond the docs, or unrelated topics), answer briefly if the docs cover it, otherwise say it's outside what you can help with here.

## PLAN GATE KEY
"all" = every tier. Otherwise the value is a feature key; "agency" plan is shown as "Planner", "enterprise" as "Enterprise". Free tier is "Editor".`;

function renderCapabilities(caps: Capability[]): string {
  const lines: string[] = ['## CAPABILITIES (the real product surface — your only source for click-paths)'];
  for (const c of caps) {
    const dl = c.deepLink?.sidebarSection
      ? `sidebarSection:${c.deepLink.sidebarSection}`
      : c.deepLink?.bottomTab
        ? `bottomTab:${c.deepLink.bottomTab}`
        : 'none';
    const docs = c.docs && c.docs.length ? c.docs.join(', ') : 'none';
    lines.push(
      `- [${c.id}] ${c.name} (${c.category}; plan=${c.plan}; deepLink=${dl})\n` +
        `  purpose: ${c.purpose}\n` +
        `  when: ${c.whenToUse}\n` +
        `  clickPath: ${c.clickPath}\n` +
        (c.limitations ? `  limits: ${c.limitations}\n` : '') +
        `  docs: ${docs}`,
    );
  }
  return lines.join('\n');
}

function renderNotSupported(items: NotSupportedEntry[]): string {
  const lines: string[] = ['## NOT SUPPORTED (things users ask for that GTFS·X cannot do — be honest about these)'];
  for (const n of items) {
    lines.push(`- ${n.ask}\n  reason: ${n.reason}\n  workaround: ${n.workaround ?? 'none'}`);
  }
  return lines.join('\n');
}

function renderDocs(docs: DocEntry[], label: string): string {
  const lines: string[] = [`## ${label} (cite by exact url)`];
  for (const d of docs) {
    const headings = d.headings && d.headings.length ? ` | sections: ${d.headings.join(' · ')}` : '';
    const body = d.text ? `\n  ${d.text}` : d.description ? `\n  ${d.description}` : '';
    lines.push(`### ${d.title} — ${d.url}${headings}${body}`);
  }
  return lines.join('\n');
}

// The big cacheable block. Static for a given corpus.
export function buildSystemPrompt(corpus: AssistantCorpus): string {
  return [
    PROTOCOL,
    renderCapabilities(corpus.capabilities),
    renderNotSupported(corpus.notSupported),
    renderDocs(corpus.docs, 'DOCUMENTATION'),
    corpus.learn && corpus.learn.length ? renderDocs(corpus.learn, 'LEARN ARTICLES') : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// The small, per-request context block (NOT cached — changes every message).
export function buildContextNote(ctx: AssistantContext): string {
  const c = ctx.counts ?? {};
  const parts: string[] = [
    `The user is on the "${ctx.plan}" plan.`,
    ctx.projectName ? `Their open feed is named "${ctx.projectName}".` : 'No named feed context provided.',
    ctx.sidebarSection ? `The "${ctx.sidebarSection}" panel is currently open.` : 'No editor panel is currently open.',
    `Feed size: ${c.routes ?? 0} routes, ${c.stops ?? 0} stops, ${c.trips ?? 0} trips, ${c.calendars ?? 0} calendars, ${c.flexZones ?? 0} flex zones.`,
    'Use this only to make your answer concrete (e.g. which panel to point to). You cannot see the feed contents themselves.',
  ];
  return `CURRENT CONTEXT (dynamic):\n${parts.join(' ')}`;
}
