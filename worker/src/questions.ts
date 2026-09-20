/**
 * Cut the Noise — the Jev rubric.
 *
 * Five Score questions, one per dimension, sent together in a single
 * request per post (they run in parallel server-side). Level descriptions
 * describe concrete situations, not degrees — per TypeSafe Score guidance.
 * Each question judges exactly one dimension; combination happens in the
 * extension's sliders, not here.
 */

export type DimName = 'firsthand' | 'promo' | 'bait' | 'depth' | 'relevance';

export const DIMENSIONS: DimName[] = [
  'firsthand',
  'promo',
  'bait',
  'depth',
  'relevance'
];

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[];
}

export const QUESTIONS: Record<DimName, ScoreQuestion> = {
  firsthand: {
    type: 'score',
    instructions:
      'How much concrete, firsthand experience does this post contain? ' +
      'Judge only what the post itself says; do not assume its claims are true or false.',
    criteria: [
      'No firsthand experience: an opinion, hot take, a quote or repost of someone else\u2019s content, or a general claim with no specific example',
      'Claims to have done or seen something, but gives no specifics: no named tools, projects, numbers, or outcomes',
      'Describes one specific firsthand experience with at least one concrete detail, such as a named tool, a measurement, a decision, or an outcome',
      'A rich firsthand account: a specific project or experience with multiple concrete details, specifics, or lessons learned'
    ]
  },
  promo: {
    type: 'score',
    instructions:
      'How much is this post trying to promote or sell something, rather than simply share information or experience?',
    criteria: [
      'No promotion: shares information, opinion, or experience with nothing being sold or grown',
      'Soft promotion: mentions the author\u2019s product, newsletter, course, company, or job openings in passing, while still adding some substance',
      'Promotional: selling is a main point \u2014 a product plug, launch post, pricing pitch, or a call to follow, subscribe, or sign up',
      'Pure advertisement: the post exists to sell \u2014 sales links, discount codes, \u201clink in bio\u201d, giveaway or growth bait, no substantive content'
    ]
  },
  bait: {
    type: 'score',
    instructions:
      'How much is this post engineered to farm engagement (likes, replies, reposts) rather than to communicate something?',
    criteria: [
      'No engagement bait: the post says what it means and is done',
      'Mild bait: a slightly hot framing, a rhetorical question, or mild validation-seeking',
      'Engagement bait: cliffhangers, manufactured controversy, \u201creply with\u2026\u201d, \u201cfollow to get\u2026\u201d, or obvious virality mechanics',
      'Hard bait: rage-bait, guilt-tripping, \u201clike and share if\u2026\u201d, or engagement-farming as the entire content'
    ]
  },
  depth: {
    type: 'score',
    instructions:
      'How much technical substance does this post contain for someone who works in software or technology?',
    criteria: [
      'No technical content: vibes, culture-war commentary, or a topic unrelated to technology',
      'Light: names a technology or concept but explains nothing',
      'Substantive: explains a mechanism, shows code or configuration, or describes a specific technical decision or trade-off',
      'Deep: detailed technical content \u2014 implementation details, benchmarks, architecture, or a worked example'
    ]
  },
  relevance: {
    type: 'score',
    instructions:
      'How relevant is this post to the reader\u2019s interests given in the `reader_interests` field of the state?',
    criteria: [
      'Off-topic: unrelated to the reader\u2019s stated interests',
      'Adjacent: touches a related area, but the core of the post is elsewhere',
      'Relevant: directly about one of the reader\u2019s stated interests',
      'Core: squarely about the reader\u2019s stated interests \u2014 the kind of post they follow the topic to see'
    ]
  }
};

export const DEFAULT_INTERESTS =
  'software engineering, AI tooling, and technology';

/**
 * State for one post. The note sets expectations: a single social post,
 * extracted without images, videos, replies, or thread context.
 */
export function buildState(text: string, interests: string) {
  return {
    note: 'The text of a single social media post, extracted from the page without images, videos, replies, or thread context.',
    post_text: text,
    reader_interests: (interests && interests.trim()) || DEFAULT_INTERESTS
  };
}
