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
const AWARD_COLOR = 0xf1c40f;
const LOCKED_COLOR = 0x4f545c; // grey, for awards not earned yet
const AWARD_STREAK = 4; // answers in a row for Trailblazer (yes) and Take a Hint (no)
const LEAD_MS = 2000; // I'm Here to Lead: a question this soon after the round starts
const SLEEP_MS = 2 * 60 * 1000; // Sleep on It: this long since the previous question or hint
const SCENIC_AFTER = 9; // Scenic Route is only judged after this many questions and hints
const ELEVENTH_HOUR_MS = 60 * 1000; // The 11th Hour: a win with less than this left
const SHARPSHOOTER_QUESTIONS = 5; // Sharpshooter: win with this many questions or fewer
const HAT_TRICK_WINS = 3; // Hat Trick: winning guesses in this many games
const CENTURION_QUESTIONS = 100; // Centurion: questions asked in total
const FENCE_SITTER_ANSWERS = 3; // Fence Sitter: "sort of" answers in one game
const REGULAR_GAMES = 10; // Regular: games played
const EXPLORER_CATEGORIES = 5; // Explorer: different categories played
const FULL_HOUSE_PLAYERS = 4; // Full House: players in one game
const LULL_MS = 60 * 1000; // after this long without a question, the players get a recap and some questions to try
const OPTIONS_SECONDS = 25; // how long the options poll runs
const FINAL_POLL_DELAY_MS = 5000; // pause between running out of questions and the final poll
const POLL_ANSWER_LENGTH = 55; // Discord's limit
const DISCORD_MS = 10 * 1000; // closing the poll and counting its votes
const WINS = ['win', 'options_win']; // outcomes where the players found the answer
const RECENT = 6; // lines about what just happened, given to the router
const PLAY_AGAIN = `${path.basename(__dirname)}:again`; // button customIds; the core routes "<Skill>:..." here
const MY_AWARDS = `${path.basename(__dirname)}:awards`;

// Each thread has one job, kept until the thread is closed:
// { guildId, channelId, threadId, category, shortlist: [titles left], closesAt, ...the current round (newRound) }
const lastCheck = {}; // threadId -> timestamp, in memory only
const polling = new Set(); // threadIds with an options poll running
const lastHeard = {}; // threadId -> when a player last posted there, in memory only
const starting = new Map(); // guildId -> game being set up: { category, shortlist, threadId, cancelled }

const ephemeral = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text);
const threadLink = game => `https://discord.com/channels/${game.guildId}/${game.threadId}`;
const nameOf = source => source.member?.displayName ?? (source.user ?? source.author).username;
const randomOf = list => list[Math.floor(Math.random() * list.length)];
// A reply (text, or { content, embeds }) that doesn't ping the player.
const quietReply = (message, reply) => message.reply({ ...(typeof reply === 'string' ? { content: reply } : reply), allowedMentions: { repliedUser: false } });

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
    if (await ai.fits(setup.category, article)) return Object.assign(article, { tags: wiki.tagsOf(title) }); // for the category awards
  }
  throw new NoTopics('category_used_up');
}

// True if the hint gives away a word of the title ("my road" for Abbey Road). Short words are ignored.
const leaksTitle = (hint, title) => title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3).some(word => hint.toLowerCase().includes(word));

// The opening from Sonnet, written once more if the fun facts give away part of the answer.
async function writeOpening(article) {
  const opening = await ai.opening(article);
  return leaksTitle(opening.facts.join(' '), article.title) ? ai.opening(article) : opening;
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

// "Here are three fun facts..." (naming the category again for Play again) and a box with the facts.
function startingHint({ facts }, category, again) {
  const intro = t(again ? 'intro_again' : 'intro', { category });
  return { intro, embeds: [{ color: COLOR, description: facts.map(fact => t('fact', { fact })).join('\n') }] };
}

// A fresh round in the thread's job.
const newRound = (article, opening) => ({
  article, // cached: its opening is given to Sonnet when judging, hinting and writing options
  answers: [...new Set([article.title, ...opening.answers])], // guesses that should win (a guideline for Sonnet)
  startedAt: Date.now(),
  lastAt: null, // when the latest question or hint was asked
  endsAt: Date.now() + MINUTES * 60000,
  warned: [],
  used: 0,
  log: [], // { username, text, result }
  recent: [], // lines about what just happened, for the router
  hints: [...opening.facts], // the fun facts count as hints, so later hints don't repeat them
  players: {}, // userId -> name of everyone who took part (posted or voted), for the awards at the end
  earned: {}, // userId -> award keys earned for the first time this round, marked new in the collection
  over: false,
  closesAt: null,
});

const playAgainButton = (closesAt, content = t('play_again_prompt', { closes: Math.floor(closesAt / 1000) })) => ({
  content,
  components: [{ type: 1, components: [
    { type: 2, style: ButtonStyle.Primary, label: t('play_again'), custom_id: PLAY_AGAIN },
    { type: 2, style: ButtonStyle.Secondary, label: t('my_awards'), custom_id: MY_AWARDS },
  ] }],
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
    else await interaction.reply(t('picking'));

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
      const rules = t('rules', { category, questions: MAX_QUESTIONS, ends: Math.floor(round.endsAt / 1000), intro });
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

// Counts a question or hint, returning when the one before it was (or the round started).
function use(game, message) {
  const before = game.lastAt ?? game.startedAt;
  game.lastAt = message.createdTimestamp ?? Date.now();
  game.used++;
  return before;
}

// "(10 questions left)" at 15, 10 and 5 questions left, added to an answer or a hint.
const withLeft = (game, text) => {
  const left = MAX_QUESTIONS - game.used;
  return QUESTION_REMINDERS.includes(left) ? `${text} ${t('questions_left', { left })}` : text;
};

// --- Awards ---
// Each player collects awards for good, once ever. storage.players is
// { userId: { name, awards: [keys], questions, wins, games, categories: [categories played, lowercase] } }.
// Awards are given when a question is answered (awardsFor), when a poll closes (options) and when a game ends (finish).

const AWARDS = Object.keys(t.get('awards')); // every award, in order
const CATEGORY_AWARDS = AWARDS.filter(key => t.get(`awards.${key}`).tags); // for taking part in a game about these tags

// A player's record, created on first use, with their latest display name (for "Ana, Ben and 2 others have this").
function playerIn(storage, userId, name) {
  const player = ((storage.players ??= {})[userId] ??= { name, awards: [] });
  player.name = name;
  for (const key of ['questions', 'wins', 'games']) player[key] ??= 0;
  player.categories ??= [];
  return player;
}

// Gives the player the awards that are true in `checks` and new to them, plus Completionist once they have all the
// others. Returns the new ones, which are also marked new in this game.
function give(game, storage, userId, name, checks) {
  const player = playerIn(storage, userId, name);
  const fresh = Object.keys(checks).filter(key => checks[key] && !player.awards.includes(key));
  player.awards.push(...fresh);
  if (!player.awards.includes('completionist') && AWARDS.every(key => key === 'completionist' || player.awards.includes(key))) {
    player.awards.push('completionist');
    fresh.push('completionist');
  }
  (game.earned[userId] ??= []).push(...fresh);
  return fresh;
}

// Adds awards to { userId: { name, keys } }, the awards to show at the end of the game.
const collect = (earned, userId, name, keys) => keys.length && (earned[userId] ??= { name, keys: [] }).keys.push(...keys);

// "Ana", "Ana and Ben", "Ana, Ben, Cat and Dan", "Ana, Ben, Cat and 2 others"
function namesList(names) {
  const items = names.length > 4 ? [...names.slice(0, 3), t('list_others', { count: names.length - 3 })] : names;
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')}${t('list_and')}${items.at(-1)}`;
}

// The awards a question just earned its player for the first time ever, added to their collection. Sonnet judged
// Hot Stuff, Breakthrough, Team Player (building on an earlier yes) and Scenic Route with the answer; the rest come
// from the log and the player's totals. `before` is when the previous question or hint was (or the round started).
function awardsFor(game, entry, before, judged, storage) {
  const mine = game.log.filter(e => e.username === entry.username);
  const streak = result => mine.length >= AWARD_STREAK && mine.slice(-AWARD_STREAK).every(e => e.result === result);
  const won = entry.result === 'win';
  const yes = won || entry.result === 'yes';
  const lastYesBy = game.log.slice(0, -1).findLast(e => e.result === 'yes')?.username; // who got the latest yes before this
  const player = playerIn(storage, entry.userId, entry.username);
  player.questions++;
  if (won) player.wins++;
  return give(game, storage, entry.userId, entry.username, {
    welcome_aboard: player.questions === 1,
    winner: won,
    sharpshooter: won && game.used <= SHARPSHOOTER_QUESTIONS,
    no_help_needed: won && game.used === game.log.length, // hints use up questions but aren't in the log
    hat_trick: won && player.wins >= HAT_TRICK_WINS,
    centurion: player.questions >= CENTURION_QUESTIONS,
    fence_sitter: mine.filter(e => e.result === 'sort_of').length >= FENCE_SITTER_ANSWERS,
    hot_stuff: !won && judged.hot_stuff,
    breakthrough: !won && judged.breakthrough,
    team_player: !won && judged.team_player && Boolean(lastYesBy) && lastYesBy !== entry.username, // someone else's yes
    scenic_route: !won && judged.scenic_route,
    first_try: won && mine.length === 1,
    ice_breaker: game.log.length === 1,
    trailblazer: streak('yes'),
    take_a_hint: streak('no'),
    comeback_kid: yes && game.log.length >= 3 && game.log.slice(-3, -1).every(e => e.result === 'no'),
    lead_not_read: entry.at - game.startedAt <= LEAD_MS,
    sleep_on_it: entry.at - before >= SLEEP_MS,
    final_boss: mine.length === 1 && game.used > MAX_QUESTIONS / 2 && yes,
    eleventh_hour: won && (game.endsAt - entry.at < ELEVENTH_HOUR_MS || game.used >= MAX_QUESTIONS),
  });
}

// The awards for everyone who took part, when the game ends: totals across games, a busy game, and the topic's
// category awards. Added to `earned` ({ userId: { name, keys } }).
function endAwards(game, storage, earned) {
  const category = game.category.toLowerCase();
  const topicTags = game.article.tags ?? [];
  const players = Object.entries(game.players);
  for (const [userId, name] of players) {
    const player = playerIn(storage, userId, name);
    player.games++;
    if (!player.categories.includes(category)) player.categories.push(category);
    collect(earned, userId, name, give(game, storage, userId, name, {
      regular: player.games >= REGULAR_GAMES,
      explorer: player.categories.length >= EXPLORER_CATEGORIES,
      full_house: players.length >= FULL_HOUSE_PLAYERS,
      ...Object.fromEntries(CATEGORY_AWARDS.map(key => [key, t.get(`awards.${key}`).tags.some(tag => topicTags.includes(tag))])),
    }));
  }
}

// A box of new awards: each with how many the player has collected, what it means, and who else has it.
// "Dean earned 🔥 Hot Stuff (5/36)", with the rest in small grey text.
function awardBox(storage, userId, username, keys) {
  const count = storage.players[userId].awards.length - keys.length; // before these
  const parts = keys.map((key, i) => {
    const others = Object.entries(storage.players).filter(([id, p]) => id !== userId && p.awards.includes(key)).map(([, p]) => p.name);
    const who = others.length ? t(others.length === 1 ? 'award_others_one' : 'award_others', { names: namesList(others) }) : t('award_first');
    return t('award', { username, ...t.get(`awards.${key}`), count: count + i + 1, total: AWARDS.length, others: who });
  });
  return { color: AWARD_COLOR, description: parts.join('\n\n') };
}

// The My awards button: the player's collection, only visible to them. A box for each award they've earned (marked
// new if earned in this thread's latest game), then one grey box listing how to earn the locked ones.
async function showCollection(interaction, ctx) {
  const userId = interaction.user.id;
  const have = ctx.storage.players?.[userId]?.awards ?? [];
  const fresh = ctx.jobs.find(j => j.data.threadId === interaction.channelId)?.data.earned?.[userId] ?? [];
  const boxes = AWARDS.filter(key => have.includes(key)).map(key => ({
    color: AWARD_COLOR,
    description: t('collection_earned', { ...t.get(`awards.${key}`), new: fresh.includes(key) ? t('collection_new') : '' }),
  }));
  const locked = AWARDS.filter(key => !have.includes(key));
  if (locked.length) {
    const lines = locked.map(key => t('collection_locked_line', t.get(`awards.${key}`))).join('\n');
    boxes.push({ color: LOCKED_COLOR, description: cut(t('collection_locked', { lines }), 4096) });
  }
  // Discord allows 10 boxes per message.
  await interaction.reply({ content: t('collection_title', { count: have.length, total: AWARDS.length }), embeds: boxes.slice(0, 10), flags: MessageFlags.Ephemeral });
  for (let i = 10; i < boxes.length; i += 10) await interaction.followUp({ embeds: boxes.slice(i, i + 10), flags: MessageFlags.Ephemeral });
}

// --- Questions and hints ---

// A question or guess, judged by Sonnet (with the awards it earns) and answered with a short reply, plus a box with
// any awards the player earned for the first time. A right guess wins; after the last question, the players pick
// the answer in a poll.
async function ask(game, message, storage) {
  if (game.used >= MAX_QUESTIONS) return options(game, message.channel, storage); // in case the final poll failed to start
  const question = cut(message.content, 300);
  const { result, ...judged } = await ai.judge(game, question, game.used >= SCENIC_AFTER);
  if (game.over) return;
  if (result === 'not_yes_no') return quietReply(message, t('not_yes_no')); // not counted
  const before = use(game, message);
  const entry = { userId: message.author.id, username: nameOf(message), text: question, result, at: game.lastAt };
  game.log.push(entry);
  remember(game, 'ask', message, { result });

  const earned = awardsFor(game, entry, before, judged, storage);
  if (result === 'win') return finish(game, message.channel, 'win', { storage, earned: { [entry.userId]: { name: entry.username, keys: earned } }, username: entry.username });
  const embeds = earned.length ? [awardBox(storage, entry.userId, entry.username, earned)] : [];
  await quietReply(message, { content: withLeft(game, t(`answers.${result}`)), embeds });
  if (game.used >= MAX_QUESTIONS) await options(game, message.channel, storage, t('out_of_questions'));
}

// A hint from Sonnet, based on what the players have asked so far. Hints count as questions.
async function hint(game, message, storage) {
  if (game.used >= MAX_QUESTIONS) return options(game, message.channel, storage);
  const text = await ai.hint(game);
  if (game.over) return;
  use(game, message);
  game.hints.push(text);
  remember(game, 'hint', message);
  await quietReply(message, withLeft(game, t('hint', { hint: text })));
  if (game.used >= MAX_QUESTIONS) await options(game, message.channel, storage, t('out_of_questions'));
}

// Four options from Sonnet in a poll that closes after OPTIONS_SECONDS. The option with the most votes is the final
// answer, so the game ends either way. Until then, only "stop" is listened to (see message()). `lead` is posted
// first, with a short pause, when the players have run out of questions. Voters earn Wisdom of the Crowd (for
// voting for the right one) and Swing Vote (when the winning option won by their one vote).
async function options(game, channel, storage, lead) {
  polling.add(game.threadId);
  try {
    if (lead) {
      await channel.send(lead);
      await new Promise(resolve => setTimeout(resolve, FINAL_POLL_DELAY_MS));
      if (game.over) return;
    }
    channel.sendTyping().catch(() => {});
    const { answer, decoys } = await ai.options(game);
    if (game.over) return;
    const right = cut(answer, POLL_ANSWER_LENGTH);
    const choices = [right, ...decoys.slice(0, 3).map(d => cut(d, POLL_ANSWER_LENGTH))].sort(() => Math.random() - 0.5);
    const endsAt = Date.now() + OPTIONS_SECONDS * 1000;
    await channel.send(t('options_closes', { ends: Math.ceil(endsAt / 1000) }));
    const sent = await channel.send({
      poll: { question: { text: t('options_question') }, answers: choices.map(text => ({ text })), duration: 1, allowMultiselect: false },
    });
    await new Promise(resolve => setTimeout(resolve, endsAt - Date.now()));
    if (game.over) return sent.poll.end().catch(() => {}); // stopped or timed out meanwhile

    // Close the poll, then fetch the voters of each answer (in the order they were posted).
    const voters = await withTimeout((async () => {
      await sent.poll.end();
      return Promise.all([...sent.poll.answers.values()].map(a => a.voters.fetch({ limit: 100 })));
    })(), DISCORD_MS, 'Closing the poll');
    if (game.over) return;
    const counts = voters.map(users => users.size);
    const [top, second = 0] = [...counts].sort((a, b) => b - a);
    const picked = choices.filter((_, i) => counts[i] === top);
    const outcome = top === 0 ? 'options_no_votes' : picked.length === 1 && picked[0] === right ? 'options_win' : 'options_lose';
    const earned = {};
    voters.forEach((users, i) => users.forEach(user => {
      const name = user.globalName ?? user.username;
      game.players[user.id] ??= name; // voting counts as taking part
      collect(earned, user.id, name, give(game, storage, user.id, name, {
        wisdom_of_the_crowd: choices[i] === right,
        swing_vote: counts[i] === top && top - second === 1,
      }));
    }));
    await finish(game, channel, outcome, { storage, earned, picked: picked.join(t('options_or')) });
  } finally {
    polling.delete(game.threadId);
  }
}

// After a quiet spell: what the players know so far, and three questions they could ask next.
async function nudge(game, thread) {
  const started = Date.now();
  thread.sendTyping().catch(() => {});
  try {
    const { recap, questions } = await ai.recap(game);
    if (game.over || (lastHeard[game.threadId] ?? 0) >= started) return; // ended, or someone posted meanwhile
    const list = questions.slice(0, 3).map(question => t('nudge_question', { question })).join('\n');
    await thread.send(t('nudge', { recap, questions: list }));
  } catch (err) {
    console.error(`TwentyQuestions: couldn't nudge: ${err.message}`);
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

// Ends the game once: result line (with everyone's new awards), then the answer with an info card (with a trailer or
// song link), a documentary if there's one, and the buttons to play again and to see your awards. The thread closes CLOSE_MS later unless
// it's pressed.
async function finish(game, thread, outcome, { storage = {}, earned = {}, ...vars } = {}) {
  if (game.over) return;
  game.over = true;
  game.closesAt = Date.now() + CLOSE_MS;
  const send = msg => thread.send(msg).catch(() => {});
  const result = t(outcome, { ...vars, used: Math.min(game.used, MAX_QUESTIONS), max: MAX_QUESTIONS });
  endAwards(game, storage, earned);
  // A box per player with new awards (Discord allows 10 boxes per message).
  const embeds = Object.entries(earned).slice(0, 10).map(([userId, { name, keys }]) => awardBox(storage, userId, name, keys));
  await send(embeds.length ? { content: result, embeds } : result);
  await send(t(WINS.includes(outcome) ? 'card_loading_won' : 'card_loading'));
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
    if (interaction.isButton?.()) {
      if (interaction.customId === PLAY_AGAIN) return start(interaction, ctx);
      if (interaction.customId === MY_AWARDS) return showCollection(interaction, ctx);
      return;
    }
    if (interaction.isChatInputCommand()) return start(interaction, ctx);
  },

  // Every message in a game thread is routed to ask, hint, options, stop or chat (ignored).
  async message(message, ctx) {
    const job = ctx.jobs.find(j => j.data.threadId === message.channelId);
    if (!job) return;
    const game = job.data;
    if (game.over) return stopSetup(message);
    lastHeard[game.threadId] = Date.now(); // any message cancels a nudge being written
    game.players[message.author.id] = nameOf(message);
    try {
      const route = await ai.route(message.content, game.recent);
      if (game.over) return;
      if (polling.has(game.threadId) && route !== 'stop') return; // only "stop" while the options poll runs
      if (route === 'chat') return remember(game, 'chat', message);
      message.channel.sendTyping().catch(() => {}); // a reply is coming
      if (route === 'ask') return await ask(game, message, ctx.storage);
      if (route === 'hint') return await hint(game, message, ctx.storage);
      if (route === 'options') return await options(game, message.channel, ctx.storage);
      if (route === 'stop') return await finish(game, message.channel, 'stopped', { storage: ctx.storage });
    } catch (err) {
      console.error(`TwentyQuestions: couldn't answer: ${err.message}`);
      await quietReply(message, t('answer_failed')).catch(() => {});
    }
  },

  // Reminds players of the time left, nudges them after a quiet spell, and ends the game when time runs out. Closes
  // the thread CLOSE_MS after a game ends, and forgets the thread (deleting its job) once it's closed or gone.
  async run(game, client, storage = {}) {
    const now = Date.now();
    // A Play again that was cut short (say, by a restart) still lets the thread close.
    if (game.over && !game.closesAt && !starting.has(game.guildId)) game.closesAt = now + CLOSE_MS;
    const left = game.endsAt - now;
    const due = game.over ? [] : TIME_REMINDERS.filter(m => left > 0 && left <= m * 60000 && !game.warned.includes(m));
    const timeUp = !game.over && left <= 0;
    const closing = game.over && game.closesAt && now >= game.closesAt;
    const quietSince = game.lastAt ?? game.startedAt;
    const lull = !game.over && left > 0 && !polling.has(game.threadId) && now - quietSince >= LULL_MS && game.nudgedFor !== quietSince;
    if (!due.length && !timeUp && !closing && !lull && now - (lastCheck[game.threadId] ?? 0) < CHECK_MS) return false;
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
    if (timeUp) await finish(game, thread, 'timeout', { storage });
    else if (due.length) {
      game.warned.push(...due); // after downtime several may be due at once; post just one
      await thread.send(t('time_left', { ends: Math.floor(game.endsAt / 1000) })).catch(() => {});
    }
    if (lull && !game.over) {
      game.nudgedFor = quietSince; // once per quiet spell
      nudge(game, thread); // not awaited, so the loop isn't held up while Sonnet writes it
    }
    return false;
  },

  leaksTitle, // exported for tests
};
