// Claude calls for 20 Questions. Cheap model for frequent calls, stronger model for writing.
// Reasoning is off on both to keep costs down.
const Anthropic = require('@anthropic-ai/sdk').default;
const t = require('../../src/strings')(__dirname);
const { count } = require('./stats');

const FAST = { model: 'claude-haiku-5-5', thinking: { type: 'disabled' } }; // screening topics, reading messages
const SMART = { model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } }; // riddle, verifying wins, hints, wrap-up
const SCREEN_TEXT = 4000; // the opening of the article is enough to screen a topic

// Plain text for Discord: typographic quotes, dashes and spaces become simple ones; invisible characters go.
function sanitize(text) {
  return text.normalize('NFKC')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s*—\s*/g, ' - ')
    .replace(/[‐‑‒–―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}�]/gu, c => (c === '\n' ? c : ''))
    .trim();
}
const sanitizeAll = value => (typeof value === 'string' ? sanitize(value)
  : Array.isArray(value) ? value.map(sanitizeAll)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeAll(v)]))
      : value);

let client;
const anthropic = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

const strictObject = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const oneOf = values => ({ type: 'string', enum: values });
const entry = strictObject({ username: { type: 'string' }, text: { type: 'string' } });

function articleBlock(article) {
  const aliases = article.aliases.length ? `\nAlternative names: ${article.aliases.join('; ')}` : '';
  return `<article title="${article.title}">${aliases}\n\n${article.text}\n</article>`;
}

// One request. The article comes first so repeated calls about the same game hit the prompt cache.
async function ask({ model, thinking }, article, instructions, user, { schema, effort = 'low', maxTokens = 2000 } = {}) {
  count(model === FAST.model ? 'fast' : 'smart');
  const res = await anthropic().messages.create({
    model,
    thinking,
    max_tokens: maxTokens,
    system: [
      { type: 'text', text: articleBlock(article) },
      { type: 'text', text: instructions, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: user }],
    output_config: { effort, ...(schema && { format: { type: 'json_schema', schema } }) },
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined the request');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return sanitizeAll(schema ? JSON.parse(text) : text);
}

const logText = log => log.map((e, i) => `#${i + 1} ${e.username} (${e.intent}): ${e.text}${e.answer ? ` → ${e.answer}` : ''}`).join('\n') || '(nothing yet)';

module.exports = {
  sanitize,
  sanitizeAll,

  // Is the topic family-friendly, guessable with some effort, and specific enough? -> { suitable, guessable, specific }
  async screen(article) {
    const opening = { ...article, text: article.text.slice(0, SCREEN_TEXT) };
    return ask(FAST, opening, t('prompts.screen'), 'Screen this topic.', {
      schema: strictObject({ suitable: { type: 'boolean' }, guessable: { type: 'boolean' }, specific: { type: 'boolean' } }),
    });
  },

  // The opening: a riddle poem, a broad topic that doesn't give the answer away, and a photo search.
  // -> { poem, topic, image_queries }
  async opening(article) {
    return ask(SMART, article, t('prompts.opening'), 'Write the opening.', {
      schema: strictObject({ poem: { type: 'string' }, topic: { type: 'string' }, image_queries: { type: 'array', items: { type: 'string' } } }),
    });
  },

  // Looks at candidate photos and returns the 1-based number of a suitable one, or 0 for none.
  // The images are downloaded here and sent as data, which is more reliable than letting the API fetch them.
  async pickPhoto(article, topic, photos) {
    const images = await Promise.all(photos.map(async p => {
      const res = await fetch(p.preview);
      if (!res.ok) throw new Error(`Image download returned ${res.status}`);
      const media_type = (res.headers.get('content-type') ?? 'image/jpeg').split(';')[0];
      return { type: 'base64', media_type, data: Buffer.from(await res.arrayBuffer()).toString('base64') };
    }));
    const content = images.flatMap((source, i) => [{ type: 'text', text: `Photo ${i + 1}:` }, { type: 'image', source }]);
    content.push({ type: 'text', text: 'Which photo should we use?' });
    const result = await ask(SMART, article, t('prompts.photo', { topic }), content, {
      schema: strictObject({ choice: { type: 'integer' } }),
    });
    return result.choice;
  },

  // -> { intent, answer, guess }
  async interpret(article, log, username, message) {
    return ask(FAST, article, t('prompts.interpret'), `Game so far:\n${logText(log)}\n\nNewest message from ${username}:\n${message}`, {
      schema: strictObject({
        intent: oneOf(['question', 'guess', 'hint', 'stop', 'chat']),
        answer: oneOf(['yes', 'yes_more_specific', 'no', 'sort_of', 'not_quite', 'none']),
        guess: { type: 'string' },
      }),
    });
  },

  // Second opinion before declaring a win -> 'yes' | 'yes_more_specific' | 'not_quite' | 'no'
  async verify(article, guess) {
    const result = await ask(SMART, article, t('prompts.verify', { guess }), 'Judge the guess.', {
      schema: strictObject({ answer: oneOf(['yes', 'yes_more_specific', 'not_quite', 'no']) }),
    });
    return result.answer;
  },

  async hint(article, log, hints) {
    const given = hints.length ? hints.map(h => `- ${h}`).join('\n') : '(none)';
    return ask(SMART, article, t('prompts.hint'), `Game so far:\n${logText(log)}\n\nHints already given:\n${given}`);
  },

  // -> { infocard, most_valuable_question, closest_guess, farthest_guess, related_guess }
  async wrapUp(article, log, outcome) {
    return ask(SMART, article, t('prompts.wrap_up', { outcome }), `Game log:\n${logText(log)}`, {
      maxTokens: 4000,
      schema: strictObject({
        infocard: { type: 'string' },
        most_valuable_question: entry,
        closest_guess: entry,
        farthest_guess: entry,
        related_guess: entry,
      }),
    });
  },
};
