const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ctx, command } = require('./fakes');

const dir = path.join(__dirname, '..', 'Skills', 'TwentyQuestions');
const skill = require(path.join(dir, 'skill.js'));
const ai = require(path.join(dir, 'ai.js'));
const wiki = require(path.join(dir, 'wiki.js'));
const unsplash = require(path.join(dir, 'unsplash.js'));
const gifs = require(path.join(dir, 'gifs.js'));
const stats = require(path.join(dir, 'stats.js'));
// The skill's own strings, so rewording strings.yaml doesn't break the tests.
const t = require(path.join(__dirname, '..', 'src', 'strings.js'))(dir);

const FROG = { title: 'Frog', url: 'https://en.wikipedia.org/wiki/Frog', image: 'https://img/frog.jpg', text: 'Frogs are amphibians...' };
const PHOTO = { url: 'https://images/pond.jpg', photographer: 'Jane Doe', profile: 'https://unsplash.com/@jane?ref', downloadLocation: 'https://api/download/1' };
const POEM = 'Green skin, quiet pond,\nI leap on a lily pad,\nsinging after rain.';
const WRAP = {
  infocard: 'Frogs are amphibians.\n## Fun fact\nSome frogs can freeze solid.',
  most_valuable_question: { username: 'Dean', text: 'Is it an animal?' },
  closest_guess: { username: 'Ana', text: 'Toad' },
  farthest_guess: { username: '', text: '' },
  related_guess: { username: '', text: '' },
};

// Fake Claude, Wikipedia, Unsplash and GIPHY. route() and judge() answer from queues.
let calls;
function fakes({ routes = [], results = [] } = {}) {
  calls = { quotes: [], judge: [], hint: 0, searched: [], reported: [], gifs: 0 };
  ai.screen = async () => ({ suitable: true, guessable: true });
  ai.setup = async () => ({ topic: 'Amphibians', searches: ['ponds', 'nature', 'green'] });
  ai.opening = async () => ({ poem: POEM, answers: ['frogs', 'Anura'] });
  ai.route = async () => routes.shift();
  ai.quotes = async (article, need) => { calls.quotes.push(need); return ['Frogs are amphibians.']; };
  ai.judge = async (game, question, quotes) => { calls.judge.push({ question, quotes, log: [...game.log], hints: [...game.hints] }); return results.shift(); };
  ai.hint = async () => { calls.hint++; return 'It lives near water.'; };
  ai.wrapUp = async () => WRAP;
  wiki.pick = async () => FROG;
  unsplash.search = async query => { calls.searched.push(query); return PHOTO; };
  unsplash.reportUse = photo => calls.reported.push(photo.url);
  gifs.random = async () => { calls.gifs++; return 'https://gif/thinking.gif'; };
  gifs.enabled = () => true;
}

function thread(id = 't1') {
  const th = { id, sent: [], typing: 0, send: async x => { th.sent.push(x); }, sendTyping: async () => { th.typing++; } };
  return th;
}

// Runs /20questions against a fake channel.
async function startGame(articles = [FROG]) {
  wiki.pick = async () => articles.shift();
  const th = thread('t9');
  const jobs = [];
  const i = command('20questions');
  i.channel = { isThread: () => false };
  i.edits = [];
  i.editReply = async content => { i.edits.push(content); return { startThread: async options => { th.name = options.name; return th; } }; };
  i.followUps = [];
  i.followUp = async x => { i.followUps.push(x); };
  await skill.handle(i, ctx(jobs));
  return { i, th, jobs };
}

// A game in progress, and a way for players to post in its thread.
function game(extra) {
  const th = thread();
  const data = { guildId: 'g1', channelId: 'c1', threadId: 't1', starterId: 'u1', article: FROG, answers: ['Frog', 'frogs'], topic: 'Amphibians', endsAt: Date.now() + 1200000, warned: [], used: 0, log: [], hints: [], over: false, ...extra };
  const jobs = [{ id: 'j0', data }];
  return { th, data, jobs, ctx: ctx(jobs) };
}

async function say(g, content, username = 'Dean') {
  const out = [];
  const message = {
    channelId: 't1', content, author: { username, bot: false }, member: { displayName: username }, channel: g.th,
    reply: async x => out.push(x.content),
    react: async emoji => out.push(`react:${emoji}`),
  };
  await skill.message(message, g.ctx);
  return out;
}

const react = key => `react:${t(`reactions.${key}`)}`; // win and yes share an emoji
const text = th => th.sent.map(m => (typeof m === 'string' ? m : m.content)).join('\n');

// --- Setting up ---

test('/20questions screens topics one at a time and opens a topic thread', async () => {
  fakes();
  const screened = [];
  ai.screen = async a => { screened.push(a.title); return { suitable: a.title !== 'Bad', guessable: a.title !== 'Easy' }; };
  const { i, th, jobs } = await startGame([{ ...FROG, title: 'Bad' }, { ...FROG, title: 'Easy' }, FROG]);

  assert.deepEqual(screened, ['Bad', 'Easy', 'Frog']);
  assert.equal(i.replied, t('picking'));
  assert.deepEqual(i.edits, [t('picking_with_gif', { picking: t('picking'), url: 'https://gif/thinking.gif' }), t('started', { username: 'Dean' })]);
  assert.equal(th.name, t('thread_name', { topic: 'Amphibians' }));

  const [opening, credit] = th.sent;
  const ends = Math.floor(jobs[0].data.endsAt / 1000);
  assert.equal(opening.content, t('rules', { questions: 20, ends, ...t.get('reactions') }));
  assert.deepEqual(opening.embeds[0], { color: 0x3366cc, title: t('hint_title'), description: `${POEM}\n${t('who_am_i')}`, image: { url: PHOTO.url } });
  assert.equal(credit.content, t('credits', { credits: `${t('photo_credit', { name: 'Jane Doe', profile: PHOTO.profile, home: unsplash.HOME })} ${t('gif_credit')}` }));
  assert.doesNotMatch(JSON.stringify(th.sent), /Amphibians|Frog/, 'neither the topic nor the answer appears in the thread');

  const { data } = jobs[0];
  assert.equal(data.article, FROG, 'the article is cached in the game');
  assert.deepEqual(data.answers, ['Frog', 'frogs', 'Anura']);
  assert.ok(Math.abs(data.endsAt - Date.now() - 1200000) < 2000);
});

test('the photo comes from the first general search that finds one', async () => {
  fakes();
  unsplash.search = async query => { calls.searched.push(query); return query === 'nature' ? PHOTO : null; };
  const { th } = await startGame();
  assert.deepEqual(calls.searched, ['ponds', 'nature']);
  assert.deepEqual(calls.reported, [PHOTO.url]);
  assert.deepEqual(th.sent[0].embeds[0].image, { url: PHOTO.url });

  fakes();
  unsplash.search = async () => null;
  gifs.enabled = () => false;
  const { th: noPhoto } = await startGame();
  assert.equal(noPhoto.sent[0].embeds[0].image, undefined);
  assert.equal(noPhoto.sent.length, 1, 'no credit line when there is nothing to credit');
});

test('the starter gets an answer-free report of how the topic was picked', async () => {
  fakes();
  ai.screen = async a => ({ suitable: a.title !== 'Bad', guessable: a.title !== 'Easy' });
  const { i } = await startGame([{ ...FROG, title: 'Easy' }, { ...FROG, title: 'Bad' }, FROG]);
  const [report] = i.followUps;
  assert.ok(report.flags, 'only visible to the starter');
  assert.match(report.content, /\*Easy\*/);
  assert.doesNotMatch(report.content, /Bad|Frog|Amphibians/);

  assert.equal(skill.setupReport({ rejected: [{ title: 'Medicine', reason: 'difficulty' }, { title: 'X', reason: 'unsuitable' }], photo: PHOTO, counts: { wikipedia: 9, fast: 4, accurate: 2 }, seconds: 20 }),
    `${t('report.title')}\n${[
      t('report.difficulty_one', { list: '*Medicine*' }),
      t('report.unsuitable_one'),
      t('report.picked'),
      t('report.photo'),
      t('report.work', { wikipedia: 9, fast: 4, accurate: 2, seconds: 20 }),
    ].join(' ')}`);
  assert.equal(skill.setupReport({ rejected: [], photo: null, counts: {}, seconds: 3 }),
    `${t('report.title')}\n${[t('report.first_try'), t('report.no_photo'), t('report.work', { wikipedia: 0, fast: 0, accurate: 0, seconds: 3 })].join(' ')}`);
});

test('/20questions refuses in threads, while a game runs on the server, and reports failures', async () => {
  fakes();
  let i = command('20questions');
  i.channel = { isThread: () => true };
  await skill.handle(i, ctx([]));
  assert.equal(i.replied.content, t('not_here'));

  const g = game({ channelId: 'other-channel' });
  i = command('20questions');
  i.channel = { isThread: () => false };
  await skill.handle(i, g.ctx);
  assert.equal(i.replied.content, t('already_running', { link: 'https://discord.com/channels/g1/t1' }));

  const jobs = [];
  wiki.pick = async () => { throw new Error('offline'); };
  i = command('20questions');
  i.channel = { isThread: () => false };
  i.editReply = async content => { i.edited = content; };
  const error = console.error;
  console.error = () => {};
  await skill.handle(i, ctx(jobs)).finally(() => { console.error = error; });
  assert.equal(i.edited, t('start_failed'));
  assert.equal(jobs.length, 0);
});

// --- Playing ---

test('questions get quotes from Haiku and a verdict from Sonnet, answered with reactions', async () => {
  const g = game({ hints: ['It lives near water.'] });
  fakes({ routes: ['ask', 'ask', 'ask'], results: ['yes', 'no', 'sort_of'] });
  assert.deepEqual(await say(g, 'Is it an animal?'), [react('yes')]);
  assert.deepEqual(await say(g, 'Is it a mammal?'), [react('no')]);
  assert.deepEqual(await say(g, 'Does it live in water?', 'Ana'), [react('sort_of')]);
  assert.equal(g.th.typing, 0, 'no typing indicator for reactions');

  assert.deepEqual(calls.quotes, ['Is it an animal?', 'Is it a mammal?', 'Does it live in water?']);
  assert.deepEqual(calls.judge[1], {
    question: 'Is it a mammal?',
    quotes: ['Frogs are amphibians.'],
    log: [{ username: 'Dean', text: 'Is it an animal?', result: 'yes' }],
    hints: ['It lives near water.'],
  }, 'Sonnet sees the quotes, the earlier questions and the hints');
  assert.equal(g.data.used, 3);
});

test('chat is ignored and costs nothing more; hints use quotes and are free', async () => {
  const g = game({ log: [{ username: 'Dean', text: 'Is it alive?', result: 'yes' }], used: 1 });
  fakes({ routes: ['chat', 'hint'] });
  assert.deepEqual(await say(g, 'lol good one', 'Ana'), []);
  assert.deepEqual(calls.quotes, []);

  assert.deepEqual(await say(g, 'hint please'), [t('hint', { hint: 'It lives near water.' })]);
  assert.deepEqual(calls.quotes, [t('prompts.hint_need', { asked: 'Is it alive?' })]);
  assert.equal(g.th.typing, 1, 'typing while the hint is written');
  assert.deepEqual(g.data.hints, ['It lives near water.']);
  assert.equal(g.data.used, 1);
});

test('a win ends the game with the info card and all stats', async () => {
  const g = game({ log: [{ username: 'Ana', text: 'Toad?', result: 'no' }], used: 1 });
  fakes({ routes: ['ask'], results: ['win'] });
  assert.deepEqual(await say(g, 'is it a frog'), [react('win')]);
  assert.equal(g.jobs.length, 0);

  const out = text(g.th);
  const order = [t('win', { username: 'Dean', used: 2, max: 20 }), t('card_loading'), t('reveal', { title: 'Frog' })].map(x => out.indexOf(x));
  assert.ok(order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])), 'result, loading line, then the answer');
  assert.equal(g.th.typing, 1, 'typing while the info card is written');

  const card = g.th.sent.find(m => m.embeds);
  assert.equal(card.embeds[0].description, `${WRAP.infocard}\n\n[${t('read_more')}](${FROG.url})`);
  assert.deepEqual(card.embeds[0].image, { url: FROG.image });
  assert.equal(g.th.sent.at(-1), [
    t('stats_title'),
    t('stat_most_questions', { username: 'Ana', count: 1 }),
    t('stat_valuable', { username: 'Dean', text: 'Is it an animal?' }),
    t('stat_closest', { username: 'Ana', text: 'Toad' }),
  ].join('\n'), 'stats without a candidate are left out');
});

test('reminders at 15, 10 and 5 questions left; after 20, one final guess', async () => {
  const g = game({ used: 4 });
  fakes({ routes: Array(17).fill('ask'), results: Array(17).fill('no') });
  for (let i = 0; i < 16; i++) await say(g, 'Is it big?');
  assert.deepEqual(g.th.sent, [
    t('questions_left', { left: 15 }),
    t('questions_left', { left: 10 }),
    t('questions_left', { left: 5 }),
    t('last_question'),
  ]);
  assert.equal(g.jobs.length, 1);

  await say(g, 'Is it a newt?');
  assert.ok(text(g.th).includes(t('lose')));
  assert.equal(g.jobs.length, 0);
});

test('anyone can stop the game by asking', async () => {
  const g = game();
  fakes({ routes: ['stop'] });
  await say(g, 'ok stop the game', 'Ana');
  assert.ok(text(g.th).includes(t('stopped')));
  assert.ok(text(g.th).includes(t('reveal', { title: 'Frog' })));
  assert.equal(g.jobs.length, 0);
});

test('/20questions-stop is for the starter or admins', async () => {
  const g = game();
  fakes();
  let i = command('20questions-stop', {}, { userId: 'u2' });
  await skill.handle(i, g.ctx);
  assert.equal(i.replied.content, t('stop_not_allowed'));

  i = command('20questions-stop');
  i.client = { channels: { fetch: async () => g.th } };
  i.deferReply = async () => {};
  i.editReply = async content => { i.edited = content; };
  await skill.handle(i, g.ctx);
  assert.equal(i.edited, t('stop_done'));
  assert.equal(g.jobs.length, 0);
});

// --- Timer ---

test('time reminders at 15, 10, 5 and 1 minutes left, once each', async () => {
  fakes();
  const g = game({ threadId: 'countdown' });
  const client = { channels: { fetch: async () => g.th } };
  const at = async minutesLeft => {
    g.data.endsAt = Date.now() + minutesLeft * 60000;
    await skill.run(g.data, client);
  };
  for (const minutes of [16, 14.9, 14.5, 9.9, 4.9, 0.9]) await at(minutes);
  assert.equal(g.th.sent.length, 4);
  const [before, after] = t('time_left', { ends: '§' }).split('§');
  assert.ok(g.th.sent.every(m => m.startsWith(before) && m.endsWith(after)));
  assert.deepEqual(g.data.warned, [15, 10, 5, 1]);
});

test('run ends the game on timeout, and silently when the thread is gone', async () => {
  fakes();
  let g = game({ threadId: 'late', endsAt: Date.now() - 1 });
  assert.equal(await skill.run(g.data, { channels: { fetch: async () => g.th } }), true);
  assert.ok(text(g.th).includes(t('timeout')));

  g = game({ threadId: 'gone' });
  const gone = { channels: { fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { status: 404 }); } } };
  assert.equal(await skill.run(g.data, gone), true);
  assert.equal(g.th.sent.length, 0);
});

// --- Helpers ---

test('the 1,000-article list is drawn 1 in 6 times', () => {
  const total = Object.values(wiki.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(wiki.WEIGHTS.vital / total, 1 / 6);
});

test('stats counts work per game, even when games overlap', async () => {
  const a = {};
  const b = {};
  const work = async (n, key) => { for (let i = 0; i < n; i++) { await new Promise(r => setImmediate(r)); stats.count(key); } };
  await Promise.all([stats.track(a, () => work(3, 'fast')), stats.track(b, () => work(2, 'fast'))]);
  stats.count('fast'); // outside any game: not counted
  assert.deepEqual([a, b], [{ fast: 3 }, { fast: 2 }]);
});

test('sanitize makes AI text plain, keeping letters, emoji and lists', () => {
  assert.equal(ai.sanitize('“It’s” a test…​ ok'), '"It\'s" a test... ok');
  assert.equal(ai.sanitize('1914–1918 — the Great War'), '1914-1918 - the Great War');
  assert.equal(ai.sanitize('Hồ Chí Minh 🐸'), 'Hồ Chí Minh 🐸');
  assert.deepEqual(ai.sanitizeAll({ poem: 'It’s me…', answers: ['frog', '“toad”'], ok: true }), { poem: "It's me...", answers: ['frog', '"toad"'], ok: true });
});
