// Claude tool definitions surfaced to the "Ask GTFS·X" model. The model PROPOSES;
// the client renders each tool_use as a button/chip/card and the user acts.
// v1 never mutates the feed — these tools carry no side effects server-side;
// they are structured UI intents streamed to the client as `tool` SSE events.

export interface AssistantTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// Whitelisted deep-link targets are enforced on the CLIENT against the real
// SidebarSection / BottomPanelTab unions (src/assistant/deepLinkTargets.ts).
// We describe them to the model in the system prompt (built from the manifest),
// not by enum here, so the tool schema stays stable for prompt caching.
export const ASSISTANT_TOOLS: AssistantTool[] = [
  {
    name: 'open_panel',
    description:
      "Propose opening a specific editor panel so the user can do the thing you just described. Rendered as an action button (\"Open the Frequencies panel\"). The user clicks it; it never opens automatically. `target` MUST be one of the deepLink ids listed in the capabilities section of the system prompt — do not invent ids.",
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'A deepLink target id from the capabilities manifest — either a right-rail section id (e.g. "frequencies", "routes", "flex") or a bottom-panel tab id (e.g. "validation", "timetable", "publish").',
        },
        label: {
          type: 'string',
          description: 'Short button label, e.g. "Open Frequencies" or "Open the Validation tab".',
        },
      },
      required: ['target', 'label'],
    },
  },
  {
    name: 'link_docs',
    description:
      'Cite a documentation page that backs your answer. Rendered as a docs-link chip. `url` MUST be one of the docs URLs listed in the capabilities section of the system prompt.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A /docs/<slug>/ URL from the corpus.' },
        title: { type: 'string', description: 'The page title to show on the chip.' },
      },
      required: ['url', 'title'],
    },
  },
  {
    name: 'suggest_feature_request',
    description:
      "Offer to file a feature request on the community forum. Use this ONLY on a workaround or not-supported answer, after you have told the user plainly what isn't possible. Rendered as a card showing the drafted title and body; the user confirms before anything is posted. Draft the body in the user's own words about what they were trying to do.",
    input_schema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A concise feature-request title (8-120 chars), e.g. "Drag-and-drop route re-routing on the map".',
        },
        body: {
          type: 'string',
          description:
            "A short markdown body: what the user is trying to do, why the current product can't, and the outcome they want. Written for the GTFS·X team to read.",
        },
      },
      required: ['title', 'body'],
    },
  },
];
