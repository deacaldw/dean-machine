const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const t = require('../../src/strings')(__dirname);
const wiki = require('./wiki');
const ai = require('./ai');
const unsplash = require('./unsplash');
const gifs = require('./gifs');

const MAX_QUESTIONS = 20; // guesses count too; hints are free
const MINUTES = 20;
const PICK_ATTEMPTS = 8; // articles to try before giving up
const HEADS_UP = [10, 5]; // questions left when a heads-up is posted
const WARNINGS = [10, 5, 2, 1]; // minutes left when the countdown is posted
const CLOSE_GIF_MS = 3 * 60 * 1000; // at most one "so close" GIF this often
const CHECK_MS = 30 * 1000; // how often to check the thread still exists
const COLOR = 0x3366cc;

const lastCheck = {}; // threadId -> timestamp, in memory only
const starting = new Set(); // servers where a game is being set up right now

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const threadLink = data => `https://discord.com/channels/${data.guildId}/${data.threadId}`;

// Spelling-tolerant comparison of a guess with the title and its redirects ("Frogg" = "Frog").
const normalize = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/^(the|a|an) /, '').trim();

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

function matches(guess, article) {
  const g = normalize(guess);
  return !!g && [article.title, ...article.aliases].some(name => {
    const n = normalize(name);
    return n === g || (n.length >= 6 && distance(n, g) <= Math.floor(n.length / 6));
  });
}

async function pickArticle() {
  for (let i = 0; i < PICK_ATTEMPTS; i++) {
    const article = await wiki.pick();
    const { suitable, guessable } = await ai.screen(article);
    if (suitable && guessable) return article;
  }
  throw new Error('No suitable article found');
}

// A card with a random GIF for a gif_queries entry, or null. GIFs are a garnish: failures are ignored.
async function gifCard(name) {
  try {
    const url = await gifs.random(t(`gif_queries.${name}`));
    return url ? { color: COLOR, image: { url }, footer: { text: t('gif_credit') } } : null;
  } catch (err) {
    console.error(`TwentyQuestions: no GIF: ${err.message}`);
    return null;
  }
}

// A topic photo from Unsplash that the AI has checked, or null. Never stops a game from starting.
async function pickPhoto(article, opening) {
  try {
    const photos = await unsplash.search(opening.image_query);
    if (!photos.length) return null;
    const photo = photos[(await ai.pickPhoto(article, opening.topic, photos)) - 1] ?? null;
    if (photo) unsplash.reportUse(photo);
    return photo;
  } catch (err) {
    console.error(`TwentyQuestions: no photo: ${err.message}`);
    return null;
  }
}

// The rules as text, with the starting hint card (poem, then photo; Discord always puts card images last).
function openingMessage(opening, photo, endsAt) {
  const poem = opening.poem.split('\n').filter(line => line.trim()).map(line => t('riddle_line', { line: line.trim() }));
  return {
    content: t('rules', { questions: MAX_QUESTIONS, ends: Math.floor(endsAt / 1000), ...t.get('reactions') }),
    embeds: [{ color: COLOR, title: t('hint_title'), description: poem.join('\n'), image: photo ? { url: photo.url } : undefined }],
  };
}

// Small credit line under the card. Link previews are suppressed so it stays one line.
function photoCredit(photo) {
  return {
    content: t('photo_credit', { name: photo.photographer, profile: photo.profile, home: unsplash.HOME }),
    flags: MessageFlags.SuppressEmbeds,
  };
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
    await interaction.reply(t('picking'));
    // A "thinking" GIF joins the message once found; it's awaited before the message changes again.
    const thinking = gifCard('thinking').then(card => card && interaction.editReply({ embeds: [card] })).catch(() => {});
    let article, opening;
    try {
      article = await pickArticle();
      opening = await ai.opening(article);
    } catch (err) {
      console.error(`TwentyQuestions: couldn't start: ${err.message}`);
      await thinking;
      return interaction.editReply({ content: t('start_failed'), embeds: [] });
    }
    const photo = await pickPhoto(article, opening);
    const username = interaction.member?.displayName ?? interaction.user.username;
    await thinking;
    const message = await interaction.editReply({ content: t('started', { username }), embeds: [] }); // drops the GIF
    const thread = await message.startThread({ name: cut(t('thread_name', { topic: opening.topic }), 100), autoArchiveDuration: 60 });
    const endsAt = Date.now() + MINUTES * 60000;
    await thread.send(openingMessage(opening, photo, endsAt));
    if (photo) await thread.send(photoCredit(photo));
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
      const card = await gifCard('so_close');
      if (card) await message.channel.send({ embeds: [card] });
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

  matches, // exported for tests
};
