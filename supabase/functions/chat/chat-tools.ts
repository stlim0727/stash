// The chatbot's tool surface — the Stash operations the model may call.
//
// Each tool mirrors one documented bookmark operation (docs/api/bookmarks.md /
// the public-api edge function). Tools are split by `kind`:
//   - 'read'     — safe to run automatically (search, list, fetch).
//   - 'mutating' — creates/edits/files/trashes a bookmark. These are NEVER run
//                  automatically: the loop pauses and asks the user to confirm
//                  first (see chat-loop.ts).
//
// Descriptions are deliberately prescriptive about *when* to call each tool —
// cheaper models reach for tools less reliably, and a clear trigger condition in
// the description measurably improves tool-call accuracy.
//
// Dependency-free and runtime-agnostic: the tool registry is shared by the loop,
// the adapters (which translate `parameters` into each model's function-calling
// schema), and the edge function's executor.

export type ToolKind = 'read' | 'mutating';

export interface ToolSpec {
  name: string;
  kind: ToolKind;
  description: string;
  /** JSON Schema (object) for the tool's input. Adapters translate this into
   *  the Gemini / Anthropic function-declaration shape. */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const CHAT_TOOLS: ToolSpec[] = [
  {
    name: 'search_bookmarks',
    kind: 'read',
    description:
      "Search the user's saved bookmarks. Call this whenever the user asks what they saved, " +
      'wants to find something, or refers to "my bookmarks/links/articles". Returns matching ' +
      'bookmarks with id, title, url, and notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search over title, url, notes, description.' },
        collection_id: { type: 'string', description: 'Restrict to one collection (folder) by id.' },
        tag: { type: 'string', description: 'Restrict to bookmarks carrying this tag name.' },
        limit: { type: 'integer', description: 'Max results (default 20, max 50).' },
      },
    },
  },
  {
    name: 'get_bookmark',
    kind: 'read',
    description:
      'Fetch one bookmark in full (tags + collection) by id. Call this to read details before ' +
      'answering a question about a specific saved item or before proposing an edit to it.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The bookmark id.' } },
      required: ['id'],
    },
  },
  {
    name: 'list_collections',
    kind: 'read',
    description:
      "List the user's collections (folders). Call this when filing a bookmark or when the user " +
      'asks about their folders, so you reference real collection ids and names.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_tags',
    kind: 'read',
    description: "List the user's existing tags. Call this before suggesting or applying tags.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_bookmark',
    kind: 'mutating',
    description:
      'Save a new bookmark. Call this when the user asks to save/stash/bookmark a URL, or to keep ' +
      'a text note. Provide a url for links, or shared_text for a plain note.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to save (omit for a text note).' },
        title: { type: 'string', description: 'Optional title.' },
        notes: { type: 'string', description: 'Optional user note.' },
        collection_id: { type: 'string', description: 'Optional collection to file into.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag names.' },
        shared_text: { type: 'string', description: 'Text-note content when there is no url.' },
      },
    },
  },
  {
    name: 'add_tags',
    kind: 'mutating',
    description: 'Add one or more tags to an existing bookmark.',
    parameters: {
      type: 'object',
      properties: {
        bookmark_id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to add.' },
      },
      required: ['bookmark_id', 'tags'],
    },
  },
  {
    name: 'set_collection',
    kind: 'mutating',
    description:
      'File a bookmark into a collection (or pass collection_id=null to remove it from its ' +
      'collection). Use list_collections first to get a real id.',
    parameters: {
      type: 'object',
      properties: {
        bookmark_id: { type: 'string' },
        collection_id: { type: ['string', 'null'], description: 'Target collection id, or null to unfile.' },
      },
      required: ['bookmark_id', 'collection_id'],
    },
  },
  {
    name: 'trash_bookmark',
    kind: 'mutating',
    description:
      'Move a bookmark to Trash (recoverable). Call this when the user asks to delete/remove/trash ' +
      'a saved item.',
    parameters: {
      type: 'object',
      properties: { bookmark_id: { type: 'string' } },
      required: ['bookmark_id'],
    },
  },
];

const TOOLS_BY_NAME = new Map(CHAT_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS_BY_NAME.get(name);
}

/** A tool the loop must not run without explicit user approval. Unknown tool
 *  names are treated as mutating — fail safe (confirm) rather than auto-run. */
export function isMutating(name: string): boolean {
  const tool = TOOLS_BY_NAME.get(name);
  return tool ? tool.kind === 'mutating' : true;
}

/** Human-readable confirmation copy for a proposed mutating action. The client
 *  shows this verbatim next to Approve/Reject. */
export function describeAction(name: string, input: Record<string, unknown>): string {
  const s = (key: string): string => {
    const v = input[key];
    return typeof v === 'string' && v.trim() ? v.trim() : '';
  };
  switch (name) {
    case 'create_bookmark': {
      const what = s('url') || s('title') || s('shared_text') || 'a new bookmark';
      return `Save “${what}”?`;
    }
    case 'add_tags': {
      const tags = Array.isArray(input.tags) ? (input.tags as unknown[]).join(', ') : '';
      return `Add tag(s) ${tags} to this bookmark?`;
    }
    case 'set_collection':
      return input.collection_id == null
        ? 'Remove this bookmark from its collection?'
        : 'File this bookmark into the selected collection?';
    case 'trash_bookmark':
      return 'Move this bookmark to Trash?';
    default:
      return `Perform “${name}”?`;
  }
}
