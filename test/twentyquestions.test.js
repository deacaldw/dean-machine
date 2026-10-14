const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ctx, command } = require('./fakes');

const dir = path.join(__dirname, '..', 'Skills', 'TwentyQuestions');
const skill = require(path.join(dir, 'skill.js'));
const ai = require(path.join(dir, 'ai.js'));
const wiki = require(path.join(dir, 'wiki.js'));
const { tags: realTags, tagged: realTagged } = wiki; // the other tests replace them with fakes
const { log } = require(path.join(dir, 'log.js'));
const youtube = require(path.join(dir, 'youtube.js'));
const realYoutubeSearch = youtube.search; // the other tests replace it with a fake
// The skill's own strings, so rewording strings.yaml doesn't break the tests.
const t = require(path.join(__dirname, '..', 'src', 'strings.js'))(dir);
// "The category is X. Here's a haiku/quote..."
const intro = (category, kind, again = false) => t('intro', { category: t(again ? 'category_next' : 'category_first', { category }), hint: t(kind) });

const FROG = { title: 'Frog', url: 'https://en.wikipedia.org/wiki/Frog', image: 'https://img/frog.jpg', text: 'Frogs are amphibians...' };
const PHOTOS = [1, 2, 3, 4, 5].map(n => `https://upload.wikimedia.org/frog${n}.jpg`);
const POEM = 'Green skin, quiet pond,\nI leap on a lily pad,\nsinging after rain.';
const TOPICS = ['Frog', 'Rock', 'Newt']; // every tag finds these
const WRAP = {
  infocard: 'Frogs are amphibians.\n## Fun fact\nSome frogs can freeze solid.',
  most_valuable_question: { username: 'Dean', text: 'Is it an animal?' },
  closest_guess: { username: 'Ana', text: 'Toad' },
  farthest_guess: { username: '', text: '' },
  related_guess: { username: '', text: '' },
  video: { kind: 'none', search: '' },
};
const CLOSE_MS = 10 * 60 * 1000;

// Fake Claude and Wikipedia. route() and judge() answer from queues. Sonnet's shortlist is `shortlist` (names from
// TOPICS), `misfits` fail the category check, and `stubs` have no usable article.
let calls;
function fakes({ routes = [], results = [], tags = ['Animals'], shortlist = ['Frog'], misfits = [], stubs = [] } = {}) {
  calls = { judge: [], hint: 0, fetched: [], routed: [], categories: [], shortlists: [], fits: [] };
  wiki.tags = () => [...t.get('categories'), 'Animals'].sort();
  wiki.tagged = wanted => (wanted.length ? TOPICS.map(name => ({ name, title: name })) : []);
  ai.categories = async (category, all) => { calls.categories.push([category, all]); return tags; };
  ai.shortlist = async (category, names) => { calls.shortlists.push([category, [...names].sort()]); return shortlist.map(name => names.indexOf(name)); };
  ai.fits = async (category, article) => { calls.fits.push([category, article.title]); return !misfits.includes(article.title); };
  ai.opening = async () => ({ kind: 'haiku', hint: POEM, answers: ['frogs', 'Anura'] });
  ai.route = async (message, recent) => { calls.routed.push([...(recent ?? [])]); return routes.shift(); };
  ai.judge = async (game, question) => { calls.judge.push({ question, log: [...game.log], hints: [...game.hints] }); return results.shift(); };
  ai.hint = async () => { calls.hint++; return 'It lives near water.'; };
  ai.wrapUp = async () => WRAP;
  youtube.search = async query => ({ title: `Video: ${query}`, url: `https://www.youtube.com/watch?v=${encodeURIComponent(query)}` });
  wiki.article = async title => { calls.fetched.push(title); return stubs.includes(title) ? null : { ...FROG, title }; }; // copies, so cached photos don't leak
  wiki.photos = async () => PHOTOS;
}

function thread(id = 't1') {
  const th = { id, parentId: 'c1', sent: [], typing: 0, votes: {}, sendTyping: async () => { th.typing++; } };
  th.setArchived = async archived => { th.archived = archived; };
  th.send = async x => {
    th.sent.push(x);
    if (!x?.poll) return;
    // A poll whose answers have th.votes[text] voters each.
    const answers = new Map(x.poll.answers.map((a, i) => [i + 1, { voters: { fetch: async () => ({ size: th.votes[a.text] ?? 0 }) } }]));
    return { poll: { answers, end: async () => { th.pollEnded = true; } } };
  };
  return th;
}

// Runs /20questions (with these options) against a fake channel.
async function startGame(options = {}, jobs = []) {
  const th = thread('t9');
  const i = command('20questions', options);
  i.channel = { isThread: () => false };
  i.edits = [];
  i.editReply = async content => { i.edits.push(content); return { startThread: async opts => { th.name = opts.name; return th; } }; };
  await skill.handle(i, ctx(jobs));
  return { i, th, jobs };
}

// A Play again click in a thread, with recorders for its replies.
function playAgainClick(th) {
  const i = Object.assign(command(''), { customId: 'TwentyQuestions:again', channelId: th.id, channel: th, isButton: () => true, isChatInputCommand: () => false });
  i.update = async content => { i.updated = content; };
  i.editReply = async content => { i.edited = content; };
  return i;
}

// A game in progress in thread t1, and a way for players to post in it.
function game(extra) {
  const th = thread();
  const data = { guildId: 'g1', channelId: 'c1', threadId: 't1', category: 'Animals', shortlist: ['Newt'], article: FROG, answers: ['Frog', 'frogs'], endsAt: Date.now() + 1200000, warned: [], used: 0, log: [], recent: [], hints: [], over: false, closesAt: null, ...extra };
  const jobs = [{ id: 'j0', data }];
  return { th, data, jobs, ctx: ctx(jobs) };
}

async function say(g, content, username = 'Dean') {
  const out = [];
  const message = {
    guildId: 'g1', channelId: g.data?.threadId ?? 't1', content, author: { username, bot: false }, member: { displayName: username }, channel: g.th,
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
const quiet = async fn => { const error = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = error; } };

// --- Setting up ---

test('/20questions with a category finds tags, then a shortlist, and opens a thread named after the category', async () => {
  fakes({ shortlist: ['Frog', 'Newt'] });
  const { i, th, jobs } = await startGame({ category: 'amphibians' });

  assert.deepEqual(calls.categories, [['amphibians', wiki.tags()]], 'Sonnet picks from all tags');
  assert.deepEqual(calls.shortlists, [['amphibians', ['Frog', 'Newt', 'Rock']]], 'then sorts the tagged topics');
  assert.equal(i.replied, t('picking', { category: 'amphibians' }));
  assert.deepEqual(i.edits, [t('started', { username: 'Dean', category: 'amphibians' })]);
  assert.equal(th.name, t('thread_name', { category: 'amphibians' }));

  assert.equal(th.sent.length, 1, 'just the opening message');
  const [opening] = th.sent;
  const { data } = jobs[0];
  assert.equal(opening.content, t('rules', { questions: 20, ends: Math.floor(data.endsAt / 1000), intro: intro('amphibians', 'intro_haiku'), ...t.get('reactions') }));
  assert.deepEqual(opening.embeds, [box(italic(POEM))]);
  assert.doesNotMatch(JSON.stringify(th.sent), /Frog|Newt/, 'the answer never appears in the thread');

  assert.equal(jobs.length, 1, 'one job for the thread');
  assert.equal(data.threadId, 't9');
  assert.equal(data.category, 'amphibians');
  assert.deepEqual([...data.shortlist, data.article.title].sort(), ['Frog', 'Newt'], 'the played topic is taken off the list');
  assert.deepEqual(data.article.photos, PHOTOS, 'the article and its photos are cached in the game');
  assert.deepEqual(data.answers, [data.article.title, 'frogs', 'Anura']);
  assert.ok(Math.abs(data.endsAt - Date.now() - 1200000) < 2000);
  assert.equal(data.over, false);
});

test('without a category, a random one from strings.yaml is used as a tag, without asking Sonnet for tags', async ctxt => {
  fakes();
  ctxt.mock.method(Math, 'random', () => 0);
  const [first] = t.get('categories');
  const { th, jobs } = await startGame();
  assert.deepEqual(calls.categories, []);
  assert.equal(calls.shortlists[0][0], first);
  assert.equal(th.name, t('thread_name', { category: first }));
  assert.equal(jobs[0].data.category, first);
  assert.ok(t.get('categories').every(category => realTags().includes(category)), 'every random category is a tag in good_articles.json');
});

test('each topic drawn is checked against the category; misfits and stubs are skipped and never kept', async ctxt => {
  fakes({ shortlist: ['Rock', 'Newt', 'Frog'], stubs: ['Rock'], misfits: ['Newt'] });
  ctxt.mock.method(Math, 'random', () => 0); // always draw the first one left
  const { jobs } = await startGame({ category: 'amphibians' });
  assert.deepEqual(calls.fetched, ['Rock', 'Newt', 'Frog']);
  assert.deepEqual(calls.fits, [['amphibians', 'Newt'], ['amphibians', 'Frog']], 'every usable topic is checked');
  assert.equal(jobs[0].data.article.title, 'Frog');
  assert.deepEqual(jobs[0].data.shortlist, []);
});

test('a category with nothing that fits says so', async () => {
  for (const options of [{ tags: [] }, { shortlist: [] }]) {
    fakes(options);
    const { i, jobs } = await startGame({ category: 'quarks' });
    assert.equal(i.edits.at(-1), t('category_none', { category: 'quarks' }));
    assert.deepEqual(jobs, []);
  }
});

test('a haiku written on one line with " / " is split into lines', async () => {
  fakes();
  ai.opening = async () => ({ kind: 'haiku', hint: 'Fragrant blossoms / I swell from berries / I fill your glass', answers: [] });
  const { th } = await startGame({ category: 'amphibians' });
  assert.deepEqual(th.sent[0].embeds, [box(italic('Fragrant blossoms\nI swell from berries\nI fill your glass'))]);
});

test('a starting hint that gives away part of the title is written again', async () => {
  assert.ok(skill.leaksTitle('my last, my farewell, my road', 'Abbey Road'));
  assert.ok(!skill.leaksTitle('Call me Ishmael.', 'Moby-Dick'));
  assert.ok(!skill.leaksTitle('I sailed the sea', 'War of 1812'), 'short words like "war" are ignored');

  fakes();
  const hints = ['my farewell, my road', 'four figures cross the stripes'];
  ai.opening = async () => ({ kind: 'haiku', hint: hints.shift(), answers: [] });
  wiki.article = async () => ({ ...FROG, title: 'Abbey Road' });
  const { th } = await startGame({ category: 'amphibians' });
  assert.deepEqual(th.sent[0].embeds, [box(italic('four figures cross the stripes'))]);
});

test('a quotable topic gets a quote with its author, hidden when the author is the answer', async () => {
  fakes();
  ai.opening = async () => ({ kind: 'quote', hint: '"I think, therefore I am."', author: 'René Descartes', authorIsAnswer: false, answers: [] });
  let { th } = await startGame({ category: 'amphibians' });
  assert.deepEqual(th.sent[0].embeds, [box(italic('"I think, therefore I am."'), t('quote_author', { author: 'René Descartes' }))]);
  assert.ok(th.sent[0].content.includes(intro('amphibians', 'intro_quote')));

  fakes();
  ai.opening = async () => ({ kind: 'quote', hint: '"I think, therefore I am."', author: 'René Descartes', authorIsAnswer: true, answers: [] });
  ({ th } = await startGame({ category: 'amphibians' }));
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

  const ended = game({ over: true, closesAt: Date.now() + CLOSE_MS }); // an ended game's thread doesn't block a new one
  fakes();
  const { i: started } = await startGame({ category: 'amphibians' }, ended.jobs);
  assert.equal(ended.jobs.length, 2, started.replied);

  fakes();
  ai.shortlist = async () => { throw new Error('offline'); };
  const { i: failed, jobs } = await quiet(() => startGame({ category: 'amphibians' }));
  assert.equal(failed.edits.at(-1), t('start_failed'));
  assert.equal(jobs.length, 0);
});

// --- Play again ---

test('Play again picks another topic from the same list, in the same thread, without asking Sonnet again', async () => {
  fakes({ shortlist: ['Frog', 'Newt'] });
  const { th, jobs } = await startGame({ category: 'amphibians' });
  const { data } = jobs[0];
  const first = data.article.title;
  Object.assign(data, { over: true, closesAt: Date.now() + CLOSE_MS }); // the first game is over

  const i = playAgainClick(th);
  const events = [];
  i.update = async content => { events.push('update'); i.updated = content; };
  const article = wiki.article;
  wiki.article = async title => { events.push('picking'); return article(title); };
  await skill.handle(i, ctx(jobs));

  assert.deepEqual(events, ['update', 'picking'], 'confirmed before the topic is picked');
  assert.deepEqual(i.updated, { content: t('play_again_starting', { username: 'Dean' }), components: [] }, 'and the button is removed');
  assert.equal(calls.categories.length, 1, 'no new tag call');
  assert.equal(calls.shortlists.length, 1, 'no new shortlist call');
  assert.equal(jobs.length, 1, 'still one job for the thread');
  assert.notEqual(data.article.title, first, 'another topic from the list');
  assert.deepEqual(data.shortlist, []);
  assert.equal(data.over, false);
  assert.equal(data.closesAt, null, 'the thread stays open');
  assert.equal(data.used, 0, 'a fresh round');
  assert.deepEqual(th.sent.at(-1), { content: intro('amphibians', 'intro_haiku', true), embeds: [box(italic(POEM))] }, 'just the intro and the hint, no rules');

  // A second click while that game runs is refused, like the command.
  const again = playAgainClick(th);
  await skill.handle(again, ctx(jobs));
  assert.equal(again.replied.content, t('already_running', { link: 'https://discord.com/channels/g1/t9' }));

  // Used up: say so, without a button. The thread still closes later.
  data.over = true;
  const usedUp = playAgainClick(th);
  await skill.handle(usedUp, ctx(jobs));
  assert.equal(usedUp.edited, t('category_used_up', { category: 'amphibians' }));
  assert.ok(data.closesAt > Date.now());
});

test('Play again in a thread that was closed says the game is over', async () => {
  fakes();
  const i = playAgainClick(thread('t1'));
  await skill.handle(i, ctx([]));
  assert.equal(i.replied.content, t('thread_closed'));
});

test('starting gives up after 40 seconds, and Play again offers its button again', async ctxt => {
  ctxt.mock.timers.enable({ apis: ['setTimeout'] });
  const g = game({ over: true, closesAt: Date.now() + CLOSE_MS });
  fakes();
  ai.fits = () => new Promise(() => {}); // never answers
  const i = playAgainClick(g.th);
  await quiet(async () => {
    const started = skill.handle(i, g.ctx);
    await new Promise(r => setImmediate(r));
    assert.equal(g.data.closesAt, null, 'the thread stays open while the game is set up');
    ctxt.mock.timers.tick(40 * 1000);
    await started;
  });
  assert.equal(i.edited.content, t('start_failed'));
  assert.equal(i.edited.components[0].components[0].custom_id, 'TwentyQuestions:again');
  assert.ok(g.data.closesAt > Date.now(), 'and closes later unless it is pressed');
});

test('a Play again being set up can be stopped by saying so', async () => {
  const g = game({ over: true, closesAt: Date.now() + CLOSE_MS });
  fakes({ routes: ['stop'] });
  let checking;
  ai.fits = () => new Promise(resolve => { checking = () => resolve(true); });
  const i = playAgainClick(g.th);
  const started = skill.handle(i, g.ctx);
  for (let k = 0; k < 5; k++) await new Promise(r => setImmediate(r));
  await say(g, 'stop the game', 'Ana');
  checking();
  await started;
  assert.equal(i.edited.content, t('start_cancelled'));
  assert.equal(g.data.over, true);
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
  assert.equal(g.data.over, true);

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
  assert.equal(g.data.over, false);

  await say(g, 'Is it a newt?');
  assert.ok(text(g.th).includes(t('lose')));
  assert.equal(g.data.over, true);
});

test('if answering fails, the player is asked to try again', async () => {
  const g = game();
  fakes({ routes: ['ask'] });
  ai.judge = async () => { throw new Error('Request timed out.'); };
  const error = console.error;
  console.error = () => {};
  const out = await say(g, 'Is it big?').finally(() => { console.error = error; });
  assert.deepEqual(out, [t('answer_failed')]);
  assert.equal(g.data.used, 0, 'a failed question is not counted');
});

// Asks for options, lets the 10-second poll run out, and returns the poll message.
async function optionsPoll(ctxt, g, votes, during = async () => {}) {
  ctxt.mock.timers.enable({ apis: ['setTimeout'] });
  ai.options = async () => ({ answer: 'Frog', decoys: ['Toad', 'Newt', 'Salamander'] });
  g.th.votes = votes;
  const asked = say(g, 'Give us some options');
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  await during();
  ctxt.mock.timers.tick(10 * 1000);
  await asked;
  return g.th.sent.find(m => m?.poll);
}

test('asking for options shows a 10-second poll; the most votes for the right one wins', async ctxt => {
  const g = game();
  fakes({ routes: ['options'] });
  const started = Date.now();
  const poll = await optionsPoll(ctxt, g, { Frog: 2, Toad: 1 });

  assert.equal(poll.poll.question.text, t('options_question'));
  assert.deepEqual(poll.poll.answers.map(a => a.text).sort(), ['Frog', 'Newt', 'Salamander', 'Toad']);
  const closes = g.th.sent[g.th.sent.indexOf(poll) - 1];
  assert.match(closes, /<t:(\d+):R>/, 'a message says when the poll closes');
  assert.ok(Math.abs(Number(closes.match(/<t:(\d+):R>/)[1]) - (started / 1000 + 10)) <= 2);
  assert.ok(g.th.pollEnded, 'the poll is closed');
  assert.ok(text(g.th).includes(t('options_win', { picked: 'Frog' })));
  assert.ok(text(g.th).includes(t('reveal', { title: 'Frog' })), 'then the end flow continues');
  assert.equal(g.data.over, true);
});

test('a wrong pick, a tie or no votes loses', async ctxt => {
  for (const [votes, line] of [
    [{ Toad: 3, Frog: 1 }, t('options_lose', { picked: 'Toad' })],
    [{ Frog: 1, Toad: 1 }, 'or'],
    [{}, t('options_no_votes')],
  ]) {
    const g = game();
    fakes({ routes: ['options'] });
    await optionsPoll(ctxt, g, votes);
    ctxt.mock.timers.reset();
    if (line === 'or') assert.match(text(g.th), /picked \*\*(Frog or Toad|Toad or Frog)\*\*/);
    else assert.ok(text(g.th).includes(line), line);
    assert.equal(g.data.over, true);
  }
});

test('while the poll runs, questions are ignored but stopping works', async ctxt => {
  const g = game();
  fakes({ routes: ['options', 'ask', 'stop'], results: ['yes'] });
  await optionsPoll(ctxt, g, { Frog: 5 }, async () => {
    assert.deepEqual(await say(g, 'Is it green?'), [], 'no verdict while the poll runs');
    assert.equal(calls.judge.length, 0);
    await say(g, 'stop the game');
  });
  assert.ok(text(g.th).includes(t('stopped')));
  assert.ok(!text(g.th).includes(t('options_win', { picked: 'Frog' })), 'the poll no longer decides anything');
  assert.ok(g.th.pollEnded, 'the poll is closed quietly');
});

test('anyone can stop the game by asking', async () => {
  const g = game();
  fakes({ routes: ['stop'] });
  await say(g, 'ok stop the game', 'Ana');
  assert.ok(text(g.th).includes(t('stopped')));
  assert.ok(text(g.th).includes(t('reveal', { title: 'Frog' })));
  assert.equal(g.data.over, true);
});

test('messages in a thread whose game is over are ignored', async () => {
  const g = game({ over: true, closesAt: Date.now() + CLOSE_MS });
  fakes({ routes: ['ask'], results: ['yes'] });
  assert.deepEqual(await say(g, 'Is it green?'), []);
  assert.equal(calls.judge.length, 0);
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

test('run ends the game on timeout, keeping the thread for Play again', async () => {
  fakes();
  const g = game({ threadId: 'late', endsAt: Date.now() - 1 });
  assert.equal(await skill.run(g.data, { channels: { fetch: async () => g.th } }), false);
  assert.ok(text(g.th).includes(t('timeout')));
  assert.equal(g.data.over, true);
});

test('a game ends with Play again, and the thread closes 10 minutes later unless it is pressed', async () => {
  const g = game();
  fakes({ routes: ['stop'] });
  await say(g, 'stop the game');
  assert.ok(Math.abs(g.data.closesAt - Date.now() - CLOSE_MS) < 2000);
  assert.equal(g.th.sent.at(-1).content, t('play_again_prompt', { closes: Math.floor(g.data.closesAt / 1000) }), 'the button says when the thread closes');

  const client = { channels: { fetch: async () => g.th } };
  g.data.threadId = 'closing';
  assert.equal(await skill.run(g.data, client), false, 'not yet');
  assert.equal(g.th.archived, undefined);
  g.data.closesAt = Date.now() - 1;
  assert.equal(await skill.run(g.data, client), true, 'then its memory is deleted');
  assert.equal(g.th.archived, true, 'and the thread closed');
});

test('memory is deleted once the thread is closed by someone else or gone', async () => {
  fakes();
  let g = game({ threadId: 'archived' });
  g.th.archived = true;
  g.th.setArchived = async () => { throw new Error('should not be called'); };
  assert.equal(await skill.run(g.data, { channels: { fetch: async () => g.th } }), true);

  g = game({ threadId: 'gone' });
  const gone = { channels: { fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { status: 404 }); } } };
  assert.equal(await skill.run(g.data, gone), true);
  assert.equal(g.th.sent.length, 0);
});

test('a thread whose Play again was cut short still closes', async () => {
  fakes();
  const g = game({ threadId: 'restarted', over: true, closesAt: null });
  await skill.run(g.data, { channels: { fetch: async () => g.th } });
  assert.ok(g.data.closesAt > Date.now());
});

// --- Helpers ---

test('every topic in the pool has tags, and topics of obscurity 2 to 4 can be found by tag', () => {
  assert.ok(wiki.pool.length > 1000);
  assert.ok(wiki.pool.every(a => [2, 3, 4].includes(a.obscurity)));
  assert.ok(wiki.pool.every(a => a.tags?.length));
  const tags = realTags();
  assert.ok(tags.includes('Films') && tags.includes('Animals'));
  const films = realTagged(['Films']);
  assert.ok(films.length > 100);
  assert.ok(films.every(c => c.name && c.title && wiki.pool.find(a => a.name === c.name).tags.includes('Films')));
  assert.ok(films.every(c => !c.title.includes('_')), 'titles come from the URL, with spaces');
});

test('request logging prints one line per request', () => {
  const real = console.log;
  const lines = [];
  console.log = line => lines.push(line);
  try {
    log('Wikipedia', 'query Frog', 'HTTP 200', Date.now());
  } finally {
    console.log = real;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[20Q\] Wikipedia query Frog → HTTP 200 \(\d+ ms\)$/);
});

test('sanitize makes AI text plain, keeping letters, emoji and lists', () => {
  assert.equal(ai.sanitize('“It’s” a test…​ ok'), '"It\'s" a test... ok');
  assert.equal(ai.sanitize('1914–1918 — the Great War'), '1914-1918 - the Great War');
  assert.equal(ai.sanitize('Hồ Chí Minh 🐸'), 'Hồ Chí Minh 🐸');
  assert.deepEqual(ai.sanitizeAll({ poem: 'It’s me…', answers: ['frog', '“toad”'], ok: true }), { poem: "It's me...", answers: ['frog', '"toad"'], ok: true });
});
