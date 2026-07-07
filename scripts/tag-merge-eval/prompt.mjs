// The `ai-organize` (tag_merge) prompt — the precision lever, treated as a
// first-class, eval-graded artifact. Kept in the eval so a candidate model is
// graded on the REAL prompt, not a lab variant. The production edge function
// should import/mirror this. Eval scores by tag NAME, so the model returns
// groups of names (production returns tag ids; same grouping, different keys).

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          canonical: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['canonical', 'tags', 'confidence'],
      },
    },
  },
  required: ['groups'],
};

export function systemInstruction() {
  return [
    "You consolidate a user's bookmark TAG vocabulary by grouping tags that are the SAME concept so duplicates can be merged.",
    'You are given ONLY a list of tags (name, usage_count, source). You never see the bookmarks.',
    '',
    'Rules:',
    '- Group tags that mean the SAME thing: exact synonyms, translations across languages (swimming ≡ 수영 ≡ aquatics), spelling/spacing variants (유튜브 쇼츠 ≡ 유튜브쇼츠), and clear sub-topics that roll up into a broader tag the user already has (수영 강습, 수영 팁, 수영기술 → 수영).',
    '- PRECISION OVER RECALL. A missed merge is cheap; a wrong merge destroys the user’s taxonomy. When unsure whether two tags are the SAME concept or merely related, DO NOT group them.',
    '- Keep DISTINCT concepts separate even when adjacent: different swimming strokes (접영 butterfly ≠ 배영 backstroke ≠ 평영 breaststroke), different dishes (김치찌개 ≠ 된장찌개, ramen ≠ sushi), different places/trips (busan ≠ okinawa, 통영여행 ≠ 양양여행), and sibling-but-different concepts (요리 cooking ≠ 레시피 recipe, 운동 exercise ≠ 스포츠 sports, 머신러닝 machine-learning ≠ AI in general).',
    '- Do NOT group generic filler tags (delicious, 일상, value for money / 가성비) with anything — leave them alone (they belong to a separate cleanup, not consolidation), even from each other.',
    '- A group needs ≥ 2 tags. Most tags will NOT be in any group; that is the correct, expected outcome. Only emit a group when confident.',
    '- canonical: the best surviving name for the group — prefer a source:"user" member, else the most-used, else the shortest root form. It MUST be one of the group’s tags.',
    '- tags: the exact input names in the group (including the canonical). confidence: 0..1 that these are one concept.',
  ].join('\n');
}

export function buildUserPrompt(tags) {
  const lines = tags.map((t) => `- ${t.name} (uses: ${t.usage_count}, source: ${t.source})`);
  return `Here is the tag vocabulary (${tags.length} tags). Return merge groups.\n\n${lines.join('\n')}`;
}
