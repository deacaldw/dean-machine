const path = require('path');
const { MessageFlags, PermissionFlagsBits, ButtonStyle } = require('discord.js');
const t = require('../../src/strings')(__dirname);
const wiki = require('./wiki');
const ai = require('./ai');
const youtube = require('./youtube');

const MAX_QUESTIONS = 20; // the question after the 20th is the final guess
const MINUTES = 20;
const BATCH_SIZE = 30; // candidates judged together in one Sonnet call
const PICK_ROUNDS = 3; // batches to try before giving up
const QUESTION_REMINDERS = [15, 10, 5]; // questions left
const TIME_REMINDERS = [15, 10, 5, 1]; // minutes left
const CHECK_MS = 30 * 1000; // how often to check the thread still exists
const COLOR = 0x3366cc;
const RECENT = 6; // lines about what just happened, given to the router
const PLAY_AGAIN = `${path.basename(__dirname)}:again`; // button customId; the core routes "<Skill>:..." here

const lastCheck = {}; // threadId -> timestamp, in memory only
const starting = new Set(); // servers where a game is being set up right now

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const threadLink = game => `https://discord.com/channels/${game.guildId}/${game.threadId}`;
const nameOf = source => source.member?.displayName ?? (source.user ?? source.author).username;

// --- Setting up ---

// Draws a batch of candidates from good_articles.json, has Sonnet judge them all in one call, and fetches a random
// one that passed. Tries another batch if none did.
async function pickArticle() {
  for (let round = 0; round < PICK_ROUNDS; round++) {
    const batch = wiki.candidates(BATCH_SIZE);
    const verdicts = await ai.screen(batch.map(c => c.name));
    const passed = batch.filter((_, i) => verdicts[i].suitable && verdicts[i].guessable).sort(() => Math.random() - 0.5);
    for (const candidate of passed) {
      const article = await wiki.article(candidate.title);
      if (article) return article;
    }
  }
  throw new Error('No suitable article found');
}

// True if the hint gives away a word of the title ("my road" for Abbey Road). Short words are ignored.
const leaksTitle = (hint, title) => title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3).some(word => hint.toLowerCase().includes(word));

// The opening from Sonnet, written once more if the starting hint gives away part of the answer.
async function writeOpening(article) {
  const opening = await ai.opening(article);
  return leaksTitle(opening.hint, article.title) ? ai.opening(article) : opening;
}

// "Here's a quote/haiku to get you on your way..." and a box with it in italics (and the quote's author).
function startingHint({ hint, kind, author, authorIsAnswer }) {
  const lines = hint.split('\n').filter(line => line.trim()).map(line => t('hint_line', { line: line.trim() }));
  if (kind === 'quote') lines.push(t('quote_author', { author: authorIsAnswer || !author ? t('author_is_answer') : author }));
  return { intro: t(kind === 'quote' ? 'intro_quote' : 'intro_haiku'), embeds: [{ color: COLOR, description: lines.join('\n') }] };
}

const playAgainButton = () => ({
  content: t('play_again_prompt'),
  components: [{ type: 1, components: [{ type: 2, style: ButtonStyle.Primary, label: t('play_again'), custom_id: PLAY_AGAIN }] }],
});

// Starts a game from /20questions (in a new thread, with the rules) or from the Play again button (quietly, in the
// same thread, renamed for the new topic).
async function start(interaction, ctx) {
  const again = interaction.isButton?.() ?? false;
  if (!again && interaction.channel?.isThread()) return ephemeral(interaction, t('not_here'));
  const running = ctx.jobs[0]; // one game per server at a time
  if (running || starting.has(interaction.guildId)) {
    return ephemeral(interaction, t('already_running', { link: running ? threadLink(running.data) : '' }));
  }

  starting.add(interaction.guildId);
  try {
    // Play again: confirm at once and remove the button (no second click) while the next topic is picked.
    if (again) await interaction.update({ content: t('play_again_starting', { username: nameOf(interaction) }), components: [] });
    else await interaction.reply(t('picking'));

    let article, opening;
    try {
      article = await pickArticle();
      [opening, article.photos] = await Promise.all([writeOpening(article), wiki.photos(article).catch(() => [])]);
    } catch (err) {
      console.error(`TwentyQuestions: couldn't start: ${err.message}`);
      return interaction.editReply(t('start_failed'));
    }

    const name = cut(t('thread_name', { topic: opening.topic }), 100);
    const endsAt = Date.now() + MINUTES * 60000;
    const { intro, embeds } = startingHint(opening);
    let thread;
    if (again) {
      thread = interaction.channel;
      await thread.setName(name).catch(err => console.error(`TwentyQuestions: couldn't rename the thread: ${err.message}`));
      await thread.send({ content: intro, embeds });
    } else {
      const message = await interaction.editReply(t('started', { username: nameOf(interaction) }));
      thread = await message.startThread({ name, autoArchiveDuration: 60 });
      const rules = t('rules', { questions: MAX_QUESTIONS, ends: Math.floor(endsAt / 1000), intro, ...t.get('reactions') });
      await thread.send({ content: rules, embeds });
    }

    ctx.add({
      guildId: interaction.guildId,
      channelId: again ? thread.parentId : interaction.channelId,
      threadId: thread.id,
      starterId: interaction.user.id,
      article, // cached: its opening is given to Sonnet when judging
      answers: [...new Set([article.title, ...opening.answers])], // guesses that should win (a guideline for Sonnet)
      topic: opening.topic,
      endsAt,
      warned: [],
      used: 0,
      log: [], // { username, text, result }
      recent: [], // lines about what just happened, for the router
      hints: [],
      over: false,
    });
  } finally {
    starting.delete(interaction.guildId);
  }
}

// --- Playing ---

// Remembers what just happened (for the router), keeping only the last few lines.
function remember(game, kind, message, extra = {}) {
  const line = t(`prompts.recent.${kind}`, { username: nameOf(message), text: cut(message.content, 150), ...extra });
  game.recent = [...(game.recent ?? []), line].slice(-RECENT);
}

// A question or guess, judged by Sonnet. Answered with a reaction.
async function ask(game, message, ctx, jobId) {
  const question = cut(message.content, 300);
  const result = await ai.judge(game, question);
  if (game.over) return;
  game.used++;
  game.log.push({ username: nameOf(message), text: question, result });
  remember(game, 'ask', message, { result });
  await message.react(t(`reactions.${result}`));

  if (result === 'win' || game.used > MAX_QUESTIONS) {
    await finish(game, message.channel, result === 'win' ? 'win' : 'lose', nameOf(message));
    return ctx.remove(jobId);
  }
  const left = MAX_QUESTIONS - game.used;
  if (left === 0) await message.channel.send(t('last_question'));
  else if (QUESTION_REMINDERS.includes(left)) await message.channel.send(t('questions_left', { left }));
}

// A hint from Sonnet, based on what the players have asked so far.
async function hint(game, message) {
  message.channel.sendTyping().catch(() => {});
  const text = await ai.hint(game);
  if (game.over) return;
  game.hints.push(text);
  remember(game, 'hint', message);
  await message.reply({ content: t('hint', { hint: text }), allowedMentions: { repliedUser: false } });
}

// --- Ending ---

// The final info card with the article's photos. Discord shows up to 4 images as a gallery when several cards
// share a URL, so photos 1-4 form the gallery and a fifth goes in the corner thumbnail.
function infoCard(article, text, extra = '') {
  const photos = article.photos ?? (article.image ? [article.image] : []);
  const [first, ...more] = photos.slice(0, 4);
  return [
    {
      color: COLOR,
      url: article.url,
      description: cut(`${text || cut(article.text, 600)}\n\n${extra ? `${extra}\n` : ''}[${t('read_more')}](${article.url})`, 4096),
      image: first ? { url: first } : undefined,
      thumbnail: photos[4] ? { url: photos[4] } : undefined,
    },
    ...more.map(url => ({ url: article.url, image: { url } })),
  ];
}

// A YouTube video picked by the wrap-up: { kind: 'trailer' | 'song' | 'documentary', title, url }, or null.
async function findVideo(video) {
  if (!video || video.kind === 'none') return null;
  const found = await youtube.search(video.search); // never throws; null without a key or on any failure
  return found ? { kind: video.kind, ...found } : null;
}

// Ends the game once: result line, then the answer with an info card (with a trailer or song link), then stats, a
// documentary if there's one, and the button to play again.
async function finish(game, thread, outcome, username) {
  if (game.over) return;
  game.over = true;
  const send = msg => thread.send(msg).catch(() => {});
  await send(t(outcome, { username, used: Math.min(game.used, MAX_QUESTIONS), max: MAX_QUESTIONS }));
  await send(t('card_loading'));
  thread.sendTyping().catch(() => {});

  let wrap = null;
  try {
    wrap = await ai.wrapUp(game, outcome);
  } catch (err) {
    console.error(`TwentyQuestions: wrap-up failed: ${err.message}`);
  }
  const video = await findVideo(wrap?.video);
  const link = video && video.kind !== 'documentary' ? t(`video.${video.kind}`, video) : '';
  await send({ content: t('reveal', { title: ai.sanitize(game.article.title) }), embeds: infoCard(game.article, wrap?.infocard, link) });

  const asked = {};
  for (const e of game.log) asked[e.username] = (asked[e.username] ?? 0) + 1;
  const [top] = Object.entries(asked).sort((a, b) => b[1] - a[1]);
  const lines = top ? [t('stat_most_questions', { username: top[0], count: top[1] })] : [];
  for (const [key, label] of [['most_valuable_question', 'stat_valuable'], ['closest_guess', 'stat_closest'], ['farthest_guess', 'stat_farthest'], ['related_guess', 'stat_related']]) {
    const pick = wrap?.[key];
    if (pick?.username && pick?.text) lines.push(t(label, { username: pick.username, text: cut(pick.text, 200) }));
  }
  if (lines.length) await send([t('stats_title'), ...lines].join('\n'));
  if (video?.kind === 'documentary') await send(t('video.documentary', video));
  await send(playAgainButton());
}

async function stop(interaction, ctx) {
  const job = ctx.jobs.find(j => j.data.channelId === interaction.channelId || j.data.threadId === interaction.channelId);
  if (!job) return ephemeral(interaction, t('no_game'));
  const admin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!admin && job.data.starterId !== interaction.user.id) return ephemeral(interaction, t('stop_not_allowed'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = await interaction.client.channels.fetch(job.data.threadId).catch(() => null);
  if (thread) await finish(job.data, thread, 'stopped');
  job.data.over = true;
  ctx.remove(job.id);
  await interaction.editReply(t('stop_done'));
}

module.exports = {
  commands: [
    { name: t('command'), description: t('description') },
    { name: t('stop_command'), description: t('stop_description') },
  ],

  async handle(interaction, ctx) {
    if (interaction.isButton?.()) return interaction.customId === PLAY_AGAIN ? start(interaction, ctx) : undefined;
    if (!interaction.isChatInputCommand()) return;
    return interaction.commandName === t('command') ? start(interaction, ctx) : stop(interaction, ctx);
  },

  // Every message in a game thread is routed to ask, hint, stop or chat (ignored).
  async message(message, ctx) {
    const job = ctx.jobs.find(j => j.data.threadId === message.channelId);
    if (!job || job.data.over) return;
    const game = job.data;
    const route = await ai.route(message.content, game.recent);
    if (game.over) return;
    if (route === 'chat') return remember(game, 'chat', message);
    if (route === 'ask') return ask(game, message, ctx, job.id);
    if (route === 'hint') return hint(game, message);
    if (route === 'stop') {
      await finish(game, message.channel, 'stopped');
      return ctx.remove(job.id);
    }
  },

  // Reminds players of the time left, ends the game when time runs out, or silently when the thread is gone.
  async run(game, client) {
    if (game.over) return true;
    const now = Date.now();
    const left = game.endsAt - now;
    const due = left > 0 ? TIME_REMINDERS.filter(m => left <= m * 60000 && !game.warned.includes(m)) : [];
    if (left > 0 && !due.length && now - (lastCheck[game.threadId] ?? 0) < CHECK_MS) return false;
    lastCheck[game.threadId] = now;

    let thread;
    try {
      thread = await client.channels.fetch(game.threadId);
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) return false; // temporary problem; try again later
      delete lastCheck[game.threadId];
      return true;
    }
    if (left > 0) {
      if (due.length) {
        game.warned.push(...due); // after downtime several may be due at once; post just one
        await thread.send(t('time_left', { ends: Math.floor(game.endsAt / 1000) })).catch(() => {});
      }
      return false;
    }
    await finish(game, thread, 'timeout');
    delete lastCheck[game.threadId];
    return true;
  },

  leaksTitle, // exported for tests
};
