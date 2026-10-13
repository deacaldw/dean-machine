const path = require('path');
const { MessageFlags, PermissionFlagsBits, ButtonStyle } = require('discord.js');
const t = require('../../src/strings')(__dirname);
const wiki = require('./wiki');
const ai = require('./ai');
const stats = require('./stats');

const MAX_QUESTIONS = 20; // the question after the 20th is the final guess
const MINUTES = 20;
const BATCH_SIZE = 30; // candidates judged together in one Sonnet call
const PICK_ROUNDS = 3; // batches to try before giving up
const QUESTION_REMINDERS = [15, 10, 5]; // questions left
const TIME_REMINDERS = [15, 10, 5, 1]; // minutes left
const CHECK_MS = 30 * 1000; // how often to check the thread still exists
const COLOR = 0x3366cc;
const PLAY_AGAIN = `${path.basename(__dirname)}:again`; // button customId; the core routes "<Skill>:..." here

const lastCheck = {}; // threadId -> timestamp, in memory only
const starting = new Set(); // servers where a game is being set up right now

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const threadLink = game => `https://discord.com/channels/${game.guildId}/${game.threadId}`;
const nameOf = source => source.member?.displayName ?? (source.user ?? source.author).username;

// --- Setting up ---

// Draws a batch of candidates from good_articles.json, has Sonnet judge them all in one call, and fetches a random
// one that passed. Tries another batch if none did. Also returns how many were checked and why they failed.
async function pickArticle() {
  const checked = { total: 0, passed: 0, difficulty: 0, unsuitable: 0 };
  for (let round = 0; round < PICK_ROUNDS; round++) {
    const batch = wiki.candidates(BATCH_SIZE);
    const verdicts = await ai.screen(batch.map(c => c.name));
    checked.total += batch.length;
    checked.unsuitable += verdicts.filter(v => !v.suitable).length;
    checked.difficulty += verdicts.filter(v => v.suitable && !v.guessable).length;
    const passed = batch.filter((_, i) => verdicts[i].suitable && verdicts[i].guessable).sort(() => Math.random() - 0.5);
    checked.passed += passed.length;
    for (const candidate of passed) {
      const article = await wiki.article(candidate.title);
      if (article) return { article, checked };
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

// The rules as text, with the starting hint card: a famous quote (with its author), or a haiku.
function openingMessage({ hint, kind, author, authorIsAnswer }, endsAt) {
  const by = kind === 'quote' ? [t('quote_author', { author: authorIsAnswer || !author ? t('author_is_answer') : author })] : [];
  return {
    content: t('rules', { questions: MAX_QUESTIONS, ends: Math.floor(endsAt / 1000), ...t.get('reactions') }),
    embeds: [{ color: COLOR, title: t(kind === 'quote' ? 'quote_title' : 'haiku_title'), description: [hint, ...by, t('who_am_i')].join('\n') }],
  };
}

const playAgainButton = () => ({
  content: t('play_again_prompt'),
  components: [{ type: 1, components: [{ type: 2, style: ButtonStyle.Primary, label: t('play_again'), custom_id: PLAY_AGAIN }] }],
});

// How the topic was picked, for the player who started the game. Only counts, so it never names the answer.
function setupReport({ checked, counts, seconds }) {
  return `${t('report.title')}\n${t('report.story', { ...checked, wikipedia: 0, fast: 0, accurate: 0, ...counts, seconds })}`;
}

// Starts a game from /20questions (in a new thread) or from the Play again button (in the same thread, renamed).
async function start(interaction, ctx) {
  const again = interaction.isButton?.() ?? false;
  if (!again && interaction.channel?.isThread()) return ephemeral(interaction, t('not_here'));
  const running = ctx.jobs[0]; // one game per server at a time
  if (running || starting.has(interaction.guildId)) {
    return ephemeral(interaction, t('already_running', { link: running ? threadLink(running.data) : '' }));
  }

  starting.add(interaction.guildId);
  try {
    const startedAt = Date.now();
    await interaction.reply(t('picking'));

    const counts = {}; // Wikipedia lookups and AI calls made while setting up, for the report
    let picked, opening;
    try {
      await stats.track(counts, async () => {
        picked = await pickArticle();
        [opening, picked.article.photos] = await Promise.all([writeOpening(picked.article), wiki.photos(picked.article).catch(() => [])]);
      });
    } catch (err) {
      console.error(`TwentyQuestions: couldn't start: ${err.message}`);
      return interaction.editReply(t('start_failed'));
    }

    const name = cut(t('thread_name', { topic: opening.topic }), 100);
    let thread;
    if (again) {
      thread = interaction.channel;
      await thread.setName(name).catch(err => console.error(`TwentyQuestions: couldn't rename the thread: ${err.message}`));
      await interaction.editReply(t('started_again', { username: nameOf(interaction) }));
    } else {
      const message = await interaction.editReply(t('started', { username: nameOf(interaction) }));
      thread = await message.startThread({ name, autoArchiveDuration: 60 });
    }
    const endsAt = Date.now() + MINUTES * 60000;
    await thread.send(openingMessage(opening, endsAt));
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    await interaction.followUp({ content: setupReport({ ...picked, counts, seconds }), flags: MessageFlags.Ephemeral }).catch(() => {});

    ctx.add({
      guildId: interaction.guildId,
      channelId: again ? thread.parentId : interaction.channelId,
      threadId: thread.id,
      starterId: interaction.user.id,
      article: picked.article, // cached: its opening is given to Sonnet when judging
      answers: [...new Set([picked.article.title, ...opening.answers])], // guesses that should win (a guideline for Sonnet)
      topic: opening.topic,
      endsAt,
      warned: [],
      used: 0,
      log: [], // { username, text, result }
      hints: [],
      over: false,
    });
  } finally {
    starting.delete(interaction.guildId);
  }
}

// --- Playing ---

// A question or guess, judged by Sonnet. Answered with a reaction.
async function ask(game, message, ctx, jobId) {
  const question = cut(message.content, 300);
  const result = await ai.judge(game, question);
  if (game.over) return;
  game.used++;
  game.log.push({ username: nameOf(message), text: question, result });
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
  await message.reply({ content: t('hint', { hint: text }), allowedMentions: { repliedUser: false } });
}

// --- Ending ---

// The final info card with the article's photos. Discord shows up to 4 images as a gallery when several cards
// share a URL, so photos 1-4 form the gallery and a fifth goes in the corner thumbnail.
function infoCard(article, text) {
  const photos = article.photos ?? (article.image ? [article.image] : []);
  const [first, ...more] = photos.slice(0, 4);
  return [
    {
      color: COLOR,
      url: article.url,
      description: cut(`${text || cut(article.text, 600)}\n\n[${t('read_more')}](${article.url})`, 4096),
      image: first ? { url: first } : undefined,
      thumbnail: photos[4] ? { url: photos[4] } : undefined,
    },
    ...more.map(url => ({ url: article.url, image: { url } })),
  ];
}

// Ends the game once: result line, then the answer with an info card, then stats.
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
  await send({ content: t('reveal', { title: ai.sanitize(game.article.title) }), embeds: infoCard(game.article, wrap?.infocard) });

  const asked = {};
  for (const e of game.log) asked[e.username] = (asked[e.username] ?? 0) + 1;
  const [top] = Object.entries(asked).sort((a, b) => b[1] - a[1]);
  const lines = top ? [t('stat_most_questions', { username: top[0], count: top[1] })] : [];
  for (const [key, label] of [['most_valuable_question', 'stat_valuable'], ['closest_guess', 'stat_closest'], ['farthest_guess', 'stat_farthest'], ['related_guess', 'stat_related']]) {
    const pick = wrap?.[key];
    if (pick?.username && pick?.text) lines.push(t(label, { username: pick.username, text: cut(pick.text, 200) }));
  }
  if (lines.length) await send([t('stats_title'), ...lines].join('\n'));
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
    const route = await ai.route(message.content);
    if (game.over) return;
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

  setupReport, leaksTitle, // exported for tests
};
