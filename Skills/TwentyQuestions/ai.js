// Claude calls for 20 Questions: Haiku (fast) for cheap, frequent work and Sonnet (accurate) for judging and
// writing. Reasoning is off on both to keep costs down.
const Anthropic = require('@anthropic-ai/sdk').default;
const t = require('../../src/strings')(__dirname);
const { count } = require('./stats');

const FAST = { name: 'fast', model: 'claude-haiku-5-5', thinking: { type: 'disabled' } };
const ACCURATE = { name: 'accurate', model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } };
const INTRO = 6000; // characters of the article used when the whole text isn't needed

let client;
const anthropic = () => (client ??= new Anthropic()); // reads ANTHROPIC_API_KEY

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

// JSON schema helpers
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string' };
const yesNo = { type: 'boolean' };
const list = { type: 'array', items: text };
const oneOf = values => ({ type: 'string', enum: values });
const pick = object({ username: text, text });

const articleText = (article, length) => `<article title="${article.title}">\n${article.text.slice(0, length)}\n</article>`;
const lines = items => (items.length ? items.map(item => `- ${item}`).join('\n') : '(none)');
const logText = log => (log.length ? log.map((e, i) => `${i + 1}. ${e.username}: ${e.text} -> ${e.result}`).join('\n') : '(none)');

// One request. The article (if any) comes first and is cached, since quote searches repeat it for every question.
async function call(model, { article, prompt, input, schema, maxTokens = 1500 }) {
  count(model.name);
  const system = [];
  if (article) system.push({ type: 'text', text: article, cache_control: { type: 'ephemeral' } });
  system.push({ type: 'text', text: prompt });
  const res = await anthropic().messages.create({
    model: model.model,
    thinking: model.thinking,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: input }],
    output_config: { effort: 'low', ...(schema && { format: { type: 'json_schema', schema } }) },
  });
  if (res.stop_reason === 'refusal') throw new Error('Claude declined the request');
  const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return sanitizeAll(schema ? JSON.parse(out) : out);
}

// What Sonnet knows about the game when judging a question or writing a hint: never the article, only quotes.
const gameText = (game, quotes) => t('prompts.game', {
  title: game.article.title,
  answers: game.answers.join(', '),
  quotes: lines(quotes),
  log: logText(game.log),
  hints: lines(game.hints),
});

module.exports = {
  sanitize,
  sanitizeAll,

  // -> { suitable, guessable }
  screen: article => call(FAST, {
    article: articleText(article, INTRO), prompt: t('prompts.screen'), input: 'Judge this article.',
    schema: object({ suitable: yesNo, guessable: yesNo }),
  }),

  // -> { topic, searches }
  setup: article => call(FAST, {
    article: articleText(article, INTRO), prompt: t('prompts.setup'), input: 'Set up the game.',
    schema: object({ topic: text, searches: list }),
  }),

  // -> { poem, answers }
  opening: article => call(ACCURATE, {
    article: articleText(article, INTRO), prompt: t('prompts.opening'), input: 'Write the opening.',
    schema: object({ poem: text, answers: list }),
  }),

  // -> 'ask' | 'hint' | 'stop' | 'chat'
  route: async message => (await call(FAST, {
    prompt: t('prompts.route'), input: message, maxTokens: 200,
    schema: object({ route: oneOf(['ask', 'hint', 'stop', 'chat']) }),
  })).route,

  // Passages from the whole article that help with `need` -> [quote]
  quotes: async (article, need) => (await call(FAST, {
    article: articleText(article), prompt: t('prompts.quotes'), input: need,
    schema: object({ quotes: list }),
  })).quotes,

  // -> 'win' | 'yes' | 'no' | 'sort_of'
  judge: async (game, question, quotes) => (await call(ACCURATE, {
    prompt: gameText(game, quotes), input: t('prompts.judge', { question }), maxTokens: 300,
    schema: object({ result: oneOf(['win', 'yes', 'no', 'sort_of']) }),
  })).result,

  hint: (game, quotes) => call(ACCURATE, { prompt: gameText(game, quotes), input: t('prompts.hint'), maxTokens: 300 }),

  // -> { infocard, most_valuable_question, closest_guess, farthest_guess, related_guess }
  wrapUp: (game, outcome) => call(ACCURATE, {
    article: articleText(game.article, INTRO), prompt: t('prompts.wrap_up', { outcome }), input: `Game log:\n${logText(game.log)}`,
    maxTokens: 3000,
    schema: object({ infocard: text, most_valuable_question: pick, closest_guess: pick, farthest_guess: pick, related_guess: pick }),
  }),
};
