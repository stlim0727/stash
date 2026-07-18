// Fabricate believable Stash data to inject into the web app's localStorage.
//
// Shapes mirror apps/mobile/src/domain/types.ts (snake_case, 1:1 with the DB)
// and storage/repository.ts's localStorage keys. Generation is deterministic
// for a given --seed so a screenshot is reproducible.

// --- deterministic PRNG (mulberry32) ----------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_ID = 'mock-user-1'; // domain/mock-data.ts mockUserId

// A pool of coherent (title, url, site, description, content_type) rows so the
// generated inbox reads like a real one rather than lorem ipsum.
const ARTICLES = [
  { title: 'The quiet magic of local-first software', host: 'inkandswitch.com', site: 'Ink & Switch', path: '/local-first', desc: 'Seven ideals for software that keeps your data on your device and still syncs.', type: 'article' },
  { title: 'React Native 0.85 is out', host: 'reactnative.dev', site: 'React Native', path: '/blog/0-85', desc: 'The New Architecture is now the default, plus a faster Hermes.', type: 'article' },
  { title: 'How SQLite scales to the edge', host: 'fly.io', site: 'Fly.io', path: '/blog/sqlite-edge', desc: 'Running a real database next to every user, without a control plane.', type: 'article' },
  { title: 'A recipe for weeknight shakshuka', host: 'seriouseats.com', site: 'Serious Eats', path: '/shakshuka', desc: 'Eggs poached in a spiced tomato and pepper sauce, ready in 30 minutes.', type: 'article' },
  { title: 'Designing for the inbox-zero mindset', host: 'nngroup.com', site: 'NN/g', path: '/inbox-ux', desc: 'Why triage-first interfaces beat infinite feeds for saved content.', type: 'article' },
  { title: 'Kyoto in three days', host: 'nytimes.com', site: 'The New York Times', path: '/travel/kyoto', desc: 'Temples at dawn, a kaiseki dinner, and where to find the best matcha.', type: 'article' },
  { title: 'Ship it: a pragmatic guide to release branches', host: 'martinfowler.com', site: 'martinfowler.com', path: '/release-branches', desc: 'Trunk-based development with maintenance lines, without the merge pain.', type: 'article' },
  { title: 'The economics of a one-person startup', host: 'stripe.com', site: 'Stripe', path: '/atlas/one-person', desc: 'Pricing, taxes, and the surprisingly boring parts of going solo.', type: 'article' },
  { title: 'Understand your app with Sentry spans', host: 'sentry.io', site: 'Sentry', path: '/tracing', desc: 'Turning vague "it feels slow" reports into concrete waterfalls.', type: 'url' },
  { title: 'A field guide to Postgres RLS', host: 'supabase.com', site: 'Supabase', path: '/rls', desc: 'Owner-scoped row-level security you can actually reason about.', type: 'article' },
  { title: 'Sourdough without the anxiety', host: 'kingarthurbaking.com', site: 'King Arthur', path: '/sourdough', desc: 'A forgiving no-knead loaf that survives a busy schedule.', type: 'article' },
  { title: 'Talk: rethinking mobile navigation', host: 'youtube.com', site: 'YouTube', path: '/watch?v=nav', desc: 'A 20-minute case study on collapsing five tabs into one inbox.', type: 'video' },
  { title: 'The case against dark patterns in paywalls', host: 'theverge.com', site: 'The Verge', path: '/paywalls', desc: 'When "cancel anytime" quietly means "email us and wait".', type: 'article' },
  { title: 'Weekend project: an e-ink dashboard', host: 'hackaday.com', site: 'Hackaday', path: '/eink-dash', desc: 'Low-power calendar and weather on a repurposed Kindle.', type: 'article' },
  { title: 'Budgeting for irregular income', host: 'ramp.com', site: 'Ramp', path: '/blog/budget', desc: 'Envelopes, buffers, and paying yourself a steady salary.', type: 'article' },
  { title: 'Note: interview questions to steal', host: null, site: null, path: null, desc: 'Ask them to debug a failing test live. Watch how they narrate.', type: 'text' },
];

const COLLECTIONS = ['Read Later', 'Design', 'Recipes', 'Work', 'Travel'];
const TAGS = ['ai', 'react-native', 'productivity', 'design', 'startup', 'recipes', 'travel', 'finance', 'diy'];

const iso = (d) => new Date(d).toISOString();
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/**
 * Build a full injectable dataset: bookmarks + tagData (tags, links,
 * collections) + AI enrichments. `opts`:
 *   count       how many bookmarks (default 8)
 *   seed        PRNG seed (default 1)
 *   collections how many collections to fabricate (default 3)
 *   tags        how many tags to fabricate (default 6)
 *   archived    how many bookmarks are trashed instead of active (default 0)
 *   baseTime    ms epoch the newest item is anchored to (default now)
 */
export function generate(opts = {}) {
  const count = opts.count ?? 8;
  const rand = rng((opts.seed ?? 1) + 1);
  const nCollections = Math.min(opts.collections ?? 3, COLLECTIONS.length);
  const nTags = Math.min(opts.tags ?? 6, TAGS.length);
  const archived = opts.archived ?? 0;
  const base = opts.baseTime ?? Date.now();
  const DAY = 86_400_000;

  const collections = COLLECTIONS.slice(0, nCollections).map((name, i) => ({
    id: `col-${i + 1}`,
    user_id: USER_ID,
    name,
    description: null,
    created_at: iso(base - (i + 2) * DAY),
    updated_at: iso(base - (i + 2) * DAY),
  }));

  const tags = TAGS.slice(0, nTags).map((name, i) => ({
    id: `tag-${i + 1}`,
    user_id: USER_ID,
    name,
    slug: slugify(name),
    source: i % 4 === 0 ? 'ai' : 'user',
    created_at: iso(base - (i + 2) * DAY),
  }));

  const bookmarks = [];
  const bookmarkTags = [];
  const enrichments = [];

  for (let i = 0; i < count; i++) {
    const a = ARTICLES[i % ARTICLES.length];
    const id = `bm-${i + 1}`;
    const created = base - Math.floor(i * (DAY / 2) + rand() * DAY);
    const isArchived = i >= count - archived;
    const collection = !a.host ? null : rand() < 0.4 ? collections[Math.floor(rand() * collections.length)] : null;

    bookmarks.push({
      id,
      user_id: USER_ID,
      url: a.host ? `https://${a.host}${a.path ?? ''}` : null,
      canonical_url: a.host ? `https://${a.host}${a.path ?? ''}` : null,
      url_hash: a.host ? `hash-${id}` : null,
      client_id: `client-${id}`,
      title: a.title,
      description: a.desc,
      notes: null,
      source_app: null,
      content_type: a.type,
      preview_image_url: null, // keep null: no remote fetch, no broken thumbnails offline
      favicon_url: null,
      site_name: a.site,
      collection_id: collection?.id ?? null,
      is_archived: isArchived,
      deleted_at: isArchived ? iso(created + 3600_000) : null,
      created_at: iso(created),
      updated_at: iso(created),
      last_saved_at: iso(created),
      metadata_status: 'complete',
      sync_status: 'synced',
    });

    // Link 0-2 tags to roughly half the bookmarks.
    if (a.host && rand() < 0.6) {
      const picks = new Set();
      const n = 1 + Math.floor(rand() * 2);
      while (picks.size < n) picks.add(tags[Math.floor(rand() * tags.length)].id);
      for (const tagId of picks) {
        bookmarkTags.push({
          bookmark_id: id,
          tag_id: tagId,
          source: 'user',
          confidence: null,
          created_at: iso(created),
        });
      }
    }

    // Give a couple of active items a pending AI suggestion so the Review
    // screen isn't empty (suggested tags not yet applied → reviewable).
    if (a.host && !isArchived && i < 3) {
      enrichments.push({
        id: `enr-${id}`,
        bookmark_id: id,
        user_id: USER_ID,
        summary: `${a.desc} A concise saved-for-later summary.`,
        topics: [tags[i % tags.length].name],
        suggested_tags: [
          { name: tags[(i + 1) % tags.length].name, confidence: 0.9 },
          { name: tags[(i + 2) % tags.length].name, confidence: 0.72 },
        ],
        suggested_collection_id: null,
        suggested_collection_name: i === 0 ? 'Read Later' : null,
        model: 'fixture',
        status: 'complete',
        confidence: 0.85,
        degraded: false,
        degraded_reason: null,
        created_at: iso(created),
        updated_at: iso(created),
      });
    }
  }

  return { bookmarks, tagData: { tags, bookmarkTags, collections }, enrichments };
}
