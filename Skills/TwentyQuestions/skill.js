const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const t = require('../../src/strings')(__dirname);
const wiki = require('./wiki');
const ai = require('./ai');
const unsplash = require('./unsplash');
const gifs = require('./gifs');
const stats = require('./stats');

const MAX_QUESTIONS = 20; // guesses count too; hints are free
const MINUTES = 20;
const PICK_PARALLEL = 3; // topics checked at the same time
const PICK_ROUNDS = 4; // rounds of checks before giving up
const HEADS_UP = [10, 5]; // questions left when a heads-up is posted
const WARNINGS = [10, 5, 2, 1]; // minutes left when the countdown is posted
const CLOSE_GIF_MS = 3 * 60 * 1000; // at most one "so close" GIF this often
const PHOTO_CANDIDATES = 6; // Unsplash photos the AI chooses from per search
const PHOTO_SEARCHES = 3; // searches to try before going without a photo
const CHECK_MS = 30 * 1000; // how often to check the thread still exists
const COLOR = 0x3366cc;

const lastCheck = {}; // threadId -> timestamp, in memory only
const starting = new Set(); // servers where a game is being set up right now

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const threadLink = data => `https://discord.com/channels/${data.guildId}/${data.threadId}`;

// Spelling-tolerant comparison of a guess with the title and its redirects: ignores accents, case,
// punctuation, "the/a/an", "(qualifiers)" and plurals ("comic" = "Comics", "Frogg" = "Frog").
const singular = word => word.length <= 3 ? word
  : word.endsWith('ies') ? word.slice(0, -3) + 'y'
    : /(ss|sh|ch|x|z)es$/.test(word) ? word.slice(0, -2)
      : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1)
        : word;
const normalize = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\(.*?\)/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/^(the|a|an) /, '').split(' ').map(singular).join(' ');
// Only long names get a free typo: in short ones, one letter often makes a different real word (Iran/Iraq).
// Other misspellings are left to the AI, whose "yes" is double-checked.
const typosAllowed = length => (length >= 8 ? 1 : 0);

// Typos between two strings: missing, extra, wrong or swapped letters ("Frgo" is one typo from "Frog").
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function matches(guess, article) {
  const g = normalize(guess);
  return !!g && [article.title, ...article.aliases].some(name => {
    const n = normalize(name);
    return n === g || distance(n, g) <= typosAllowed(n.length);
  });
}

// Draws and screens several topics at once until one passes. Also returns the rejected ones and why
// ('unsuitable', 'broad' or 'obscure'), for the setup report.
async function pickArticle() {
  const rejected = [];
  for (let round = 0; round < PICK_ROUNDS; round++) {
    const checks = await Promise.allSettled(Array.from({ length: PICK_PARALLEL }, async () => {
      const article = await wiki.pick();
      return { article, verdict: await ai.screen(article) };
    }));
    for (const check of checks) {
      if (check.status !== 'fulfilled') continue;
      const { article, verdict: { suitable, guessable, specific } } = check.value;
      if (suitable && guessable && specific) return { article, rejected };
      rejected.push({ title: article.title, reason: !suitable ? 'unsuitable' : !specific ? 'broad' : 'obscure' });
    }
  }
  throw new Error('No suitable article found');
}

// "A", "A and B", "A, B and C"
const listOf = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// A short, answer-free account of how the topic was picked, for the player who started the game.
// Only topics rejected as too broad or too obscure are named; unsuitable ones are just counted.
function setupReport({ rejected, photo, counts, seconds }) {
  const named = reason => [...new Set(rejected.filter(r => r.reason === reason).map(r => `*${ai.sanitize(r.title)}*`))];
  const broad = named('broad');
  const obscure = named('obscure');
  const unsuitable = rejected.filter(r => r.reason === 'unsuitable').length;
  const story = [];
  if (!rejected.length) story.push(t('report.first_try'));
  if (broad.length) story.push(t(broad.length === 1 ? 'report.broad_one' : 'report.broad_many', { list: listOf(broad) }));
  if (obscure.length) story.push(t(obscure.length === 1 ? 'report.obscure_one' : 'report.obscure_many', { list: listOf(obscure) }));
  if (unsuitable) story.push(t(unsuitable === 1 ? 'report.unsuitable_one' : 'report.unsuitable_many', { count: unsuitable }));
  if (rejected.length) story.push(t('report.picked'));
  story.push(t(photo ? 'report.photo' : 'report.no_photo'));
  story.push(t('report.work', { wikipedia: counts.wikipedia ?? 0, fast: counts.fast ?? 0, smart: counts.smart ?? 0, seconds }));
  return `${t('report.title')}\n${story.join(' ')}`;
}

// A random GIF link for a gif_queries entry, or null. Sent on its own, Discord shows just the GIF.
// GIFs are a garnish: failures are ignored.
async function gif(name) {
  try {
    return await gifs.random(t(`gif_queries.${name}`));
  } catch (err) {
    console.error(`TwentyQuestions: no GIF: ${err.message}`);
    return null;
  }
}

// A topic photo from Unsplash that the AI has checked, or null. Tries the AI's broad searches in order
// (then the topic itself). Never stops a game from starting.
async function pickPhoto(article, opening) {
  const queries = [...new Set([...(opening.image_queries ?? []), opening.topic])].slice(0, PHOTO_SEARCHES);
  try {
    for (const query of queries) {
      const photos = await unsplash.search(query, PHOTO_CANDIDATES);
      if (!photos.length) continue;
      const photo = photos[(await ai.pickPhoto(article, opening.topic, photos)) - 1];
      if (photo) {
        unsplash.reportUse(photo);
        return photo;
      }
    }
  } catch (err) {
    console.error(`TwentyQuestions: no photo: ${err.message}`);
    return null;
  }
  console.error(`TwentyQuestions: no photo passed the check for ${queries.map(q => `"${q}"`).join(', ')}`);
  return null;
}

// The rules as text, with the starting hint card (poem, then photo; Discord always puts card images last).
function openingMessage(opening, photo, endsAt) {
  const poem = opening.poem.split('\n').filter(line => line.trim()).map(line => t('riddle_line', { line: line.trim() }));
  return {
    content: t('rules', { questions: MAX_QUESTIONS, ends: Math.floor(endsAt / 1000), ...t.get('reactions') }),
    embeds: [{ color: COLOR, title: t('hint_title'), description: poem.join('\n'), image: photo ? { url: photo.url } : undefined }],
  };
}

// Small credit line under the card for the photo and GIFs, or null if there's nothing to credit.
// Link previews are suppressed so it stays one line.
function credits(photo) {
  const parts = [];
  if (photo) parts.push(t('photo_credit', { name: photo.photographer, profile: photo.profile, home: unsplash.HOME }));
  if (gifs.enabled()) parts.push(t('gif_credit'));
  return parts.length ? { content: t('credits', { credits: parts.join(' ') }), flags: MessageFlags.SuppressEmbeds } : null;
}

// Ends the game once: result line, then the answer with an info card, then stats.
async function finish(data, thread, outcome, username) {
  if (data.over) return;
  data.over = true;
  const { article, log } = data;
  const send = msg => thread.send(msg).catch(() => {});
  await send(t(outcome, { username, used: data.used, max: MAX_QUESTIONS }));
  await send(t('card_loading'));
  thread.sendTyping().catch(() => {});

  let wrap = null;
  try {
    wrap = await ai.wrapUp(article, log, outcome);
  } catch (err) {
    console.error(`TwentyQuestions: wrap-up failed: ${err.message}`);
  }
  const card = wrap?.infocard || cut(article.text, 600);
  await send({
    content: t('reveal', { title: ai.sanitize(article.title) }),
    embeds: [{ color: COLOR, description: cut(`${card}\n\n[${t('read_more')}](${article.url})`, 4096), image: article.image ? { url: article.image } : undefined }],
  });

  const counts = {};
  for (const e of log) if (e.intent === 'question' || e.intent === 'guess') counts[e.username] = (counts[e.username] ?? 0) + 1;
  const [top] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const lines = [];
  if (top) lines.push(t('stat_most_questions', { username: top[0], count: top[1] }));
  for (const [key, label] of [['most_valuable_question', 'stat_valuable'], ['closest_guess', 'stat_closest'], ['farthest_guess', 'stat_farthest'], ['related_guess', 'stat_related']]) {
    const e = wrap?.[key];
    if (e?.username && e?.text) lines.push(t(label, { username: e.username, text: cut(e.text, 200) }));
  }
  if (lines.length) await send([t('stats_title'), ...lines].join('\n'));
}

async function start(interaction, ctx) {
  if (interaction.channel?.isThread()) return ephemeral(interaction, t('not_here'));
  // One game per server at a time, which also keeps costs down.
  const running = ctx.jobs[0];
  if (running || starting.has(interaction.guildId)) {
    return ephemeral(interaction, t('already_running', { link: running ? threadLink(running.data) : '' }));
  }

  starting.add(interaction.guildId);
  try {
    const startedAt = Date.now();
    await interaction.reply(t('picking'));
    // A "thinking" GIF is added to the message once found; the next edit replaces it.
    const thinking = gif('thinking').then(url => url && interaction.editReply(t('picking_with_gif', { picking: t('picking'), url }))).catch(() => {});
    const counts = {}; // Wikipedia lookups and AI calls made while setting up, for the report
    let article, rejected, opening, photo;
    try {
      await stats.track(counts, async () => {
        ({ article, rejected } = await pickArticle());
        opening = await ai.opening(article);
        photo = await pickPhoto(article, opening);
      });
    } catch (err) {
      console.error(`TwentyQuestions: couldn't start: ${err.message}`);
      await thinking;
      return interaction.editReply(t('start_failed'));
    }
    const username = interaction.member?.displayName ?? interaction.user.username;
    await thinking;
    const message = await interaction.editReply(t('started', { username }));
    const thread = await message.startThread({ name: cut(t('thread_name', { topic: opening.topic }), 100), autoArchiveDuration: 60 });
    const endsAt = Date.now() + MINUTES * 60000;
    await thread.send(openingMessage(opening, photo, endsAt));
    const credit = credits(photo);
    if (credit) await thread.send(credit);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    await interaction.followUp({ content: setupReport({ rejected, photo, counts, seconds }), flags: MessageFlags.Ephemeral }).catch(() => {});
    ctx.add({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      threadId: thread.id,
      starterId: interaction.user.id,
      article,
      riddle: opening.poem,
      topic: opening.topic,
      endsAt,
      warned: [],
      used: 0,
      finalGuess: false,
      log: [],
      hints: [],
      over: false,
    });
  } finally {
    starting.delete(interaction.guildId);
  }
}

async function stop(interaction, ctx) {
  const job = ctx.jobs.find(j => j.data.channelId === interaction.channelId || j.data.threadId === interaction.channelId);
  if (!job) return ephemeral(interaction, t('no_game'));
  const admin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  if (!admin && job.data.starterId !== interaction.user.id) return ephemeral(interaction, t('stop_not_allowed'));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const thread = await interaction.client.channels.fetch(job.data.threadId).catch(() => null);
  if (thread) await finish(job.data, thread, 'stopped');
  else job.data.over = true;
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

  // Every message in a game thread: a question, guess, hint request, stop request, or chat (ignored).
  async message(message, ctx) {
    const job = ctx.jobs.find(j => j.data.threadId === message.channelId);
    if (!job || job.data.over) return;
    const data = job.data;
    const username = message.member?.displayName ?? message.author.username;
    const reply = content => message.reply({ content, allowedMentions: { repliedUser: false } });
    // Answers are reactions: yes, no or sort of, plus a "close" reaction for near misses.
    // Close answers also get a "so close" GIF, at most once every few minutes.
    const react = async result => {
      await message.react(t(`reactions.${result === 'yes_more_specific' ? 'yes' : result === 'not_quite' ? 'no' : result}`));
      if (result !== 'yes_more_specific' && result !== 'not_quite') return;
      await message.react(t('reactions.close'));
      if (Date.now() - (data.lastCloseGif ?? 0) < CLOSE_GIF_MS) return;
      data.lastCloseGif = Date.now();
      const url = await gif('so_close');
      if (url) await message.channel.send(url);
    };

    const { intent, answer, guess } = await ai.interpret(data.article, data.log, username, message.content);
    if (data.over || intent === 'chat') return;
    const entry = { username, intent, text: cut(message.content, 300) };

    if (intent === 'stop') {
      data.log.push(entry);
      await finish(data, message.channel, 'stopped');
      return ctx.remove(job.id);
    }

    if (intent === 'hint') {
      message.channel.sendTyping().catch(() => {});
      const hint = await ai.hint(data.article, data.log, data.hints);
      data.hints.push(hint);
      data.log.push(entry);
      return reply(t('hint', { hint }));
    }

    if (intent === 'question') {
      if (data.finalGuess) return reply(t('guess_now'));
      data.used++;
      data.log.push({ ...entry, answer });
      await react(answer);
    } else {
      // A guess: exact or near-exact names win outright; otherwise a "yes" needs a second opinion.
      const named = guess || message.content;
      let result = ['yes', 'yes_more_specific', 'no', 'not_quite'].includes(answer) ? answer : 'no';
      if (matches(named, data.article)) result = 'yes';
      else if (result === 'yes') result = await ai.verify(data.article, named);
      const final = data.finalGuess;
      data.used++;
      data.log.push({ ...entry, answer: result });
      await react(result);
      if (result === 'yes' || final) {
        await finish(data, message.channel, result === 'yes' ? 'win' : 'lose', username);
        return ctx.remove(job.id);
      }
    }

    if (HEADS_UP.includes(MAX_QUESTIONS - data.used)) {
      await message.channel.send(t('questions_left', { left: MAX_QUESTIONS - data.used }));
    }
    if (data.used >= MAX_QUESTIONS && !data.finalGuess) {
      data.finalGuess = true;
      await message.channel.send(t('last_question'));
    }
  },

  // Posts the countdown, ends the game when time runs out, or silently when the thread is gone.
  async run(data, client) {
    if (data.over) return true;
    data.warned ??= [];
    const now = Date.now();
    const left = data.endsAt - now;
    const due = left > 0 ? WARNINGS.filter(m => left <= m * 60000 && !data.warned.includes(m)) : [];
    if (left > 0 && !due.length && now - (lastCheck[data.threadId] ?? 0) < CHECK_MS) return false;
    lastCheck[data.threadId] = now;

    let thread;
    try {
      thread = await client.channels.fetch(data.threadId);
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        delete lastCheck[data.threadId];
        return true;
      }
      return false; // temporary problem; try again later
    }
    if (left > 0) {
      if (due.length) {
        data.warned.push(...due); // after downtime, several may be due at once; post just one
        await thread.send(t('warning', { ends: Math.floor(data.endsAt / 1000) })).catch(() => {});
      }
      return false;
    }
    await finish(data, thread, 'timeout');
    delete lastCheck[data.threadId];
    return true;
  },

  matches, setupReport, // exported for tests
};
