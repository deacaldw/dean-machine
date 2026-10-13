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
const UNSPLASH_HOME = 'https://unsplash.com/?utm_source=deanmachine&utm_medium=referral';
const photoCredit = n => t('photo_credit', { name: `Photographer ${n}`, profile: `https://unsplash.com/@p${n}?ref`, home: UNSPLASH_HOME });

const PHOTOS = [1, 2, 3].map(n => ({ url: `https://images/${n}.jpg`, preview: `https://images/${n}-small.jpg`, photographer: `Photographer ${n}`, profile: `https://unsplash.com/@p${n}?ref`, downloadLocation: `https://api/download/${n}` }));

const FROG = { title: 'Frog', url: 'https://en.wikipedia.org/wiki/Frog', image: 'https://img/frog.jpg', aliases: ['Frogs', 'Anura'], text: 'Frogs are amphibians...' };
const WRAP = {
  infocard: 'Frogs are amphibians.',
  most_valuable_question: { username: 'Dean', text: 'Is it an animal?' },
  closest_guess: { username: 'Ana', text: 'Toad' },
  farthest_guess: { username: '', text: '' },
  related_guess: { username: '', text: '' },
};

// Fake Claude: interpret() answers from a queue; everything else is canned.
let replies, calls;
function fakeAi(queue) {
  replies = [...queue];
  calls = { verify: 0, hint: 0 };
  ai.interpret = async () => replies.shift();
  ai.verify = async () => { calls.verify++; return replies.shift(); };
  ai.hint = async () => { calls.hint++; return 'I jump quite high for my body size.'; };
  ai.wrapUp = async () => WRAP;
  ai.opening = async () => ({ poem: 'Small and green I sit,\nsinging on a lily pad.\n\nWho am I?', topic: 'Amphibians', image_queries: ['pond', 'nature', 'green'] });
  ai.screen = async () => ({ suitable: true, guessable: true, specific: true });
  ai.pickPhoto = async () => 2;
  calls.reported = [];
  calls.searched = [];
  unsplash.search = async query => { calls.searched.push(query); return PHOTOS; };
  unsplash.reportUse = photo => calls.reported.push(photo.url);
  calls.gifs = [];
  gifs.random = async query => { calls.gifs.push(query); return `https://gif/${query.replace(' ', '-')}.gif`; };
  gifs.enabled = () => true;
}

// Runs /20questions against a fake channel and returns the job and the thread.
async function startGame(articles = [FROG]) {
  wiki.pick = async () => articles.shift();
  const th = thread('t9');
  thread.last = th;
  const jobs = [];
  const i = command('20questions');
  i.channel = { isThread: () => false };
  i.followUps = [];
  i.followUp = async x => { i.followUps.push(x); };
  i.edits = [];
  i.editReply = async content => { i.edits.push(content); i.edited = content; return { startThread: async options => { th.name = options.name; return th; } }; };
  await skill.handle(i, ctx(jobs));
  return { i, th, jobs, card: th.sent[0]?.embeds?.[0] };
}

function thread(id = 't1') {
  const th = { id, sent: [], typing: 0, send: async x => { thread.last.sent.push(x); }, sendTyping: async () => { th.typing++; }, isThread: () => true };
  return th;
}

function game(extra) {
  const th = thread();
  thread.last = th;
  const data = { guildId: 'g1', channelId: 'c1', threadId: 't1', starterId: 'u1', article: FROG, riddle: '', endsAt: Date.now() + 1200000, used: 0, finalGuess: false, log: [], hints: [], over: false, ...extra };
  const jobs = [{ id: 'j0', data }];
  return { th, data, jobs, ctx: ctx(jobs) };
}

function say(g, content, username = 'Dean') {
  const replies = [];
  const message = { channelId: 't1', content, author: { username, bot: false }, member: { displayName: username }, channel: g.th, reply: async x => replies.push(x.content), react: async emoji => replies.push('react:' + Object.keys(t.get('reactions')).find(k => t(`reactions.${k}`) === emoji)) };
  return skill.message(message, g.ctx).then(() => replies);
}

const text = th => th.sent.map(m => (typeof m === 'string' ? m : m.content)).join('\n');

test('the 1,000-article list is drawn 1 in 6 times, half as often as with equal odds', () => {
  const total = Object.values(wiki.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(wiki.WEIGHTS.vital / total, 1 / 6);
  const real = Math.random;
  try {
    const at = roll => { Math.random = () => roll; return wiki.randomSource(); };
    assert.deepEqual([0, 0.4, 0.42, 0.8, 0.84, 0.99].map(at), ['featured', 'featured', 'didYouKnow', 'didYouKnow', 'vital', 'vital']);
  } finally {
    Math.random = real;
  }
});

test('the setup report tells the story without the answer', () => {
  const report = skill.setupReport({
    rejected: [{ title: 'Medicine', reason: 'broad' }, { title: 'Pendock Church', reason: 'obscure' }, { title: 'Spicy topic', reason: 'unsuitable' }],
    photo: PHOTOS[0],
    counts: { wikipedia: 12, fast: 6, smart: 2 },
    seconds: 20,
  });
  assert.equal(report, `${t('report.title')}\n${[
    t('report.broad_one', { list: '*Medicine*' }),
    t('report.obscure_one', { list: '*Pendock Church*' }),
    t('report.unsuitable_one'),
    t('report.picked'),
    t('report.photo'),
    t('report.work', { wikipedia: 12, fast: 6, smart: 2, seconds: 20 }),
  ].join(' ')}`);
  assert.doesNotMatch(report, /Spicy/);

  const firstTry = skill.setupReport({ rejected: [], photo: null, counts: {}, seconds: 4 });
  assert.equal(firstTry, `${t('report.title')}\n${[t('report.first_try'), t('report.no_photo'), t('report.work', { wikipedia: 0, fast: 0, smart: 0, seconds: 4 })].join(' ')}`);

  const many = skill.setupReport({ rejected: ['A', 'B', 'C'].map(title => ({ title, reason: 'broad' })), photo: null, counts: {}, seconds: 1 });
  assert.ok(many.includes(t('report.broad_many', { list: '*A*, *B* and *C*' })));
});

test('stats counts work per game, even when games overlap', async () => {
  const a = {};
  const b = {};
  const work = async (n, key) => { for (let i = 0; i < n; i++) { await new Promise(r => setImmediate(r)); stats.count(key); } };
  await Promise.all([stats.track(a, () => work(3, 'fast')), stats.track(b, () => work(2, 'fast'))]);
  stats.count('fast'); // outside any game: not counted anywhere
  assert.deepEqual([a, b], [{ fast: 3 }, { fast: 2 }]);
});

test('sanitize turns typographic characters into plain ones and drops invisible ones', () => {
  assert.equal(ai.sanitize('“It’s” a test…​ ok'), '"It\'s" a test... ok');
  assert.equal(ai.sanitize('1914–1918 — the Great War'), '1914-1918 - the Great War');
  assert.equal(ai.sanitize('line one\nline two\u0007'), 'line one\nline two');
  assert.equal(ai.sanitize('Hồ Chí Minh 🐸'), 'Hồ Chí Minh 🐸');
});

test('sanitizeAll cleans nested results and keeps lists as lists', () => {
  assert.deepEqual(ai.sanitizeAll({ poem: 'It’s me…', image_queries: ['pond', '“nature”'], n: 2, ok: true }),
    { poem: "It's me...", image_queries: ['pond', '"nature"'], n: 2, ok: true });
});

test('matches accepts names, redirects and small typos, but not related things', () => {
  assert.ok(skill.matches('the frog', FROG));
  assert.ok(skill.matches('Anura', FROG));
  assert.ok(skill.matches('titanic', { title: 'Titanic (1997 film)', aliases: [] }));
  assert.ok(skill.matches('Eiffel Towr', { title: 'Eiffel Tower', aliases: [] }));
  assert.ok(!skill.matches('Pepe the Frog', FROG));
  assert.ok(!skill.matches('Toad', FROG));
});

test('matches accepts plurals, punctuation differences and typos in long names', () => {
  const title = name => ({ title: name, aliases: [] });
  assert.ok(skill.matches('comic', title('Comics')));
  assert.ok(skill.matches('a comic', title('Comics')));
  assert.ok(skill.matches('frogs', FROG));
  assert.ok(skill.matches('city', title('Cities')));
  assert.ok(skill.matches('box', title('Boxes')));
  assert.ok(skill.matches('glass', title('Glass')), "words ending in 'ss' aren't treated as plurals");
  assert.ok(skill.matches('Lewis & Clark Expedition', title('Lewis and Clark Expedition')));
  assert.ok(skill.matches('Mississipi River', title('Mississippi River')), 'a missing letter');
  assert.ok(skill.matches('Shakespaere', title('Shakespeare')), 'swapped letters count as one typo');
});

test('matches never lets a different real word win', () => {
  const title = name => ({ title: name, aliases: [] });
  assert.ok(!skill.matches('Iraq', title('Iran')));
  assert.ok(!skill.matches('Austria', title('Australia')));
  assert.ok(!skill.matches('Mars', title('Mass')));
  assert.ok(!skill.matches('cat', title('Car')));
  assert.ok(!skill.matches('Frgo', FROG), 'short typos are left to the AI');
});

test('/20questions skips unsuitable, unguessable or generic articles and opens a topic thread with rules, hint card and photo credit', async () => {
  fakeAi([]);
  ai.screen = async a => ({ suitable: a.title !== 'Bad', guessable: a.title !== 'Obscure', specific: a.title !== 'Generic' });
  const { i, th, jobs, card } = await startGame([{ ...FROG, title: 'Bad' }, { ...FROG, title: 'Obscure' }, { ...FROG, title: 'Generic' }, FROG]);

  assert.equal(i.replied, t('picking'));
  assert.deepEqual(calls.gifs, ['thinking']);
  assert.match(i.edits[0], /\[\.\]\(https:\/\/gif\/thinking\.gif\)/, 'the GIF link is masked');
  assert.deepEqual(i.edits, [t('picking_with_gif', { picking: t('picking'), url: 'https://gif/thinking.gif' }), t('started', { username: 'Dean' })],
    'the GIF joins the message, then the "started" edit replaces it');
  assert.equal(th.name, t('thread_name', { topic: 'Amphibians' }));
  assert.equal(th.sent.length, 2);

  const ends = Math.floor(jobs[0].data.endsAt / 1000);
  assert.equal(th.sent[0].content, t('rules', { questions: 20, ends, ...t.get('reactions') }));
  assert.match(th.sent[0].content, new RegExp(`<t:${ends}:R>`), 'the countdown is in the rules');
  assert.equal(card.title, t('hint_title'));
  assert.equal(card.description, ['Small and green I sit,', 'singing on a lily pad.', 'Who am I?'].map(line => t('riddle_line', { line })).join('\n'));
  assert.deepEqual(card.image, { url: 'https://images/2.jpg' });
  assert.equal(th.sent[1].content, t('credits', { credits: `${photoCredit(2)} ${t('gif_credit')}` }));
  assert.ok(th.sent[1].flags, 'link previews suppressed');
  assert.doesNotMatch(JSON.stringify(th.sent), /Amphibians|Wikipedia/);
  assert.deepEqual(calls.searched, ['pond']);
  assert.deepEqual(calls.reported, ['https://images/2.jpg']);
  assert.equal(jobs[0].data.topic, 'Amphibians');

  // Only the player who started gets the setup report, and it never names the answer.
  const [report] = i.followUps;
  assert.ok(report.flags, 'the report is only visible to the starter');
  assert.ok(report.content.startsWith(t('report.title')));
  assert.match(report.content, /\*Generic\*/, 'too-broad topics are named');
  assert.match(report.content, /\*Obscure\*/, 'too-obscure topics are named');
  assert.doesNotMatch(report.content, /Bad|Frog|Amphibians/, 'neither unsuitable topics nor the answer are named');
  assert.equal(jobs[0].data.threadId, 't9');
  assert.ok(Math.abs(jobs[0].data.endsAt - Date.now() - 1200000) < 2000);
});

test('if no photo from a search passes, it tries the next broad search', async () => {
  fakeAi([]);
  const picks = [0, 1];
  ai.pickPhoto = async () => picks.shift();
  const { card } = await startGame();
  assert.deepEqual(calls.searched, ['pond', 'nature']);
  assert.deepEqual(card.image, { url: 'https://images/1.jpg' });
});

test('the opening card goes without a photo if none passes the check or Unsplash fails', async () => {
  fakeAi([]);
  ai.pickPhoto = async () => 0;
  let { card, th } = await startGame();
  assert.equal(card.image, undefined);
  assert.equal(th.sent[1].content, t('credits', { credits: t('gif_credit') }), 'only the GIPHY credit');
  assert.deepEqual(calls.reported, []);

  fakeAi([]);
  unsplash.search = async () => { throw new Error('Unsplash returned 403'); };
  const error = console.error;
  console.error = () => {};
  ({ card, th } = await startGame().finally(() => { console.error = error; }));
  assert.equal(card.title, t('hint_title'));
  assert.equal(card.image, undefined);
  assert.equal(th.sent.length, 2);
});

test('/20questions refuses in threads, when a game runs, and reports failures', async () => {
  fakeAi([]);
  let i = command('20questions');
  i.channel = { isThread: () => true };
  await skill.handle(i, ctx([]));
  assert.equal(i.replied.content, t('not_here'));

  const g = game();
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
  assert.equal(i.edited, t('start_failed'), 'the failure message replaces the GIF too');
  assert.equal(jobs.length, 0);
});

test('only one game per server', async () => {
  fakeAi([]);
  const g = game({ channelId: 'other-channel' });
  const i = command('20questions');
  i.channel = { isThread: () => false };
  await skill.handle(i, g.ctx);
  assert.equal(i.replied.content, t('already_running', { link: 'https://discord.com/channels/g1/t1' }));
});

test('naming a broader kind of thing gets yes plus the close reaction, and the game goes on', async () => {
  const g = game();
  fakeAi([
    { intent: 'question', answer: 'yes_more_specific', guess: '' },
    { intent: 'guess', answer: 'yes_more_specific', guess: 'an amphibian' },
  ]);
  assert.deepEqual(await say(g, 'Are you an animal?'), ['react:yes', 'react:close']);
  assert.deepEqual(await say(g, 'An amphibian!'), ['react:yes', 'react:close']);
  assert.equal(calls.verify, 0);
  assert.equal(g.jobs.length, 1);
});

test('close answers get a "so close" GIF at most once every 3 minutes', async () => {
  const g = game();
  fakeAi([
    { intent: 'guess', answer: 'not_quite', guess: 'Toad' },
    { intent: 'question', answer: 'yes_more_specific', guess: '' },
    { intent: 'guess', answer: 'not_quite', guess: 'Newt' },
    { intent: 'question', answer: 'no', guess: '' },
  ]);
  const gifPosts = () => g.th.sent.filter(m => m === 'https://gif/so-close.gif').length; // just the GIF link, no card

  assert.deepEqual(await say(g, 'Toad?'), ['react:no', 'react:close']);
  assert.equal(gifPosts(), 1);
  await say(g, 'Are you an amphibian?');
  assert.equal(gifPosts(), 1, 'not again within 3 minutes');

  g.data.lastCloseGif = Date.now() - 3 * 60 * 1000 - 1;
  await say(g, 'Newt?');
  assert.equal(gifPosts(), 2);
  await say(g, 'Is it big?');
  assert.equal(gifPosts(), 2, 'no GIF for answers that are not close');
});

test('no GIFs without a GIPHY key, and the game carries on', async () => {
  const g = game();
  fakeAi([{ intent: 'guess', answer: 'not_quite', guess: 'Toad' }]);
  gifs.random = async () => null;
  assert.deepEqual(await say(g, 'Toad?'), ['react:no', 'react:close']);
  assert.equal(g.th.sent.length, 0);

  fakeAi([]);
  gifs.random = async () => null;
  gifs.enabled = () => false;
  const { i, th } = await startGame();
  assert.deepEqual(i.edits, [t('started', { username: 'Dean' })], 'no GIF edit');
  assert.equal(th.sent[1].content, t('credits', { credits: photoCredit(2) }), 'no GIPHY credit');
});

test('questions are answered and counted; chat is ignored; hints are free', async () => {
  const g = game();
  fakeAi([
    { intent: 'question', answer: 'yes', guess: '' },
    { intent: 'chat', answer: 'none', guess: '' },
    { intent: 'question', answer: 'sort_of', guess: '' },
    { intent: 'hint', answer: 'none', guess: '' },
  ]);
  assert.deepEqual(await say(g, 'Is it an animal?'), ['react:yes']);
  assert.deepEqual(await say(g, 'lol good one', 'Ana'), []);
  assert.deepEqual(await say(g, 'Does it live in water?'), ['react:sort_of']);
  assert.equal(g.th.typing, 0, 'no typing indicator for reactions');
  assert.deepEqual(await say(g, 'can we get a hint?'), ['I jump quite high for my body size.']);
  assert.equal(g.th.typing, 1, 'typing while the hint is written');
  assert.equal(g.data.used, 2);
  assert.deepEqual(g.data.hints, ['I jump quite high for my body size.']);
  assert.deepEqual(g.data.log.map(e => e.intent), ['question', 'question', 'hint']);
});

test('a near-exact guess wins without a second opinion and ends with card and stats', async () => {
  const g = game();
  fakeAi([{ intent: 'guess', answer: 'no', guess: 'the frog' }]);
  assert.deepEqual(await say(g, 'Is it the frog?'), ['react:yes']);
  assert.equal(calls.verify, 0);
  assert.equal(g.jobs.length, 0);
  assert.equal(g.th.typing, 1, 'typing only while the result card is written');
  const out = text(g.th);
  const order = [t('win', { username: 'Dean', used: 1, max: 20 }), t('card_loading'), t('reveal', { title: 'Frog' })].map(x => out.indexOf(x));
  assert.ok(order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])), 'result, loading line, then the answer');
  assert.equal(g.th.sent.at(-1), [
    t('stats_title'),
    t('stat_most_questions', { username: 'Dean', count: 1 }),
    t('stat_valuable', { username: 'Dean', text: 'Is it an animal?' }),
    t('stat_closest', { username: 'Ana', text: 'Toad' }),
  ].join('\n'), 'stats without a candidate are left out');
  const card = g.th.sent.find(m => m.embeds);
  assert.equal(card.embeds[0].description, `Frogs are amphibians.\n\n[${t('read_more')}](https://en.wikipedia.org/wiki/Frog)`);
  assert.deepEqual(card.embeds[0].image, { url: 'https://img/frog.jpg' });
});

test('an AI "yes" for a misspelling is confirmed by a second opinion, which can overrule it', async () => {
  let g = game();
  fakeAi([{ intent: 'guess', answer: 'yes', guess: 'Frogge' }, 'yes']);
  assert.deepEqual(await say(g, 'Frogge!'), ['react:yes']);
  assert.equal(calls.verify, 1);

  g = game();
  fakeAi([{ intent: 'guess', answer: 'yes', guess: 'Pepe the Frog' }, 'not_quite']);
  assert.deepEqual(await say(g, 'Pepe the Frog?'), ['react:no', 'react:close']);
  assert.equal(g.jobs.length, 1);
});

test('heads-ups at 10 and 5 questions left, once each', async () => {
  const g = game({ used: 9 });
  fakeAi(Array(6).fill({ intent: 'question', answer: 'no', guess: '' }));
  for (let i = 0; i < 6; i++) await say(g, 'Is it big?');
  assert.deepEqual(g.th.sent, [t('questions_left', { left: 10 }), t('questions_left', { left: 5 })]);
});

test('after 20 questions only one final guess is allowed', async () => {
  const g = game({ used: 19 });
  fakeAi([
    { intent: 'guess', answer: 'no', guess: 'Toad' },
    { intent: 'question', answer: 'yes', guess: '' },
    { intent: 'guess', answer: 'no', guess: 'Newt' },
  ]);
  assert.deepEqual(await say(g, 'Toad?'), ['react:no']);
  assert.ok(text(g.th).includes(t('last_question')));
  assert.deepEqual(await say(g, 'Is it green?'), [t('guess_now')]);
  assert.deepEqual(await say(g, 'Newt?'), ['react:no']);
  assert.ok(text(g.th).includes(t('lose')));
  assert.equal(g.jobs.length, 0);
});

test('anyone can stop the game by asking', async () => {
  const g = game();
  fakeAi([{ intent: 'stop', answer: 'none', guess: '' }]);
  await say(g, 'ok stop the game', 'Ana');
  assert.ok(text(g.th).includes(t('stopped')));
  assert.match(text(g.th), /^# Frog$/m);
  assert.equal(g.jobs.length, 0);
});

test('/20questions-stop is for the starter or admins', async () => {
  const g = game();
  fakeAi([]);
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

test('run posts the countdown at 10, 5, 2 and 1 minutes left, once each', async () => {
  fakeAi([]);
  const g = game({ threadId: 'countdown', warned: [] });
  const client = { channels: { fetch: async () => g.th } };
  const at = async minutesLeft => {
    g.data.endsAt = Date.now() + minutesLeft * 60000;
    await skill.run(g.data, client);
  };
  await at(15);
  await at(9.9);
  await at(9.5);
  await at(4.9);
  await at(0.9); // 2 minutes was skipped (e.g. bot offline): only one message for 2 and 1
  assert.equal(g.th.sent.length, 3);
  const [before, after] = t('warning', { ends: '§' }).split('§');
  assert.ok(g.th.sent.every(m => m.startsWith(before) && m.endsWith(after)));
  assert.deepEqual(g.data.warned, [10, 5, 2, 1]);
});

test('run ends the game on timeout, and silently when the thread is gone', async () => {
  fakeAi([]);
  let g = game({ threadId: 'live' });
  assert.equal(await skill.run(g.data, { channels: { fetch: async () => g.th } }), false);

  g = game({ threadId: 'late', endsAt: Date.now() - 1 });
  assert.equal(await skill.run(g.data, { channels: { fetch: async () => g.th } }), true);
  assert.ok(text(g.th).includes(t('timeout')));

  g = game({ threadId: 'gone' });
  const gone = { channels: { fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { status: 404 }); } } };
  assert.equal(await skill.run(g.data, gone), true);
  assert.equal(g.th.sent.length, 0);
});
