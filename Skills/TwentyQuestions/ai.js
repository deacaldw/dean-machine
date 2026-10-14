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

const articleText = (article, length) => `<article title="${article.title}">\n${article.text.slice(0, length)}\n</article>`;
const lines = items => (items.length ? items.map(item => `- ${item}`).join('\n') : '(none)');
const logText = entries => (entries.length ? entries.map((e, i) => `${i + 1}. ${e.username}: ${e.text} -> ${e.result}`).join('\n') : '(none)');

// One request. The article (if any) comes first and is cached, since quote searches repeat it for every question.
// `task` and `about` only describe the request in the log.
// `seconds` limits each attempt; a failed or timed-out attempt is retried once.
async function call(model, task, about, { article, prompt, input, schema, maxTokens = 1500, seconds = 15 }) {
  const started = Date.now();
  const system = [];
  if (article) system.push({ type: 'text', text: article, cache_control: { type: 'ephemeral' } });
  system.push({ type: 'text', text: prompt });
  let res;
  try {
    res = await anthropic().messages.create({
      model: model.model,
      thinking: model.thinking,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: input }],
      output_config: { effort: 'low', ...(schema && { format: { type: 'json_schema', schema } }) },
    }, { timeout: seconds * 1000, maxRetries: 1 });
  } catch (err) {
    log(`AI ${model.model}`, `${task}: ${about}`, `failed: ${err.message}`, started);
    throw err;
  }
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

  // The tags (from `tags`) to search for a player's category, like "80s movies" -> ['Films']. May be empty.
  categories: async (category, tags) => (await call(ACCURATE, 'categories', category, {
    prompt: t('prompts.categories'), input: t('prompts.categories_input', { category, tags: tags.join('\n') }), maxTokens: 500, seconds: 10,
    schema: object({ tags: { type: 'array', items: oneOf(tags) } }),
  })).tags,

  // Every name that fits the player's category and makes a good secret answer -> indexes into `names`.
  // Names rather than numbers, which slip in long lists. Names that don't match one given are dropped.
  shortlist: async (category, names) => {
    const { topics } = await call(ACCURATE, 'shortlist', `${category} (${names.length} candidates)`, {
      prompt: t('prompts.shortlist', { category }), input: names.join('\n'), maxTokens: 4000, seconds: 20,
      schema: object({ topics: list }),
    });
    const index = new Map(names.map((name, i) => [sanitize(name), i])); // replies are sanitized too
    return [...new Set(topics.map(name => index.get(name)).filter(i => i !== undefined))];
  },

  // True if the article really fits the player's category; checked before each round, as the shortlist is judged
  // by names alone.
  fits: async (category, article) => (await call(ACCURATE, 'fits', `${article.title} for ${category}`, {
    article: articleText(article, FACTS), prompt: t('prompts.fits', { category }), input: 'Does it fit?', maxTokens: 200, seconds: 10,
    schema: object({ fits: yesNo }),
  })).fits,

  // The starting hint and the winning guesses -> { facts: [3 fun facts], answers }
  opening: article => call(ACCURATE, 'opening', article.title, {
    article: articleText(article, INTRO), prompt: t('prompts.opening'), input: 'Write the opening.',
    schema: object({ facts: list, answers: list }),
  }),

  // -> 'ask' | 'hint' | 'options' | 'stop' | 'chat'
  // `recent` is a few lines about what just happened, so short follow-ups ("another one?") make sense.
  route: async (message, recent = []) => (await call(FAST, 'route', message, {
    prompt: t('prompts.route'), input: t('prompts.route_input', { recent: lines(recent), message }), maxTokens: 200, seconds: 8,
    schema: object({ route: oneOf(['ask', 'hint', 'options', 'stop', 'chat']) }),
  })).route,

  // The answer to a question, and the awards it earns, in one call (the verdict comes first in the JSON):
  // -> { result: 'win' | 'yes' | 'no' | 'sort_of' | 'not_yes_no', hot_stuff, breakthrough, team_player, scenic_route? }
  // Scenic Route is only judged when `scenic` is true.
  judge: (game, question, scenic = false) => call(ACCURATE, 'judge', question, {
    prompt: gameText(game), input: t('prompts.judge', { question, scenic: scenic ? t('prompts.judge_scenic') : '' }), maxTokens: 300, seconds: 12,
    schema: object({
      result: oneOf(['win', 'yes', 'no', 'sort_of', 'not_yes_no']),
      hot_stuff: yesNo,
      breakthrough: yesNo,
      team_player: yesNo,
      ...(scenic && { scenic_route: yesNo }),
    }),
  }),

  hint: game => call(ACCURATE, 'hint', game.article.title, { prompt: gameText(game), input: t('prompts.hint'), maxTokens: 300, seconds: 12 }),

  // For a quiet spell: what the players know so far, and questions they could ask next -> { recap, questions: [3] }
  recap: game => call(ACCURATE, 'recap', game.article.title, {
    prompt: gameText(game), input: t('prompts.recap'), maxTokens: 400, seconds: 12,
    schema: object({ recap: text, questions: list }),
  }),

  // Multiple choice for a poll -> { answer, decoys: [3 wrong answers] }
  options: game => call(ACCURATE, 'options', game.article.title, {
    prompt: gameText(game), input: t('prompts.options'), maxTokens: 300, seconds: 12,
    schema: object({ answer: text, decoys: list }),
  }),

  // -> { infocard, video: { kind, search } }
  wrapUp: (game, outcome) => call(ACCURATE, 'wrap-up', `${game.article.title} (${outcome})`, {
    article: articleText(game.article, INTRO), prompt: t('prompts.wrap_up', { outcome, headings: t.get('infocard_headings').join(', ') }), input: `Game log:\n${logText(game.log)}`,
    maxTokens: 3000, seconds: 25,
    schema: object({
      infocard: text,
      video: object({ kind: oneOf(['trailer', 'song', 'documentary', 'none']), search: text }),
    }),
  }),
};
