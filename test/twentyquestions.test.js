const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ctx, command } = require('./fakes');

const dir = path.join(__dirname, '..', 'Skills', 'TwentyQuestions');
const skill = require(path.join(dir, 'skill.js'));
const ai = require(path.join(dir, 'ai.js'));
const wiki = require(path.join(dir, 'wiki.js'));
const realCandidates = wiki.candidates; // the other tests replace it with a fake
const { log } = require(path.join(dir, 'log.js'));
const youtube = require(path.join(dir, 'youtube.js'));
const realYoutubeSearch = youtube.search; // the other tests replace it with a fake
// The skill's own strings, so rewording strings.yaml doesn't break the tests.
const t = require(path.join(__dirname, '..', 'src', 'strings.js'))(dir);

const FROG = { title: 'Frog', url: 'https://en.wikipedia.org/wiki/Frog', image: 'https://img/frog.jpg', text: 'Frogs are amphibians...' };
const PHOTOS = [1, 2, 3, 4, 5].map(n => `https://upload.wikimedia.org/frog${n}.jpg`);
const POEM = 'Green skin, quiet pond,\nI leap on a lily pad,\nsinging after rain.';
const WRAP = {
  infocard: 'Frogs are amphibians.\n## Fun fact\nSome frogs can freeze solid.',
  most_valuable_question: { username: 'Dean', text: 'Is it an animal?' },
  closest_guess: { username: 'Ana', text: 'Toad' },
  farthest_guess: { username: '', text: '' },
  related_guess: { username: '', text: '' },
  video: { kind: 'none', search: '' },
};

// Fake Claude and Wikipedia. route() and judge() answer from queues.
let calls;
function fakes({ routes = [], results = [] } = {}) {
  calls = { judge: [], hint: 0, screened: [], fetched: [], routed: [] };
  ai.screen = async names => { calls.screened.push(names); return names.map(() => ({ suitable: true, guessable: true })); };
  ai.opening = async () => ({ topic: 'Amphibians', kind: 'haiku', hint: POEM, answers: ['frogs', 'Anura'] });
  ai.route = async (message, recent) => { calls.routed.push([...(recent ?? [])]); return routes.shift(); };
  ai.judge = async (game, question) => { calls.judge.push({ question, log: [...game.log], hints: [...game.hints] }); return results.shift(); };
  ai.hint = async () => { calls.hint++; return 'It lives near water.'; };
  ai.wrapUp = async () => WRAP;
  youtube.search = async query => ({ title: `Video: ${query}`, url: `https://www.youtube.com/watch?v=${encodeURIComponent(query)}` });
  wiki.candidates = n => Array.from({ length: n }, (_, i) => ({ name: i ? `Topic ${i}` : 'Frog', title: i ? `Topic ${i}` : 'Frog' }));
  wiki.article = async title => { calls.fetched.push(title); return { ...FROG }; }; // copies, so cached photos don't leak
  wiki.photos = async () => PHOTOS;
}

function thread(id = 't1') {
  const th = { id, sent: [], typing: 0, send: async x => { th.sent.push(x); }, sendTyping: async () => { th.typing++; } };
  return th;
}

// Runs /20questions against a fake channel.
async function startGame() {
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

// The starting hint box: each line in italics, then the quote's author if any.
const box = (...lines) => ({ color: 0x3366cc, description: lines.join('\n') });
const italic = text => text.split('\n').map(line => t('hint_line', { line })).join('\n');
const react = key => `react:${t(`reactions.${key}`)}`; // win and yes share an emoji
const text = th => th.sent.map(m => (typeof m === 'string' ? m : m.content)).join('\n');

// --- Setting up ---

test('/20questions judges a batch of candidates in one call and opens a topic thread', async () => {
  fakes();
  wiki.candidates = () => [{ name: 'Bad', title: 'Bad' }, { name: 'Easy', title: 'Easy' }, { name: 'Frog', title: 'Frog' }];
  ai.screen = async names => { calls.screened.push(names); return names.map(n => ({ suitable: n !== 'Bad', guessable: n !== 'Easy' })); };
  const { i, th, jobs } = await startGame();

  assert.deepEqual(calls.screened, [['Bad', 'Easy', 'Frog']], 'one call for the whole batch');
  assert.deepEqual(calls.fetched, ['Frog'], 'only a candidate that passed is fetched');
  assert.equal(i.replied, t('picking'));
  assert.deepEqual(i.edits, [t('started', { username: 'Dean' })]);
  assert.equal(th.name, t('thread_name', { topic: 'Amphibians' }));

  assert.equal(th.sent.length, 1, 'just the opening message');
  const [opening] = th.sent;
  const ends = Math.floor(jobs[0].data.endsAt / 1000);
  assert.equal(opening.content, t('rules', { questions: 20, ends, intro: t('intro_haiku'), ...t.get('reactions') }));
  assert.ok(opening.content.endsWith(t('intro_haiku') + '\n') || opening.content.endsWith(t('intro_haiku')), 'the rules end with the intro line');
  assert.deepEqual(opening.embeds, [box(italic(POEM))]);
  assert.deepEqual(i.followUps, [], 'no private report any more');
  assert.doesNotMatch(JSON.stringify(th.sent), /Amphibians|Frog/, 'neither the topic nor the answer appears in the thread');

  const { data } = jobs[0];
  assert.deepEqual(data.article, { ...FROG, photos: PHOTOS }, 'the article and its photos are cached in the game');
  assert.deepEqual(data.answers, ['Frog', 'frogs', 'Anura']);
  assert.ok(Math.abs(data.endsAt - Date.now() - 1200000) < 2000);
});

test('if no candidate passes, or its article is unusable, it tries another', async () => {
  fakes();
  let batch = 0;
  wiki.candidates = () => (++batch === 1 ? [{ name: 'Easy', title: 'Easy' }] : [{ name: 'Stub', title: 'Stub' }, { name: 'Frog', title: 'Frog' }]);
  ai.screen = async names => names.map(n => ({ suitable: true, guessable: n !== 'Easy' }));
  wiki.article = async title => { calls.fetched.push(title); return title === 'Stub' ? null : { ...FROG }; };
  const { jobs } = await startGame();
  assert.equal(batch, 2);
  assert.ok(calls.fetched.includes('Frog'));
  assert.equal(jobs[0].data.article.title, 'Frog');
});

test('a starting hint that gives away part of the title is written again', async () => {
  assert.ok(skill.leaksTitle('my last, my farewell, my road', 'Abbey Road'));
  assert.ok(!skill.leaksTitle('Call me Ishmael.', 'Moby-Dick'));
  assert.ok(!skill.leaksTitle('I sailed the sea', 'War of 1812'), 'short words like "war" are ignored');

  fakes();
  const hints = ['my farewell, my road', 'four figures cross the stripes'];
  ai.opening = async () => ({ topic: 'Music', kind: 'haiku', hint: hints.shift(), answers: [] });
  wiki.article = async () => ({ ...FROG, title: 'Abbey Road' });
  const { th } = await startGame();
  assert.deepEqual(th.sent[0].embeds, [box(italic('four figures cross the stripes'))]);
});

test('a quotable topic gets a quote with its author, hidden when the author is the answer', async () => {
  fakes();
  ai.opening = async () => ({ topic: 'Philosophy', kind: 'quote', hint: '"I think, therefore I am."', author: 'René Descartes', authorIsAnswer: false, answers: [] });
  let { th } = await startGame();
  assert.deepEqual(th.sent[0].embeds, [box(italic('"I think, therefore I am."'), t('quote_author', { author: 'René Descartes' }))]);
  assert.ok(th.sent[0].content.includes(t('intro_quote')));

  fakes();
  ai.opening = async () => ({ topic: 'Philosophy', kind: 'quote', hint: '"I think, therefore I am."', author: 'René Descartes', authorIsAnswer: true, answers: [] });
  ({ th } = await startGame());
  assert.ok(th.sent[0].embeds[0].description.includes(t('quote_author', { author: t('author_is_answer') })));
  assert.doesNotMatch(th.sent[0].embeds[0].description, /Descartes/);
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
  ai.screen = async () => { throw new Error('offline'); };
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

test('questions get a verdict from Sonnet, answered with reactions', async () => {
  const g = game({ hints: ['It lives near water.'] });
  fakes({ routes: ['ask', 'ask', 'ask'], results: ['yes', 'no', 'sort_of'] });
  assert.deepEqual(await say(g, 'Is it an animal?'), [react('yes')]);
  assert.deepEqual(await say(g, 'Is it a mammal?'), [react('no')]);
  assert.deepEqual(await say(g, 'Does it live in water?', 'Ana'), [react('sort_of')]);
  assert.equal(g.th.typing, 0, 'no typing indicator for reactions');

  assert.deepEqual(calls.judge[1], {
    question: 'Is it a mammal?',
    log: [{ username: 'Dean', text: 'Is it an animal?', result: 'yes' }],
    hints: ['It lives near water.'],
  }, 'Sonnet sees the earlier questions and the hints');
  assert.equal(g.data.used, 3);
});

test('chat is ignored; hints are free', async () => {
  const g = game({ log: [{ username: 'Dean', text: 'Is it alive?', result: 'yes' }], used: 1 });
  fakes({ routes: ['chat', 'hint'] });
  assert.deepEqual(await say(g, 'lol good one', 'Ana'), []);
  assert.equal(calls.hint, 0);

  assert.deepEqual(await say(g, 'hint please'), [t('hint', { hint: 'It lives near water.' })]);
  assert.equal(calls.hint, 1);
  assert.equal(g.th.typing, 1, 'typing while the hint is written');
  assert.deepEqual(g.data.hints, ['It lives near water.']);
  assert.equal(g.data.used, 1);
});

test('the router knows what just happened, so "I need another" after a hint makes sense', async () => {
  const g = game();
  fakes({ routes: ['ask', 'hint', 'chat', 'hint'], results: ['no'] });
  await say(g, 'Is it big?');
  await say(g, 'hint please', 'Ana');
  await say(g, 'hmm', 'Ana');
  await say(g, 'I need another', 'Ana');
  assert.deepEqual(calls.routed.at(-1), [
    t('prompts.recent.ask', { username: 'Dean', text: 'Is it big?', result: 'no' }),
    t('prompts.recent.hint', { username: 'Ana', text: 'hint please' }),
    t('prompts.recent.chat', { username: 'Ana', text: 'hmm' }),
  ]);
  assert.equal(calls.hint, 2);
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
  assert.deepEqual(g.th.sent.at(-1).components[0].components[0].custom_id, 'TwentyQuestions:again', 'ends with a Play again button');
  assert.equal(g.th.sent.at(-2), [
    t('stats_title'),
    t('stat_most_questions', { username: 'Ana', count: 1 }),
    t('stat_valuable', { username: 'Dean', text: 'Is it an animal?' }),
    t('stat_closest', { username: 'Ana', text: 'Toad' }),
  ].join('\n'), 'stats without a candidate are left out');
});

test('the info card shows up to 5 article photos: a gallery of 4 and a thumbnail', async () => {
  fakes({ routes: ['stop', 'stop'] });
  let g = game({ article: { ...FROG, photos: PHOTOS } });
  await say(g, 'stop');
  let { embeds } = g.th.sent.find(m => m.embeds);
  assert.deepEqual(embeds.map(e => e.image?.url), PHOTOS.slice(0, 4));
  assert.ok(embeds.every(e => e.url === FROG.url), 'the shared URL makes Discord show one gallery');
  assert.deepEqual(embeds[0].thumbnail, { url: PHOTOS[4] });

  g = game({ article: { ...FROG, photos: PHOTOS.slice(0, 2) } });
  await say(g, 'stop');
  ({ embeds } = g.th.sent.find(m => m.embeds));
  assert.deepEqual(embeds.map(e => e.image?.url), PHOTOS.slice(0, 2));
  assert.equal(embeds[0].thumbnail, undefined);
});

test('films and plays get a trailer link in the info card, songs a song link', async () => {
  for (const kind of ['trailer', 'song']) {
    const g = game();
    fakes({ routes: ['stop'] });
    ai.wrapUp = async () => ({ ...WRAP, video: { kind, search: 'Frog official trailer' } });
    await say(g, 'stop');
    const card = g.th.sent.find(m => m.embeds);
    const video = { title: 'Video: Frog official trailer', url: 'https://www.youtube.com/watch?v=Frog%20official%20trailer' };
    assert.equal(card.embeds[0].description, `${WRAP.infocard}\n\n${t(`video.${kind}`, video)}\n[${t('read_more')}](${FROG.url})`);
    assert.ok(t(`video.${kind}`, video).includes(`[${video.title}](${video.url})`), 'the link is named after the video');
    assert.ok(!g.th.sent.includes(t('video.documentary', video)), 'not posted separately');
  }
});

test('a documentary is posted after the stats, before Play again', async () => {
  const g = game();
  fakes({ routes: ['stop'] });
  ai.wrapUp = async () => ({ ...WRAP, video: { kind: 'documentary', search: 'frogs documentary' } });
  await say(g, 'stop');
  const video = { title: 'Video: frogs documentary', url: 'https://www.youtube.com/watch?v=frogs%20documentary' };
  assert.equal(g.th.sent.at(-2), t('video.documentary', video));
  assert.ok(g.th.sent.at(-2).includes(`[${video.title}](${video.url})`), 'the link is named after the video');
  assert.ok(g.th.sent.at(-1).components, 'then the Play again button');
  assert.ok(!g.th.sent.find(m => m.embeds).embeds[0].description.includes(video.url), 'not in the info card');
});

test('no video when there is none, the search finds nothing, or there is no YouTube key', async () => {
  let g = game();
  fakes({ routes: ['stop'] });
  await say(g, 'stop'); // WRAP.video.kind is 'none'
  assert.equal(g.th.sent.find(m => m.embeds).embeds[0].description, `${WRAP.infocard}\n\n[${t('read_more')}](${FROG.url})`);

  g = game();
  fakes({ routes: ['stop'] });
  ai.wrapUp = async () => ({ ...WRAP, video: { kind: 'documentary', search: 'frogs' } });
  youtube.search = async () => null;
  await say(g, 'stop');
  assert.ok(!g.th.sent.some(m => typeof m === 'string' && m.includes('youtube')));

  const key = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  try {
    assert.equal(await realYoutubeSearch('frogs documentary'), null, 'no key, no request');
  } finally {
    if (key !== undefined) process.env.YOUTUBE_API_KEY = key;
  }
});

test('YouTube titles are made safe for a [title](url) link', () => {
  assert.equal(youtube.plainTitle('Rock &amp; Roll [Official Video] &#39;Live&#39;'), "Rock & Roll Official Video 'Live'");
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

test('Play again confirms at once, then quietly starts a new game in the same thread', async () => {
  fakes();
  const th = thread('t1');
  th.parentId = 'c1';
  th.setName = async name => { th.name = name; };
  const jobs = [];
  const i = Object.assign(command(''), { customId: 'TwentyQuestions:again', channel: th, isButton: () => true, isChatInputCommand: () => false });
  const events = [];
  i.update = async content => { events.push('update'); i.updated = content; };
  i.editReply = async content => { i.edited = content; };
  wiki.candidates = n => { events.push('picking'); return [{ name: 'Frog', title: 'Frog' }].slice(0, n); };
  await skill.handle(i, ctx(jobs));

  assert.deepEqual(events, ['update', 'picking'], 'confirmed before the topic is picked');
  assert.deepEqual(i.updated, { content: t('play_again_starting', { username: 'Dean' }), components: [] }, 'and the button is removed');
  assert.equal(i.replied, undefined, 'no other start message');
  assert.equal(th.name, t('thread_name', { topic: 'Amphibians' }));
  assert.deepEqual(th.sent, [{ content: t('intro_haiku'), embeds: [box(italic(POEM))] }], 'just the intro and the hint, no rules');
  assert.deepEqual([jobs[0].data.threadId, jobs[0].data.channelId], ['t1', 'c1']);

  // A second click while that game runs is refused, like the command.
  const again = Object.assign(command(''), { customId: 'TwentyQuestions:again', channel: th, isButton: () => true, isChatInputCommand: () => false });
  await skill.handle(again, ctx(jobs));
  assert.equal(again.replied.content, t('already_running', { link: 'https://discord.com/channels/g1/t1' }));
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

test('candidates are distinct articles of obscurity 2 to 4 from good_articles.json', () => {
  const batch = realCandidates(30);
  assert.equal(batch.length, 30);
  assert.equal(new Set(batch.map(c => c.title)).size, 30);
  assert.ok(batch.every(c => [2, 3, 4].includes(c.obscurity)));
  assert.ok(batch.every(c => c.title && !c.title.includes('_')), 'titles come from the URL, with spaces');
  assert.ok(wiki.pool.length > 1000);
});

test('request logging is coded in but switched off', () => {
  const real = console.log;
  const lines = [];
  console.log = line => lines.push(line);
  try {
    log('Wikipedia', 'query Frog', 'HTTP 200', Date.now());
  } finally {
    console.log = real;
  }
  assert.deepEqual(lines, []);
});

test('sanitize makes AI text plain, keeping letters, emoji and lists', () => {
  assert.equal(ai.sanitize('“It’s” a test…​ ok'), '"It\'s" a test... ok');
  assert.equal(ai.sanitize('1914–1918 — the Great War'), '1914-1918 - the Great War');
  assert.equal(ai.sanitize('Hồ Chí Minh 🐸'), 'Hồ Chí Minh 🐸');
  assert.deepEqual(ai.sanitizeAll({ poem: 'It’s me…', answers: ['frog', '“toad”'], ok: true }), { poem: "It's me...", answers: ['frog', '"toad"'], ok: true });
});
