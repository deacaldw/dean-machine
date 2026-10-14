const path = require('path');
const { MessageFlags, ButtonStyle } = require('discord.js');
const t = require('../../src/strings')(__dirname);
const wiki = require('./wiki');
const ai = require('./ai');
const youtube = require('./youtube');

const MAX_QUESTIONS = 20; // the question after the 20th is the final guess
const MINUTES = 20;
const CLOSE_MS = 10 * 60 * 1000; // the thread is closed this long after a game ends, unless another one starts
const SETUP_MS = 40 * 1000; // a new game is ready within this, or the start is abandoned
const OPENING_ATTEMPTS = 3; // topics to try if the opening can't be written
const SHORTLIST_INPUT = 1000; // most tagged topics Sonnet sorts through for a category
const QUESTION_REMINDERS = [15, 10, 5]; // questions left
const TIME_REMINDERS = [15, 10, 5, 1]; // minutes left
const CHECK_MS = 30 * 1000; // how often to check the thread is still open
const COLOR = 0x3366cc;
const OPTIONS_SECONDS = 10; // how long the options poll runs
const POLL_ANSWER_LENGTH = 55; // Discord's limit
const DISCORD_MS = 10 * 1000; // closing the poll and counting its votes
const RECENT = 6; // lines about what just happened, given to the router
const PLAY_AGAIN = `${path.basename(__dirname)}:again`; // button customId; the core routes "<Skill>:..." here

// Each thread has one job, kept until the thread is closed:
// { guildId, channelId, threadId, category, shortlist: [titles left], closesAt, ...the current round (newRound) }
const lastCheck = {}; // threadId -> timestamp, in memory only
const polling = new Set(); // threadIds with an options poll running
const starting = new Map(); // guildId -> game being set up: { category, shortlist, threadId, cancelled }

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const threadLink = game => `https://discord.com/channels/${game.guildId}/${game.threadId}`;
const nameOf = source => source.member?.displayName ?? (source.user ?? source.author).username;
const randomOf = list => list[Math.floor(Math.random() * list.length)];

// Rejects once `ms` have passed, so nothing a player waits for can hang.
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} seconds`)), ms).unref?.()),
]);

// Thrown when a game being set up is stopped by a player.
class Cancelled extends Error {}
// Thrown when a category has no topics (left); the message is the strings.yaml key to show.
class NoTopics extends Error {}
const checkCancelled = setup => {
  if (setup.cancelled) throw new Cancelled('Stopped by a player');
};

// --- Setting up ---

// The topics for a category, chosen once per thread by Sonnet: which tags to search (none needed when the category
// is a tag itself), then which tagged topics fit. -> article titles
async function makeShortlist(setup) {
  const tags = wiki.tags().includes(setup.category) ? [setup.category] : await ai.categories(setup.category, wiki.tags());
  checkCancelled(setup);
  const found = wiki.tagged(tags).sort(() => Math.random() - 0.5).slice(0, SHORTLIST_INPUT);
  const picked = found.length ? await ai.shortlist(setup.category, found.map(c => c.name)) : [];
  checkCancelled(setup);
  if (!picked.length) throw new NoTopics('category_none');
  return picked.map(i => found[i].title);
}

// A random topic from the shortlist that, judging by its article, really fits the category. Each one is taken off
// the list, so it's never played twice (and a misfit is never tried again).
async function pickArticle(setup) {
  const list = setup.shortlist;
  while (list.length) {
    checkCancelled(setup);
    const [title] = list.splice(Math.floor(Math.random() * list.length), 1);
    const article = await wiki.article(title);
    if (!article) continue;
    checkCancelled(setup);
    if (await ai.fits(setup.category, article)) return article;
  }
  throw new NoTopics('category_used_up');
}

// True if the hint gives away a word of the title ("my road" for Abbey Road). Short words are ignored.
const leaksTitle = (hint, title) => title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3).some(word => hint.toLowerCase().includes(word));

// The opening from Sonnet, written once more if the starting hint gives away part of the answer.
async function writeOpening(article) {
  const opening = await ai.opening(article);
  return leaksTitle(opening.hint, article.title) ? ai.opening(article) : opening;
}

// Everything a game needs: the article (with its photos) and the opening. If the opening can't be written (say,
// Claude's output filter blocks it), another topic is tried.
async function prepare(setup) {
  setup.shortlist ??= await makeShortlist(setup);
  for (let attempt = 0; attempt < OPENING_ATTEMPTS; attempt++) {
    const article = await pickArticle(setup);
    try {
      const [opening, photos] = await Promise.all([writeOpening(article), wiki.photos(article).catch(() => [])]);
      checkCancelled(setup);
      article.photos = photos;
      return { article, opening };
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      console.error(`TwentyQuestions: no opening for ${article.title}: ${err.message}`);
    }
  }
  throw new Error('No opening could be written');
}

// "The category is X. Here's a quote/haiku to get you on your way..." and a box with it in italics (and the
// quote's author).
function startingHint({ hint, kind, author, authorIsAnswer }, category, again) {
  // Line breaks, or " / " when Claude writes a haiku on one line.
  const lines = hint.split(/\n| \/ /).filter(line => line.trim()).map(line => t('hint_line', { line: line.trim() }));
  if (kind === 'quote') lines.push(t('quote_author', { author: authorIsAnswer || !author ? t('author_is_answer') : author }));
  const intro = t('intro', { category: t(again ? 'category_next' : 'category_first', { category }), hint: t(kind === 'quote' ? 'intro_quote' : 'intro_haiku') });
  return { intro, embeds: [{ color: COLOR, description: lines.join('\n') }] };
}

// A fresh round in the thread's job.
const newRound = (article, opening) => ({
  article, // cached: its opening is given to Sonnet when judging
  answers: [...new Set([article.title, ...opening.answers])], // guesses that should win (a guideline for Sonnet)
  endsAt: Date.now() + MINUTES * 60000,
  warned: [],
  used: 0,
  log: [], // { username, text, result }
  recent: [], // lines about what just happened, for the router
  hints: [],
  over: false,
  closesAt: null,
});

const playAgainButton = (closesAt, content = t('play_again_prompt', { closes: Math.floor(closesAt / 1000) })) => ({
  content,
  components: [{ type: 1, components: [{ type: 2, style: ButtonStyle.Primary, label: t('play_again'), custom_id: PLAY_AGAIN }] }],
});

// Starts a game: from /20questions in a new thread (with the category given, or a random one), or from the Play
// again button in the same thread, with another topic from the thread's shortlist.
async function start(interaction, ctx) {
  const again = interaction.isButton?.() ?? false;
  const job = again ? ctx.jobs.find(j => j.data.threadId === interaction.channelId) : null;
  if (again && !job) return ephemeral(interaction, t('thread_closed'));
  if (!again && interaction.channel?.isThread()) return ephemeral(interaction, t('not_here'));
  const running = ctx.jobs.find(j => !j.data.over); // one game per server at a time
  if (running || starting.has(interaction.guildId)) {
    return ephemeral(interaction, t('already_running', { link: running ? threadLink(running.data) : '' }));
  }

  const category = job?.data.category ?? (interaction.options.getString(t('category_option'))?.trim() || randomOf(t.get('categories')));
  // Players can stop a Play again while it's being set up (see message()).
  const setup = { category, shortlist: job?.data.shortlist, threadId: job?.data.threadId, cancelled: false };
  starting.set(interaction.guildId, setup);
  if (job) job.data.closesAt = null; // a new game keeps the thread open
  try {
    // Play again: confirm at once and remove the button (no second click) while the next topic is picked.
    if (again) await interaction.update({ content: t('play_again_starting', { username: nameOf(interaction) }), components: [] });
    else await interaction.reply(t('picking', { category }));

    let article, opening;
    try {
      ({ article, opening } = await withTimeout(prepare(setup), SETUP_MS, 'Starting a game'));
    } catch (err) {
      setup.cancelled = true; // stops any work still running in the background
      const key = err instanceof Cancelled ? 'start_cancelled' : err instanceof NoTopics ? err.message : 'start_failed';
      if (key === 'start_failed') console.error(`TwentyQuestions: couldn't start: ${err.message}`);
      const content = t(key, { category });
      if (!job) return interaction.editReply(content);
      job.data.closesAt = Date.now() + CLOSE_MS;
      // Play again offers its button again, unless the topics are used up.
      return interaction.editReply(key === 'category_used_up' ? content : playAgainButton(job.data.closesAt, content));
    }

    const round = newRound(article, opening);
    const { intro, embeds } = startingHint(opening, category, again);
    if (job) {
      Object.assign(job.data, round);
      await interaction.channel.send({ content: intro, embeds });
    } else {
      const message = await interaction.editReply(t('started', { username: nameOf(interaction), category }));
      const thread = await message.startThread({ name: cut(t('thread_name', { category }), 100), autoArchiveDuration: 60 });
      ctx.add({ guildId: interaction.guildId, channelId: interaction.channelId, threadId: thread.id, category, shortlist: setup.shortlist, ...round });
      const rules = t('rules', { questions: MAX_QUESTIONS, ends: Math.floor(round.endsAt / 1000), intro, ...t.get('reactions') });
      await thread.send({ content: rules, embeds });
    }
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
async function ask(game, message) {
  const question = cut(message.content, 300);
  const result = await ai.judge(game, question);
  if (game.over) return;
  game.used++;
  game.log.push({ username: nameOf(message), text: question, result });
  remember(game, 'ask', message, { result });
  await message.react(t(`reactions.${result}`));

  if (result === 'win' || game.used > MAX_QUESTIONS) return finish(game, message.channel, result === 'win' ? 'win' : 'lose', { username: nameOf(message) });
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

// Four options from Sonnet in a poll that closes after OPTIONS_SECONDS. The option with the most votes is the final
// answer, so the game ends either way. Until then, only "stop" is listened to (see message()).
async function options(game, message) {
  polling.add(game.threadId);
  try {
    message.channel.sendTyping().catch(() => {});
    const { answer, decoys } = await ai.options(game);
    if (game.over) return;
    const right = cut(answer, POLL_ANSWER_LENGTH);
    const choices = [right, ...decoys.slice(0, 3).map(d => cut(d, POLL_ANSWER_LENGTH))].sort(() => Math.random() - 0.5);
    const endsAt = Date.now() + OPTIONS_SECONDS * 1000;
    await message.channel.send(t('options_closes', { ends: Math.ceil(endsAt / 1000) }));
    const sent = await message.channel.send({
      poll: { question: { text: t('options_question') }, answers: choices.map(text => ({ text })), duration: 1, allowMultiselect: false },
    });
    await new Promise(resolve => setTimeout(resolve, endsAt - Date.now()));
    if (game.over) return sent.poll.end().catch(() => {}); // stopped or timed out meanwhile

    // Close the poll, then count the voters of each answer (in the order they were posted).
    const counts = await withTimeout((async () => {
      await sent.poll.end();
      return Promise.all([...sent.poll.answers.values()].map(a => a.voters.fetch({ limit: 100 }).then(voters => voters.size)));
    })(), DISCORD_MS, 'Closing the poll');
    if (game.over) return;
    const top = Math.max(...counts);
    const picked = choices.filter((_, i) => counts[i] === top);
    const outcome = top === 0 ? 'options_no_votes' : picked.length === 1 && picked[0] === right ? 'options_win' : 'options_lose';
    await finish(game, message.channel, outcome, { picked: picked.join(t('options_or')) });
  } finally {
    polling.delete(game.threadId);
  }
}

// "Stop the game" in a thread while its next round is being set up.
async function stopSetup(message) {
  const setup = starting.get(message.guildId);
  if (!setup || setup.threadId !== message.channelId) return;
  const route = await ai.route(message.content).catch(() => 'chat');
  if (route === 'stop') setup.cancelled = true;
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
// documentary if there's one, and the button to play again. The thread closes CLOSE_MS later unless it's pressed.
async function finish(game, thread, outcome, extra = {}) {
  if (game.over) return;
  game.over = true;
  game.closesAt = Date.now() + CLOSE_MS;
  const send = msg => thread.send(msg).catch(() => {});
  await send(t(outcome, { ...extra, used: Math.min(game.used, MAX_QUESTIONS), max: MAX_QUESTIONS }));
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
  await send(playAgainButton(game.closesAt));
}

module.exports = {
  commands: [{
    name: t('command'),
    description: t('description'),
    options: [{ name: t('category_option'), description: t('category_description'), type: 3, max_length: 100 }],
  }],

  async handle(interaction, ctx) {
    if (interaction.isButton?.()) return interaction.customId === PLAY_AGAIN ? start(interaction, ctx) : undefined;
    if (interaction.isChatInputCommand()) return start(interaction, ctx);
  },

  // Every message in a game thread is routed to ask, hint, options, stop or chat (ignored).
  async message(message, ctx) {
    const job = ctx.jobs.find(j => j.data.threadId === message.channelId);
    if (!job) return;
    const game = job.data;
    if (game.over) return stopSetup(message);
    try {
      const route = await ai.route(message.content, game.recent);
      if (game.over) return;
      if (polling.has(game.threadId) && route !== 'stop') return; // only "stop" while the options poll runs
      if (route === 'chat') return remember(game, 'chat', message);
      if (route === 'ask') return await ask(game, message);
      if (route === 'hint') return await hint(game, message);
      if (route === 'options') return await options(game, message);
      if (route === 'stop') return await finish(game, message.channel, 'stopped');
    } catch (err) {
      console.error(`TwentyQuestions: couldn't answer: ${err.message}`);
      await message.reply({ content: t('answer_failed'), allowedMentions: { repliedUser: false } }).catch(() => {});
    }
  },

  // Reminds players of the time left and ends the game when time runs out. Closes the thread CLOSE_MS after a game
  // ends, and forgets the thread (deleting its job) once it's closed or gone.
  async run(game, client) {
    const now = Date.now();
    // A Play again that was cut short (say, by a restart) still lets the thread close.
    if (game.over && !game.closesAt && !starting.has(game.guildId)) game.closesAt = now + CLOSE_MS;
    const left = game.endsAt - now;
    const due = game.over ? [] : TIME_REMINDERS.filter(m => left > 0 && left <= m * 60000 && !game.warned.includes(m));
    const timeUp = !game.over && left <= 0;
    const closing = game.over && game.closesAt && now >= game.closesAt;
    if (!due.length && !timeUp && !closing && now - (lastCheck[game.threadId] ?? 0) < CHECK_MS) return false;
    lastCheck[game.threadId] = now;

    const forget = () => { delete lastCheck[game.threadId]; return true; };
    let thread;
    try {
      thread = await client.channels.fetch(game.threadId);
    } catch (err) {
      if (err.status !== 403 && err.status !== 404) return false; // temporary problem; try again later
      return forget();
    }
    if (thread.archived) return forget(); // closed by someone else
    if (closing) {
      await thread.setArchived(true).catch(err => console.error(`TwentyQuestions: couldn't close the thread: ${err.message}`));
      return forget();
    }
    if (timeUp) await finish(game, thread, 'timeout');
    else if (due.length) {
      game.warned.push(...due); // after downtime several may be due at once; post just one
      await thread.send(t('time_left', { ends: Math.floor(game.endsAt / 1000) })).catch(() => {});
    }
    return false;
  },

  leaksTitle, // exported for tests
};
