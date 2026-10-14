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
// "Here are three fun facts...", or for Play again "Here's another one from X!..."
const intro = (category, again = false) => (again ? t('intro_again', { category }) : t('intro'));

const FROG = { title: 'Frog', url: 'https://en.wikipedia.org/wiki/Frog', image: 'https://img/frog.jpg', text: 'Frogs are amphibians...' };
const PHOTOS = [1, 2, 3, 4, 5].map(n => `https://upload.wikimedia.org/frog${n}.jpg`);
const FACTS = ['It has smooth, moist skin.', 'It starts life in water.', 'Some kinds can freeze solid in winter.'];
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
  calls = { judge: [], scenic: [], recaps: 0, hint: 0, fetched: [], routed: [], categories: [], shortlists: [], fits: [] };
  wiki.tags = () => [...t.get('categories'), 'Animals'].sort();
  wiki.tagged = wanted => (wanted.length ? TOPICS.map(name => ({ name, title: name })) : []);
  ai.categories = async (category, all) => { calls.categories.push([category, all]); return tags; };
  ai.shortlist = async (category, names) => { calls.shortlists.push([category, [...names].sort()]); return shortlist.map(name => names.indexOf(name)); };
  ai.fits = async (category, article) => { calls.fits.push([category, article.title]); return !misfits.includes(article.title); };
  ai.opening = async () => ({ facts: FACTS, answers: ['frogs', 'Anura'] });
  ai.route = async (message, recent) => { calls.routed.push([...(recent ?? [])]); return routes.shift(); };
  // A result is a verdict ('yes'), or the whole JSON answer with awards ({ result: 'no', hot_stuff: true }).
  ai.judge = async (game, question, scenic) => {
    calls.judge.push({ question, log: game.log.map(({ at, userId, ...e }) => e), hints: [...game.hints] });
    calls.scenic.push(scenic);
    const r = results.shift();
    return { hot_stuff: false, breakthrough: false, ...(typeof r === 'string' ? { result: r } : r) };
  };
  ai.hint = async () => { calls.hint++; return 'It lives near water.'; };
  ai.recap = async () => { calls.recaps++; return { recap: "It's alive and lives near water.", questions: ['Is it green?', 'Can it fly?', 'Is it a mammal?'] }; };
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
    // A poll whose answers have th.votes[text] voters: a number of them, or their names.
    const voters = text => {
      const votes = th.votes[text] ?? 0;
      const names = typeof votes === 'number' ? Array.from({ length: votes }, (_, k) => `${text}-voter-${k}`) : votes;
      return new Map(names.map(name => [name, { id: name, username: name }]));
    };
    const answers = new Map(x.poll.answers.map((a, i) => [i + 1, { voters: { fetch: async () => voters(a.text) } }]));
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

// Players who have played before, so their first question here doesn't earn Welcome Aboard.
const VETERANS = ['Ana', 'Ben', 'Cat', 'Dan', 'Dean', 'Eve', 'Fay', 'Gus', 'Zed'];
const veteran = name => ({ name, awards: ['welcome_aboard'], questions: 1, wins: 0, games: 0, categories: [] });
const veterans = (names = VETERANS) => Object.fromEntries(names.map(name => [name, veteran(name)]));

// A game in progress in thread t1, and a way for players to post in it.
function game(extra) {
  const th = thread();
  const data = { guildId: 'g1', channelId: 'c1', threadId: 't1', category: 'Animals', shortlist: ['Newt'], article: FROG, answers: ['Frog', 'frogs'], startedAt: Date.now() - 60000, lastAt: null, players: {}, earned: {}, endsAt: Date.now() + 1200000, warned: [], used: 0, log: [], recent: [], hints: [], over: false, closesAt: null, ...extra };
  const jobs = [{ id: 'j0', data }];
  const storage = { players: veterans() };
  return { th, data, jobs, storage, ctx: ctx(jobs, storage) };
}

async function say(g, content, username = 'Dean', at = Date.now()) {
  const out = [];
  const message = {
    guildId: 'g1', channelId: g.data?.threadId ?? 't1', content, createdTimestamp: at, author: { id: username, username, bot: false }, member: { displayName: username }, channel: g.th,
    reply: async x => {
      out.push(x.content);
      g.replies = [...(g.replies ?? []), x];
    },
    react: async emoji => out.push(`react:${emoji}`),
  };
  await skill.message(message, g.ctx);
  return out;
}

// A box with the awards a player earned.
// The last argument may be how many the player has collected with these (if not just these and Welcome Aboard, as
// veterans have), or { count, others: 'Ana has...' }.
const TOTAL = Object.keys(t.get('awards')).length;
const award = (username, ...keys) => {
  const last = typeof keys.at(-1) === 'string' ? {} : keys.pop();
  const { count = keys.length + 1, others = t('award_first') } = typeof last === 'number' ? { count: last } : last;
  const parts = keys.map((key, i) => t('award', { username, ...t.get(`awards.${key}`), count: count - keys.length + i + 1, total: TOTAL, others }));
  return { color: 0xf1c40f, description: parts.join('\n\n') };
};

// The box with the fun facts.
const factsBox = facts => ({ color: 0x3366cc, description: facts.map(fact => t('fact', { fact })).join('\n') });
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
  assert.equal(opening.content, t('rules', { category: 'amphibians', questions: 20, ends: Math.floor(data.endsAt / 1000), intro: intro('amphibians') }));
  assert.deepEqual(opening.embeds, [factsBox(FACTS)], 'three fun facts as the starting hint');
  assert.doesNotMatch(JSON.stringify(th.sent), /Frog|Newt/, 'the answer never appears in the thread');

  assert.equal(jobs.length, 1, 'one job for the thread');
  assert.equal(data.threadId, 't9');
  assert.equal(data.category, 'amphibians');
  assert.deepEqual([...data.shortlist, data.article.title].sort(), ['Frog', 'Newt'], 'the played topic is taken off the list');
  assert.deepEqual(data.article.photos, PHOTOS, 'the article and its photos are cached in the game');
  assert.deepEqual(data.answers, [data.article.title, 'frogs', 'Anura']);
  assert.deepEqual(data.hints, FACTS, 'the facts count as hints, so later hints do not repeat them');
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

test('fun facts that give away part of the title are written again', async () => {
  assert.ok(skill.leaksTitle('my last, my farewell, my road', 'Abbey Road'));
  assert.ok(!skill.leaksTitle('Call me Ishmael.', 'Moby-Dick'));
  assert.ok(!skill.leaksTitle('I sailed the sea', 'War of 1812'), 'short words like "war" are ignored');

  fakes();
  const facts = [['It was recorded on a famous road.', 'It came out in 1969.', 'Its cover shows a zebra crossing.'], ['It came out in 1969.', 'Its cover shows four people crossing a street.', 'It was the last album its band recorded.']];
  ai.opening = async () => ({ facts: facts.shift(), answers: [] });
  wiki.article = async () => ({ ...FROG, title: 'Abbey Road' });
  const { th } = await startGame({ category: 'amphibians' });
  assert.deepEqual(th.sent[0].embeds, [factsBox(['It came out in 1969.', 'Its cover shows four people crossing a street.', 'It was the last album its band recorded.'])]);
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
  assert.deepEqual(th.sent.at(-1), { content: intro('amphibians', true), embeds: [factsBox(FACTS)] }, 'just the intro and the facts, no rules');

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

test('questions get a verdict from Sonnet, answered with a short reply after a typing indicator', async () => {
  const g = game({ hints: ['It lives near water.'] });
  fakes({ routes: ['ask', 'ask', 'ask'], results: ['yes', 'no', 'sort_of'] });
  assert.deepEqual(await say(g, 'Is it an animal?'), [t('answers.yes')]);
  assert.deepEqual(await say(g, 'Is it a mammal?'), [t('answers.no')]);
  assert.deepEqual(await say(g, 'Does it live in water?', 'Ana'), [t('answers.sort_of')]);
  assert.equal(g.th.typing, 3, 'typing shows at once for every message');

  assert.deepEqual(calls.judge[1], {
    question: 'Is it a mammal?',
    log: [{ username: 'Dean', text: 'Is it an animal?', result: 'yes' }],
    hints: ['It lives near water.'],
  }, 'Sonnet sees the earlier questions and the hints');
  assert.equal(g.data.used, 3);
});

test('chat is ignored without a typing indicator; hints use up a question', async () => {
  const g = game({ log: [{ username: 'Dean', text: 'Is it alive?', result: 'yes' }], used: 1 });
  fakes({ routes: ['chat', 'hint'] });
  assert.deepEqual(await say(g, 'lol good one', 'Ana'), []);
  assert.equal(calls.hint, 0);

  assert.deepEqual(await say(g, 'hint please'), [t('hint', { hint: 'It lives near water.' })]);
  assert.equal(calls.hint, 1);
  assert.equal(g.th.typing, 1, 'typing for the hint only');
  assert.deepEqual(g.data.hints, ['It lives near water.']);
  assert.equal(g.data.used, 2);
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

test('a win ends the game with the winner\'s awards and the info card', async () => {
  const g = game({ log: [{ username: 'Ana', text: 'Toad?', result: 'no' }], used: 1 });
  fakes({ routes: ['ask'], results: ['win'] });
  assert.deepEqual(await say(g, 'is it a frog'), [], 'the win message is the answer');
  assert.equal(g.data.over, true);

  const out = text(g.th);
  const order = [t('win', { username: 'Dean', used: 2, max: 20 }), t('card_loading_won'), t('reveal', { title: 'Frog' })].map(x => out.indexOf(x));
  assert.ok(order.every((at, k) => at >= 0 && (k === 0 || at > order[k - 1])), 'result, loading line, then the answer');
  assert.equal(g.th.typing, 2, 'typing for the guess, then while the info card is written');

  assert.deepEqual(g.th.sent[0].embeds, [award('Dean', 'winner', 'sharpshooter', 'no_help_needed', 'first_try')], 'a quick win, with no hints, with his first question');
  const card = g.th.sent.find(m => m.content === t('reveal', { title: 'Frog' }));
  assert.equal(card.embeds[0].description, `${WRAP.infocard}\n\n[${t('read_more')}](${FROG.url})`);
  assert.deepEqual(card.embeds[0].image, { url: FROG.image });
  assert.deepEqual(g.th.sent.at(-1).components[0].components[0].custom_id, 'TwentyQuestions:again', 'ends with a Play again button');
  assert.ok(!g.th.sent.some(m => typeof m === 'string' && m.includes('**Game stats**')), 'no stats any more');
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

test('a question that cannot be answered yes or no gets told so, and does not use up a question', async () => {
  const g = game();
  fakes({ routes: ['ask'], results: ['not_yes_no'] });
  assert.deepEqual(await say(g, 'What colour is it?'), [t('not_yes_no')]);
  assert.equal(g.data.used, 0);
  assert.deepEqual(g.data.log, []);
});

test('hints say how many questions are left, and the last one starts the final poll', async () => {
  const g = game({ used: 4 });
  fakes({ routes: ['hint'] });
  assert.deepEqual(await say(g, 'hint please'), [`${t('hint', { hint: 'It lives near water.' })} ${t('questions_left', { left: 15 })}`]);
});

// An earlier question by someone else, so the next one isn't the round's first (Ice Breaker).
const warm = extra => game({ log: [{ username: 'Zed', text: 'Is it big?', result: 'sort_of', at: 0 }], used: 1, ...extra });

test('awards from the log come with the answer: Ice Breaker, Trailblazer, Take a Hint, Comeback Kid', async () => {
  let g = game();
  fakes({ routes: Array(5).fill('ask'), results: ['yes', 'yes', 'yes', 'yes', 'yes'] });
  for (let i = 0; i < 4; i++) await say(g, 'Is it alive?', 'Ana');
  assert.deepEqual(g.replies.map(r => r.embeds), [[award('Ana', 'ice_breaker')], [], [], [award('Ana', 'trailblazer', 3)]], 'the first question, then four yeses in a row');
  await say(g, 'Is it green?', 'Ana');
  assert.deepEqual(g.replies.at(-1).embeds, [], 'only the first time');

  g = warm();
  fakes({ routes: Array(5).fill('ask'), results: Array(5).fill('no') });
  for (let i = 0; i < 4; i++) await say(g, 'Is it red?', i === 2 ? 'Ben' : 'Ana');
  assert.deepEqual(g.replies.map(r => r.embeds), [[], [], [], []], 'another player in between: only three of Ana\'s in a row');
  await say(g, 'Is it blue?', 'Ana');
  assert.deepEqual(g.replies.at(-1).embeds, [award('Ana', 'take_a_hint')], 'four noes in a row');

  g = warm();
  fakes({ routes: Array(3).fill('ask'), results: ['no', 'no', 'yes'] });
  await say(g, 'Is it red?', 'Ana');
  await say(g, 'Is it blue?', 'Ben');
  await say(g, 'Is it alive?', 'Cat');
  assert.deepEqual(g.replies.at(-1).embeds, [award('Cat', 'comeback_kid')], 'a yes after the team got two noes in a row');
});

test('Team Player needs the latest yes to be someone else\'s', async () => {
  const g = warm();
  fakes({ routes: ['ask', 'ask', 'ask'], results: [{ result: 'yes' }, { result: 'yes', team_player: true }, { result: 'yes', team_player: true }] });
  await say(g, 'Is it alive?', 'Ana');
  await say(g, 'Is it an animal?', 'Ana');
  assert.ok(!JSON.stringify(g.replies[1].embeds).includes(t('awards.team_player.name')), 'building on her own yes');
  await say(g, 'Does it live in water?', 'Ben');
  assert.deepEqual(g.replies[2].embeds, [award('Ben', 'team_player')], "building on Ana's yes");
});

test('awards from the timing: Final Boss, Lead not Read, Sleep on It, The 11th Hour', async () => {
  let g = warm({ used: 11 });
  fakes({ routes: ['ask'], results: ['yes'] });
  await say(g, 'Is it alive?', 'Cat');
  assert.deepEqual(g.replies[0].embeds, [award('Cat', 'final_boss')], 'first question in the second half, a yes');

  g = warm();
  fakes({ routes: ['ask', 'ask'], results: ['sort_of', 'sort_of'] });
  const started = g.data.startedAt;
  await say(g, 'Is it big?', 'Dan', started + 1500);
  assert.deepEqual(g.replies[0].embeds, [award('Dan', 'lead_not_read')], 'within 2 seconds of the start');
  await say(g, 'Is it small?', 'Eve', started + 1500 + 2 * 60 * 1000);
  assert.deepEqual(g.replies[1].embeds, [award('Eve', 'sleep_on_it')], 'two minutes after the last question');

  for (const extra of [{ endsAt: Date.now() + 30 * 1000 }, { used: 19 }]) {
    g = warm({ ...extra, log: [{ username: 'Dan', text: 'Is it big?', result: 'sort_of', at: 0 }] });
    fakes({ routes: ['ask'], results: ['win'] });
    await say(g, 'Is it a frog?', 'Dan');
    assert.ok(g.th.sent[0].embeds[0].description.includes(t('awards.eleventh_hour.name')), JSON.stringify(extra));
  }
});

test('Sonnet judges Hot Stuff, Breakthrough, Team Player and Scenic Route with the answer', async () => {
  const g = game({ used: 8 });
  fakes({
    routes: ['ask', 'ask', 'ask', 'ask'],
    results: [{ result: 'no', hot_stuff: true }, { result: 'yes', scenic_route: true, team_player: true }, { result: 'yes', breakthrough: true, team_player: true }, { result: 'win', hot_stuff: true, breakthrough: true }],
  });
  assert.deepEqual(await say(g, 'Is it a toad?', 'Ana'), [t('answers.no')]);
  assert.deepEqual(g.replies[0].embeds, [award('Ana', 'hot_stuff', 'ice_breaker')], 'in the box with the answer');
  await say(g, 'Do you like jazz?', 'Ben');
  assert.deepEqual(g.replies[1].embeds, [award('Ben', 'scenic_route')], 'no Team Player: there was no yes to build on');
  assert.deepEqual(calls.scenic, [false, true], 'Scenic Route is only judged after 9 questions and hints');

  await say(g, 'Is it an amphibian?', 'Ana');
  assert.deepEqual(g.replies[2].embeds, [award('Ana', 'breakthrough', 'team_player', 5)], "Team Player: building on Ben's yes");
  await say(g, 'Is it a frog?', 'Ben');
  const won = g.th.sent[0].embeds[0].description;
  assert.ok(won.includes(t('awards.winner.name')));
  assert.ok(!won.includes(t('awards.hot_stuff.name')) && !won.includes(t('awards.breakthrough.name')), 'a winning guess earns no judged awards');
});

test('awards are collected for good: shown only the first time, with who else has them', async () => {
  let g = game();
  const { storage } = g;
  fakes({ routes: ['ask'], results: ['no'] });
  await say(g, 'Is it big?', 'Ana');
  assert.deepEqual(g.replies[0].embeds, [award('Ana', 'ice_breaker')]);
  assert.deepEqual(storage.players.Ana, { name: 'Ana', awards: ['welcome_aboard', 'ice_breaker'], questions: 2, wins: 0, games: 0, categories: [] }, 'kept in the skill\'s storage');

  // Another game on the same server: Ana doesn't see Ice Breaker again; others see that she has it.
  for (const name of ['Ana', 'Ben', 'Cat', 'Dan', 'Eve', 'Fay', 'Gus']) {
    g = game();
    g.ctx.storage = g.storage = storage;
    fakes({ routes: ['ask'], results: ['no'] });
    await say(g, 'Is it big?', name);
  }
  // After Ana, the box for each player lists who has Ice Breaker already.
  // Gus is the 7th: Ana, Ben, Cat and 3 others.
  assert.deepEqual(g.replies[0].embeds, [award('Gus', 'ice_breaker', { others: t('award_others', { names: `Ana, Ben, Cat${t('list_and')}${t('list_others', { count: 3 })}` }) })]);
  assert.deepEqual(storage.players.Ana.awards, ['welcome_aboard', 'ice_breaker'], 'not counted twice');
});

test('the award box names one, two or four others in full', async () => {
  const g = game();
  for (const [names, expected] of [[['Ana'], t('award_others_one', { names: 'Ana' })], [['Ana', 'Ben'], t('award_others', { names: `Ana${t('list_and')}Ben` })], [['Ana', 'Ben', 'Cat', 'Dan'], t('award_others', { names: `Ana, Ben, Cat${t('list_and')}Dan` })]]) {
    g.storage.players = { ...Object.fromEntries(names.map(name => [name, { ...veteran(name), awards: ['ice_breaker'] }])), Zed: veteran('Zed') };
    g.data.log = [];
    g.replies = [];
    fakes({ routes: ['ask'], results: ['no'] });
    await say(g, 'Is it big?', 'Zed');
    assert.deepEqual(g.replies[0].embeds, [award('Zed', 'ice_breaker', { others: expected })]);
  }
});

// A My awards click in a thread, recording the replies only the player can see.
function awardsClick(userId, channelId = 't1') {
  const i = Object.assign(command('', {}, { userId }), { customId: 'TwentyQuestions:awards', channelId, isButton: () => true, isChatInputCommand: () => false });
  i.private = [];
  i.reply = async x => { i.private.push(x); };
  i.followUp = async x => { i.private.push(x); };
  return i;
}

test('the game ends with Play again and My awards buttons', async () => {
  const g = game();
  fakes({ routes: ['stop'] });
  await say(g, 'stop the game');
  assert.deepEqual(g.th.sent.at(-1).components[0].components.map(b => [b.custom_id, b.label]), [['TwentyQuestions:again', t('play_again')], ['TwentyQuestions:awards', t('my_awards')]]);
});

test('My awards shows the player their collection, only to them: a box per earned award, then one for the locked ones', async () => {
  const g = game();
  g.storage.players.Ana.awards.push('hot_stuff');
  fakes({ routes: ['ask'], results: ['no'] });
  await say(g, 'Is it big?', 'Ana'); // Ice Breaker, new in this thread's game

  const i = awardsClick('Ana');
  await skill.handle(i, g.ctx);
  assert.equal(i.private.length, 1, 'four boxes fit in one message');
  assert.equal(i.private[0].flags, 64, 'only Ana can see it');
  assert.equal(i.private[0].content, t('collection_title', { count: 3, total: TOTAL }));
  const boxes = i.private[0].embeds;
  assert.deepEqual(boxes.slice(0, 3), [
    { color: 0xf1c40f, description: t('collection_earned', { ...t.get('awards.hot_stuff'), new: '' }) },
    { color: 0xf1c40f, description: t('collection_earned', { ...t.get('awards.ice_breaker'), new: t('collection_new') }) },
    { color: 0xf1c40f, description: t('collection_earned', { ...t.get('awards.welcome_aboard'), new: '' }) },
  ], 'a box for each earned award, in order; the one from this game is marked new');
  const locked = Object.keys(t.get('awards')).filter(key => !['hot_stuff', 'ice_breaker', 'welcome_aboard'].includes(key));
  assert.deepEqual(boxes[3], {
    color: 0x4f545c,
    description: t('collection_locked', { lines: locked.map(key => t('collection_locked_line', t.get(`awards.${key}`))).join('\n') }),
  }, 'then one grey box saying how to earn each locked award');
  assert.equal(boxes.length, 4);

  const ben = awardsClick('Ben', 'elsewhere');
  await skill.handle(ben, g.ctx);
  assert.equal(ben.private[0].content, t('collection_title', { count: 1, total: TOTAL }), 'anyone can look');

  // With more than 9 earned, the boxes go over two messages (Discord allows 10 per message).
  g.storage.players.Cat.awards = Object.keys(t.get('awards')).slice(0, 12);
  const cat = awardsClick('Cat', 'elsewhere');
  await skill.handle(cat, g.ctx);
  assert.deepEqual(cat.private.map(m => m.embeds.length), [10, 3]);
  assert.ok(cat.private.every(m => m.flags === 64));
});

test('Welcome Aboard, Centurion, Hat Trick and Fence Sitter come from the player\'s totals and the game', async () => {
  let g = game();
  delete g.storage.players.Ana;
  fakes({ routes: ['ask'], results: ['no'] });
  await say(g, 'Is it big?', 'Ana');
  assert.ok(g.replies[0].embeds[0].description.includes(t('awards.welcome_aboard.name')), 'a very first question');

  g = warm();
  Object.assign(g.storage.players.Ana, { questions: 99 });
  fakes({ routes: ['ask'], results: ['no'] });
  await say(g, 'Is it big?', 'Ana');
  assert.deepEqual(g.replies[0].embeds, [award('Ana', 'centurion')], 'the 100th question');

  g = warm({ used: 8, log: [{ username: 'Zed', text: 'Is it big?', result: 'sort_of', at: 0 }], hints: ['a', 'b', 'c', 'a hint'] });
  Object.assign(g.storage.players.Ana, { wins: 2 });
  fakes({ routes: ['ask'], results: ['win'] });
  await say(g, 'Is it a frog?', 'Ana');
  const box = g.th.sent[0].embeds[0].description;
  assert.ok(box.includes(t('awards.hat_trick.name')) && box.includes(t('awards.winner.name')), 'a third winning guess');
  assert.ok(!box.includes(t('awards.sharpshooter.name')), 'not with 9 questions used');
  assert.ok(!box.includes(t('awards.no_help_needed.name')), 'not after a hint (questions used but not in the log)');
  assert.equal(g.storage.players.Ana.wins, 3);

  g = warm();
  fakes({ routes: ['ask', 'ask', 'ask'], results: ['sort_of', 'sort_of', 'sort_of'] });
  for (let k = 0; k < 3; k++) await say(g, 'Is it big?', 'Ben');
  assert.deepEqual(g.replies.map(r => r.embeds.length), [0, 0, 1]);
  assert.deepEqual(g.replies[2].embeds, [award('Ben', 'fence_sitter')], 'three "sort of" answers in one game');
});

test('the poll gives Wisdom of the Crowd to the right voters, and Swing Vote when one vote decided it', async ctxt => {
  const g = game();
  fakes({ routes: ['options'] });
  await optionsPoll(ctxt, g, { Frog: ['Ana', 'Ben'], Toad: ['Dean'] });
  const boxes = g.th.sent.find(m => m.content === t('options_win', { picked: 'Frog' })).embeds;
  assert.deepEqual(boxes.map(b => b.description.split('**')[1]), ['Ana', 'Ben'], 'a box each for the right voters');
  assert.deepEqual(boxes[0], award('Ana', 'wisdom_of_the_crowd', 'swing_vote', { count: 3, others: t('award_others_one', { names: 'Ben' }) }), 'won by one vote');
  assert.ok(!boxes.some(b => b.description.startsWith('**Dean**')), 'not for a wrong vote');
  assert.equal(g.data.players.Ben, 'Ben', 'voters take part in the game');
});

test('when the game ends, everyone who took part gets Regular, Explorer, Full House and the topic\'s category awards', async () => {
  const g = game({ category: 'Animals', article: { ...FROG, tags: ['Films', 'Animals'] } });
  Object.assign(g.storage.players.Ana, { games: 9, categories: ['a', 'b', 'c', 'd'] });
  fakes({ routes: ['chat', 'chat', 'chat', 'stop'] });
  for (const name of ['Ana', 'Ben', 'Cat']) await say(g, 'hmm', name);
  await say(g, 'stop the game', 'Dan');
  const boxes = g.th.sent.find(m => m.content === t('stopped')).embeds;
  assert.equal(boxes.length, 4, 'a box for each player');
  const [ana, ben] = boxes.map(b => b.description);
  for (const key of ['regular', 'explorer', 'full_house', 'film_buff']) assert.ok(ana.includes(t(`awards.${key}.name`)), `Ana: ${key}`);
  assert.ok(ana.includes(t('award_others', { names: `Ben, Cat${t('list_and')}Dan` })), 'the others who got Full House in the same game');
  assert.ok(ben.includes(t('awards.film_buff.name')) && !ben.includes(t('awards.regular.name')), 'Ben: not his 10th game');
  assert.deepEqual(g.storage.players.Ana.categories, ['a', 'b', 'c', 'd', 'animals']);
  assert.equal(g.storage.players.Ben.games, 1);
});

test('Completionist comes with the last of the other awards', async () => {
  const g = warm();
  const others = Object.keys(t.get('awards')).filter(key => !['completionist', 'fence_sitter'].includes(key));
  Object.assign(g.storage.players.Ben, { awards: others });
  fakes({ routes: ['ask', 'ask', 'ask'], results: ['sort_of', 'sort_of', 'sort_of'] });
  for (let k = 0; k < 3; k++) await say(g, 'Is it big?', 'Ben');
  assert.deepEqual(g.replies[2].embeds, [award('Ben', 'fence_sitter', 'completionist', TOTAL)]);
});

test('a topic\'s tags come from good_articles.json', () => {
  const [film] = realTagged(['Films']);
  assert.ok(wiki.tagsOf(film.title).includes('Films'));
  assert.deepEqual(wiki.tagsOf('No such topic'), []);
  for (const award of Object.values(t.get('awards'))) {
    for (const tag of award.tags ?? []) assert.ok(realTags().includes(tag), `${award.name}: ${tag} is a tag`);
  }
});

test('reminders at 15, 10 and 5 questions left; after the last question, a final poll', async ctxt => {
  ctxt.mock.timers.enable({ apis: ['setTimeout'] });
  const g = game({ used: 4 });
  fakes({ routes: Array(16).fill('ask'), results: Array(16).fill('no') });
  ai.options = async () => ({ answer: 'Frog', decoys: ['Toad', 'Newt', 'Salamander'] });
  const replies = [];
  for (let i = 0; i < 15; i++) replies.push(...await say(g, 'Is it big?'));
  const no = t('answers.no');
  assert.deepEqual(replies.filter(r => r !== no), [15, 10, 5].map(left => `${no} ${t('questions_left', { left })}`));
  assert.equal(g.data.used, 19);

  const flush = async () => { for (let k = 0; k < 10; k++) await new Promise(r => setImmediate(r)); };
  const last = say(g, 'Is it small?');
  await flush();
  assert.equal(g.th.sent.at(-1), t('out_of_questions'));
  assert.ok(!g.th.sent.some(m => m?.poll), 'a pause before the poll');
  ctxt.mock.timers.tick(5000);
  await flush();
  assert.ok(g.th.sent.some(m => m?.poll), 'then the poll');
  g.th.votes = { Frog: 1 };
  ctxt.mock.timers.tick(25 * 1000);
  await last;
  assert.ok(text(g.th).includes(t('options_win', { picked: 'Frog' })));
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

// Asks for options, lets the 25-second poll run out, and returns the poll message.
async function optionsPoll(ctxt, g, votes, during = async () => {}) {
  ctxt.mock.timers.enable({ apis: ['setTimeout'] });
  ai.options = async () => ({ answer: 'Frog', decoys: ['Toad', 'Newt', 'Salamander'] });
  g.th.votes = votes;
  const asked = say(g, 'Give us some options');
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  await during();
  ctxt.mock.timers.tick(25 * 1000);
  await asked;
  return g.th.sent.find(m => m?.poll);
}

test('asking for options shows a 25-second poll; the most votes for the right one wins', async ctxt => {
  const g = game();
  fakes({ routes: ['options'] });
  const started = Date.now();
  const poll = await optionsPoll(ctxt, g, { Frog: 2, Toad: 1 });

  assert.equal(poll.poll.question.text, t('options_question'));
  assert.deepEqual(poll.poll.answers.map(a => a.text).sort(), ['Frog', 'Newt', 'Salamander', 'Toad']);
  const closes = g.th.sent[g.th.sent.indexOf(poll) - 1];
  assert.match(closes, /<t:(\d+):R>/, 'a message says when the poll closes');
  assert.ok(Math.abs(Number(closes.match(/<t:(\d+):R>/)[1]) - (started / 1000 + 25)) <= 2);
  assert.ok(g.th.pollEnded, 'the poll is closed');
  assert.ok(text(g.th).includes(t('options_win', { picked: 'Frog' })));
  assert.ok(text(g.th).includes(t('card_loading_won')) && !text(g.th).includes(t('card_loading')), 'the answer is known');
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

test('after 60 seconds without a question, a recap and three questions to try, once per quiet spell', async () => {
  fakes({ routes: ['ask'], results: ['no'] });
  const g = game({ threadId: 'quiet', startedAt: Date.now() - 61 * 1000 });
  const client = { channels: { fetch: async () => g.th } };
  const settle = () => new Promise(r => setImmediate(r));
  await skill.run(g.data, client);
  await settle();
  assert.equal(g.th.sent.length, 1);
  assert.equal(g.th.sent[0], t('nudge', {
    recap: "It's alive and lives near water.",
    questions: ['Is it green?', 'Can it fly?', 'Is it a mammal?'].map(question => t('nudge_question', { question })).join('\n'),
  }));
  assert.ok(g.th.typing >= 1, 'typing while the recap is written');

  await skill.run(g.data, client);
  await settle();
  assert.equal(calls.recaps, 1, 'once per quiet spell');

  await say(g, 'Is it big?', 'Ana', Date.now() - 65 * 1000); // a question starts a new quiet spell
  await skill.run(g.data, client);
  await settle();
  assert.equal(calls.recaps, 2);

  // A message while the recap is being written (even chat) means it isn't posted.
  const posted = g.th.sent.length;
  g.data.startedAt = g.data.lastAt = Date.now() - 70 * 1000; // a new quiet spell
  let writing;
  ai.recap = () => new Promise(resolve => { writing = resolve; });
  await skill.run(g.data, client);
  await say(g, 'hmm no idea', 'Ben');
  writing({ recap: 'x', questions: ['a?', 'b?', 'c?'] });
  await settle();
  assert.equal(g.th.sent.length, posted, 'dropped');

  const busy = game({ threadId: 'busy', startedAt: Date.now() - 45 * 1000 });
  await skill.run(busy.data, { channels: { fetch: async () => busy.th } });
  await settle();
  assert.equal(calls.recaps, 2, 'not before 60 seconds');
});

test('time reminders at 15, 10, 5 and 1 minutes left, once each', async () => {
  fakes();
  const g = game({ threadId: 'countdown', startedAt: Date.now() });
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
