// Claude calls for 20 Questions: Haiku (fast) for cheap, frequent work and Sonnet (accurate) for judging and
// writing. Reasoning is off on both to keep costs down.
const Anthropic = require('@anthropic-ai/sdk').default;
const t = require('../../src/strings')(__dirname);
const { log } = require('./log');

const FAST = { name: 'fast', model: 'claude-haiku-5-5', thinking: { type: 'disabled' } };
const ACCURATE = { name: 'accurate', model: 'claude-sonnet-5-5', thinking: { type: 'between_tools' } };
const INTRO = 6000; // characters of the article used for the opening and the info card
const FACTS = 2000; // characters of the article given to Sonnet when judging and hinting

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
const logText = entries => (entries.length ? entries.map((e, i) => `${i + 1}. ${e.username}: ${e.text} -> ${e.result}`).join('\n') : '(none)');

// One request. The article (if any) comes first and is cached, since quote searches repeat it for every question.
// `task` and `about` only describe the request in the log.
async function call(model, task, about, { article, prompt, input, schema, maxTokens = 1500 }) {
  const started = Date.now();
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
  const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const { input_tokens: fresh = 0, cache_read_input_tokens: cached = 0, cache_creation_input_tokens: written = 0, output_tokens: output = 0 } = res.usage ?? {};
  log(`AI ${model.model}`, `${task}: ${about}`, res.stop_reason === 'refusal' ? 'REFUSED' : out, started, `[tokens in ${fresh + cached + written} (cached ${cached}), out ${output}]`);
  if (res.stop_reason === 'refusal') throw new Error('Claude declined the request');
  return sanitizeAll(schema ? JSON.parse(out) : out);
}

// What Sonnet knows about the game when judging a question or writing a hint, including the article's opening.
const gameText = game => t('prompts.game', {
  title: game.article.title,
  answers: game.answers.join(', '),
  facts: game.article.text.slice(0, FACTS),
  log: logText(game.log),
  hints: lines(game.hints),
});

module.exports = {
  sanitize,
  sanitizeAll,

  // Judges many candidate names in one call -> [{ suitable, guessable }] in the same order (missing ones fail).
  screen: async names => {
    const { verdicts } = await call(ACCURATE, 'screen', `${names.length} candidates`, {
      prompt: t('prompts.screen'), input: names.map((name, i) => `${i + 1}. ${name}`).join('\n'), maxTokens: 4000,
      schema: object({ verdicts: { type: 'array', items: object({ number: { type: 'integer' }, suitable: yesNo, guessable: yesNo }) } }),
    });
    return names.map((_, i) => verdicts.find(v => v.number === i + 1) ?? { suitable: false, guessable: false });
  },

  // -> { topic, kind: 'quote' | 'haiku', hint, author, authorIsAnswer, answers }
  opening: article => call(ACCURATE, 'opening', article.title, {
    article: articleText(article, INTRO), prompt: t('prompts.opening'), input: 'Write the opening.',
    schema: object({ topic: text, kind: oneOf(['quote', 'haiku']), hint: text, author: text, authorIsAnswer: yesNo, answers: list }),
  }),

  // -> 'ask' | 'hint' | 'stop' | 'chat'
  // `recent` is a few lines about what just happened, so short follow-ups ("another one?") make sense.
  route: async (message, recent = []) => (await call(FAST, 'route', message, {
    prompt: t('prompts.route'), input: t('prompts.route_input', { recent: lines(recent), message }), maxTokens: 200,
    schema: object({ route: oneOf(['ask', 'hint', 'stop', 'chat']) }),
  })).route,

  // -> 'win' | 'yes' | 'no' | 'sort_of'
  judge: async (game, question) => (await call(ACCURATE, 'judge', question, {
    prompt: gameText(game), input: t('prompts.judge', { question }), maxTokens: 300,
    schema: object({ result: oneOf(['win', 'yes', 'no', 'sort_of']) }),
  })).result,

  hint: game => call(ACCURATE, 'hint', game.article.title, { prompt: gameText(game), input: t('prompts.hint'), maxTokens: 300 }),

  // -> { infocard, most_valuable_question, closest_guess, farthest_guess, related_guess, video: { kind, search } }
  wrapUp: (game, outcome) => call(ACCURATE, 'wrap-up', `${game.article.title} (${outcome})`, {
    article: articleText(game.article, INTRO), prompt: t('prompts.wrap_up', { outcome }), input: `Game log:\n${logText(game.log)}`,
    maxTokens: 3000,
    schema: object({
      infocard: text, most_valuable_question: pick, closest_guess: pick, farthest_guess: pick, related_guess: pick,
      video: object({ kind: oneOf(['trailer', 'song', 'documentary', 'none']), search: text }),
    }),
  }),
};
