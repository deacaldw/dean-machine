const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const t = require('../../src/strings')(__dirname);
const wiki = require('./wiki');
const ai = require('./ai');
const unsplash = require('./unsplash');
const gifs = require('./gifs');
const stats = require('./stats');

const MAX_QUESTIONS = 20; // the question after the 20th is the final guess
const MINUTES = 20;
const PICK_ATTEMPTS = 12; // topics to check, one at a time, before giving up
const QUESTION_REMINDERS = [15, 10, 5]; // questions left
const TIME_REMINDERS = [15, 10, 5, 1]; // minutes left
const CHECK_MS = 30 * 1000; // how often to check the thread still exists
const COLOR = 0x3366cc;

const lastCheck = {}; // threadId -> timestamp, in memory only
const starting = new Set(); // servers where a game is being set up right now

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const threadLink = game => `https://discord.com/channels/${game.guildId}/${game.threadId}`;
const nameOf = source => source.member?.displayName ?? (source.user ?? source.author).username;
const listOf = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// --- Setting up ---

// Checks random topics one at a time until one is suitable and the right difficulty.
async function pickArticle() {
  const rejected = [];
  for (let i = 0; i < PICK_ATTEMPTS; i++) {
    const article = await wiki.pick();
    const { suitable, guessable } = await ai.screen(article);
    if (suitable && guessable) return { article, rejected };
    rejected.push({ title: article.title, reason: suitable ? 'difficulty' : 'unsuitable' });
  }
  throw new Error('No suitable article found');
}

// The photo for the first general search that finds one, or null. Never stops a game from starting.
async function findPhoto(searches) {
  try {
    for (const query of searches) {
      const photo = await unsplash.search(query);
      if (photo) {
        unsplash.reportUse(photo);
        return photo;
      }
    }
  } catch (err) {
    console.error(`TwentyQuestions: no photo: ${err.message}`);
  }
  return null;
}

async function thinkingGif() {
  try {
    return await gifs.random(t('gif_query'));
  } catch (err) {
    console.error(`TwentyQuestions: no GIF: ${err.message}`);
    return null;
  }
}

// The rules as text, with the starting haiku card (Discord always puts a card's image last).
function openingMessage(poem, photo, endsAt) {
  return {
    content: t('rules', { questions: MAX_QUESTIONS, ends: Math.floor(endsAt / 1000), ...t.get('reactions') }),
    embeds: [{ color: COLOR, title: t('hint_title'), description: `${poem}\n${t('who_am_i')}`, image: photo ? { url: photo.url } : undefined }],
  };
}

// Small credit line for the photo and GIFs, or null if there's nothing to credit.
function credits(photo) {
  const parts = [];
  if (photo) parts.push(t('photo_credit', { name: photo.photographer, profile: photo.profile, home: unsplash.HOME }));
  if (gifs.enabled()) parts.push(t('gif_credit'));
  return parts.length ? { content: t('credits', { credits: parts.join(' ') }), flags: MessageFlags.SuppressEmbeds } : null;
}

// How the topic was picked, for the player who started the game. Never names the answer, or unsuitable topics.
function setupReport({ rejected, photo, counts, seconds }) {
  const named = [...new Set(rejected.filter(r => r.reason === 'difficulty').map(r => `*${ai.sanitize(r.title)}*`))];
  const unsuitable = rejected.filter(r => r.reason === 'unsuitable').length;
  const story = [];
  if (!rejected.length) story.push(t('report.first_try'));
  if (named.length) story.push(t(named.length === 1 ? 'report.difficulty_one' : 'report.difficulty_many', { list: listOf(named) }));
  if (unsuitable) story.push(t(unsuitable === 1 ? 'report.unsuitable_one' : 'report.unsuitable_many', { count: unsuitable }));
  if (rejected.length) story.push(t('report.picked'));
  story.push(t(photo ? 'report.photo' : 'report.no_photo'));
  story.push(t('report.work', { wikipedia: counts.wikipedia ?? 0, fast: counts.fast ?? 0, accurate: counts.accurate ?? 0, seconds }));
  return `${t('report.title')}\n${story.join(' ')}`;
}

async function start(interaction, ctx) {
  if (interaction.channel?.isThread()) return ephemeral(interaction, t('not_here'));
  const running = ctx.jobs[0]; // one game per server at a time
  if (running || starting.has(interaction.guildId)) {
    return ephemeral(interaction, t('already_running', { link: running ? threadLink(running.data) : '' }));
  }

  starting.add(interaction.guildId);
  try {
    const startedAt = Date.now();
    await interaction.reply(t('picking'));
    const gif = thinkingGif().then(url => url && interaction.editReply(t('picking_with_gif', { picking: t('picking'), url }))).catch(() => {});

    const counts = {}; // Wikipedia lookups and AI calls made while setting up, for the report
    let picked, setup, opening, photo;
    try {
      await stats.track(counts, async () => {
        picked = await pickArticle();
        [setup, opening] = await Promise.all([ai.setup(picked.article), ai.opening(picked.article)]);
        photo = await findPhoto(setup.searches);
      });
    } catch (err) {
      console.error(`TwentyQuestions: couldn't start: ${err.message}`);
      await gif;
      return interaction.editReply(t('start_failed'));
    }

    await gif; // the next edit replaces the GIF
    const message = await interaction.editReply(t('started', { username: nameOf(interaction) }));
    const thread = await message.startThread({ name: cut(t('thread_name', { topic: setup.topic }), 100), autoArchiveDuration: 60 });
    const endsAt = Date.now() + MINUTES * 60000;
    await thread.send(openingMessage(opening.poem, photo, endsAt));
    const credit = credits(photo);
    if (credit) await thread.send(credit);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    await interaction.followUp({ content: setupReport({ ...picked, photo, counts, seconds }), flags: MessageFlags.Ephemeral }).catch(() => {});

    ctx.add({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      threadId: thread.id,
      starterId: interaction.user.id,
      article: picked.article, // cached for quote searches
      answers: [...new Set([picked.article.title, ...opening.answers])], // guesses that should win (a guideline for Sonnet)
      topic: setup.topic,
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

// A question or guess: Haiku finds relevant quotes, Sonnet judges with them. Answered with a reaction.
async function ask(game, message, ctx, jobId) {
  const question = cut(message.content, 300);
  const quotes = await ai.quotes(game.article, question);
  const result = await ai.judge(game, question, quotes);
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

// A hint: the same pattern as a question, with quotes that suit what the players have asked so far.
async function hint(game, message) {
  message.channel.sendTyping().catch(() => {});
  const asked = game.log.map(e => e.text).join(' / ') || 'nothing yet';
  const quotes = await ai.quotes(game.article, t('prompts.hint_need', { asked }));
  const text = await ai.hint(game, quotes);
  if (game.over) return;
  game.hints.push(text);
  await message.reply({ content: t('hint', { hint: text }), allowedMentions: { repliedUser: false } });
}

// --- Ending ---

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
  const { article } = game;
  await send({
    content: t('reveal', { title: ai.sanitize(article.title) }),
    embeds: [{
      color: COLOR,
      description: cut(`${wrap?.infocard || cut(article.text, 600)}\n\n[${t('read_more')}](${article.url})`, 4096),
      image: article.image ? { url: article.image } : undefined,
    }],
  });

  const asked = {};
  for (const e of game.log) asked[e.username] = (asked[e.username] ?? 0) + 1;
  const [top] = Object.entries(asked).sort((a, b) => b[1] - a[1]);
  const lines = top ? [t('stat_most_questions', { username: top[0], count: top[1] })] : [];
  for (const [key, label] of [['most_valuable_question', 'stat_valuable'], ['closest_guess', 'stat_closest'], ['farthest_guess', 'stat_farthest'], ['related_guess', 'stat_related']]) {
    const pick = wrap?.[key];
    if (pick?.username && pick?.text) lines.push(t(label, { username: pick.username, text: cut(pick.text, 200) }));
  }
  if (lines.length) await send([t('stats_title'), ...lines].join('\n'));
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

  setupReport, // exported for tests
};
