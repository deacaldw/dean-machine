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
  ai.opening = async () => ({ poem: 'Small and green I sit,\nsinging on a lily pad.\n\nWho am I?', topic: 'Amphibians', image_query: 'pond wildlife' });
  ai.screen = async () => ({ suitable: true, guessable: true });
  ai.pickPhoto = async () => 2;
  calls.reported = [];
  calls.searched = [];
  unsplash.search = async query => { calls.searched.push(query); return PHOTOS; };
  unsplash.reportUse = photo => calls.reported.push(photo.url);
  calls.gifs = [];
  gifs.random = async query => { calls.gifs.push(query); return `https://gif/${query.replace(' ', '-')}.gif`; };
}

// Runs /20questions against a fake channel and returns the job and the thread.
async function startGame(articles = [FROG]) {
  wiki.pick = async () => articles.shift();
  const th = thread('t9');
  thread.last = th;
  const jobs = [];
  const i = command('20questions');
  i.channel = { isThread: () => false };
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
  const message = { channelId: 't1', content, author: { username, bot: false }, member: { displayName: username }, channel: g.th, reply: async x => replies.push(x.content), react: async emoji => replies.push('react:' + emoji) };
  return skill.message(message, g.ctx).then(() => replies);
}

const text = th => th.sent.map(m => (typeof m === 'string' ? m : m.content)).join('\n');

test('sanitize turns typographic characters into plain ones and drops invisible ones', () => {
  assert.equal(ai.sanitize('“It’s” a test…​ ok'), '"It\'s" a test... ok');
  assert.equal(ai.sanitize('1914–1918 — the Great War'), '1914-1918 - the Great War');
  assert.equal(ai.sanitize('line one\nline two\u0007'), 'line one\nline two');
  assert.equal(ai.sanitize('Hồ Chí Minh 🐸'), 'Hồ Chí Minh 🐸');
});

test('matches accepts names, redirects and small typos, but not related things', () => {
  assert.ok(skill.matches('the frog', FROG));
  assert.ok(skill.matches('Anura', FROG));
  assert.ok(skill.matches('titanic', { title: 'Titanic (1997 film)', aliases: [] }));
  assert.ok(skill.matches('Eiffel Towr', { title: 'Eiffel Tower', aliases: [] }));
  assert.ok(!skill.matches('Pepe the Frog', FROG));
  assert.ok(!skill.matches('Toad', FROG));
});

test('/20questions skips unsuitable or unguessable articles and opens a topic thread with rules, hint card and photo credit', async () => {
  fakeAi([]);
  ai.screen = async a => ({ suitable: a.title !== 'Bad', guessable: a.title !== 'Obscure' });
  const { i, th, jobs, card } = await startGame([{ ...FROG, title: 'Bad' }, { ...FROG, title: 'Obscure' }, FROG]);

  assert.equal(i.replied, '🤔 Thinking of something…');
  assert.deepEqual(i.edits[0], { embeds: [{ color: 0x3366cc, image: { url: 'https://gif/thinking.gif' }, footer: { text: 'Powered by GIPHY' } }] });
  assert.deepEqual(calls.gifs, ['thinking']);
  assert.match(i.edited.content, /\*\*Dean\*\* started a game/);
  assert.deepEqual(i.edited.embeds, [], 'the GIF is removed');
  assert.equal(th.name, '20 Questions: Amphibians');
  assert.equal(th.sent.length, 2);

  const ends = Math.floor(jobs[0].data.endsAt / 1000);
  assert.equal(th.sent[0].content, [
    "I'm a person, a thing, an event or an idea. Guess who I am!",
    '',
    "Ask me yes-or-no questions, take a guess, or ask for a hint if you're stuck. You only have 20 questions, but hints are free.",
    '',
    "I'll react with ✔️ for yes, ❌ for no or 🌀 for sort of, and add 🔥 when you're close.",
    '',
    `The game ends <t:${ends}:R> or whenever you say "stop the game".`,
    '',
    'Ready to go?',
    '',
  ].join('\n'));
  assert.equal(card.title, 'Starting Hint');
  assert.equal(card.description, 'Small and green I sit,\nsinging on a lily pad.\nWho am I?');
  assert.deepEqual(card.image, { url: 'https://images/2.jpg' });
  assert.equal(th.sent[1].content, '-# Photo by [Photographer 2](https://unsplash.com/@p2?ref) on [Unsplash](https://unsplash.com/?utm_source=deanmachine&utm_medium=referral)');
  assert.ok(th.sent[1].flags, 'link previews suppressed');
  assert.doesNotMatch(JSON.stringify(th.sent), /Amphibians|Wikipedia/);
  assert.deepEqual(calls.searched, ['pond wildlife']);
  assert.deepEqual(calls.reported, ['https://images/2.jpg']);
  assert.equal(jobs[0].data.topic, 'Amphibians');
  assert.equal(jobs[0].data.threadId, 't9');
  assert.ok(Math.abs(jobs[0].data.endsAt - Date.now() - 1200000) < 2000);
});

test('the opening card goes without a photo if none passes the check or Unsplash fails', async () => {
  fakeAi([]);
  ai.pickPhoto = async () => 0;
  let { card, th } = await startGame();
  assert.equal(card.image, undefined);
  assert.equal(th.sent.length, 1, 'no credit line without a photo');
  assert.deepEqual(calls.reported, []);

  fakeAi([]);
  unsplash.search = async () => { throw new Error('Unsplash returned 403'); };
  const error = console.error;
  console.error = () => {};
  ({ card, th } = await startGame().finally(() => { console.error = error; }));
  assert.equal(card.title, 'Starting Hint');
  assert.equal(card.image, undefined);
  assert.equal(th.sent.length, 1);
});

test('/20questions refuses in threads, when a game runs, and reports failures', async () => {
  fakeAi([]);
  let i = command('20questions');
  i.channel = { isThread: () => true };
  await skill.handle(i, ctx([]));
  assert.match(i.replied.content, /not in a thread/);

  const g = game();
  i = command('20questions');
  i.channel = { isThread: () => false };
  await skill.handle(i, g.ctx);
  assert.match(i.replied.content, /already running on this server: https:\/\/discord\.com\/channels\/g1\/t1/);

  const jobs = [];
  wiki.pick = async () => { throw new Error('offline'); };
  i = command('20questions');
  i.channel = { isThread: () => false };
  i.editReply = async content => { i.edited = content; };
  const error = console.error;
  console.error = () => {};
  await skill.handle(i, ctx(jobs)).finally(() => { console.error = error; });
  assert.match(i.edited.content, /couldn't start/);
  assert.equal(jobs.length, 0);
});

test('only one game per server', async () => {
  fakeAi([]);
  const g = game({ channelId: 'other-channel' });
  const i = command('20questions');
  i.channel = { isThread: () => false };
  await skill.handle(i, g.ctx);
  assert.match(i.replied.content, /already running on this server/);
});

test('naming a broader kind of thing gets yes plus the close reaction, and the game goes on', async () => {
  const g = game();
  fakeAi([
    { intent: 'question', answer: 'yes_more_specific', guess: '' },
    { intent: 'guess', answer: 'yes_more_specific', guess: 'an amphibian' },
  ]);
  assert.deepEqual(await say(g, 'Are you an animal?'), ['react:✔️', 'react:🔥']);
  assert.deepEqual(await say(g, 'An amphibian!'), ['react:✔️', 'react:🔥']);
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
  const gifPosts = () => g.th.sent.filter(m => m.embeds?.[0]?.image?.url === 'https://gif/so-close.gif').length;

  assert.deepEqual(await say(g, 'Toad?'), ['react:❌', 'react:🔥']);
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
  assert.deepEqual(await say(g, 'Toad?'), ['react:❌', 'react:🔥']);
  assert.equal(g.th.sent.length, 0);

  fakeAi([]);
  gifs.random = async () => null;
  const { i } = await startGame();
  assert.equal(i.edits.length, 1, 'only the "started" edit');
});

test('questions are answered and counted; chat is ignored; hints are free', async () => {
  const g = game();
  fakeAi([
    { intent: 'question', answer: 'yes', guess: '' },
    { intent: 'chat', answer: 'none', guess: '' },
    { intent: 'question', answer: 'sort_of', guess: '' },
    { intent: 'hint', answer: 'none', guess: '' },
  ]);
  assert.deepEqual(await say(g, 'Is it an animal?'), ['react:✔️']);
  assert.deepEqual(await say(g, 'lol good one', 'Ana'), []);
  assert.deepEqual(await say(g, 'Does it live in water?'), ['react:🌀']);
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
  assert.deepEqual(await say(g, 'Is it the frog?'), ['react:✔️']);
  assert.equal(calls.verify, 0);
  assert.equal(g.jobs.length, 0);
  assert.equal(g.th.typing, 1, 'typing only while the result card is written');
  const out = text(g.th);
  assert.match(out, /\*\*Dean\*\* got it! You found the answer with 1 of 20 questions/);
  assert.match(out, /got it![^]*Pulling up the info card…[^]*^# Frog$/m);
  assert.match(out, /Most questions asked: \*\*Dean\*\* \(1\)/);
  assert.match(out, /Most valuable question: \*\*Dean\*\*: Is it an animal\?/);
  assert.match(out, /Closest guess: \*\*Ana\*\*: Toad/);
  assert.doesNotMatch(out, /Farthest guess/);
  const card = g.th.sent.find(m => m.embeds);
  assert.match(card.embeds[0].description, /^Frogs are amphibians\.\n\n\[Read more\]\(https:\/\/en\.wikipedia\.org\/wiki\/Frog\)$/);
  assert.deepEqual(card.embeds[0].image, { url: 'https://img/frog.jpg' });
});

test('an AI "yes" for a misspelling is confirmed by a second opinion, which can overrule it', async () => {
  let g = game();
  fakeAi([{ intent: 'guess', answer: 'yes', guess: 'Frogge' }, 'yes']);
  assert.deepEqual(await say(g, 'Frogge!'), ['react:✔️']);
  assert.equal(calls.verify, 1);

  g = game();
  fakeAi([{ intent: 'guess', answer: 'yes', guess: 'Pepe the Frog' }, 'not_quite']);
  assert.deepEqual(await say(g, 'Pepe the Frog?'), ['react:❌', 'react:🔥']);
  assert.equal(g.jobs.length, 1);
});

test('heads-ups at 10 and 5 questions left, once each', async () => {
  const g = game({ used: 9 });
  fakeAi(Array(6).fill({ intent: 'question', answer: 'no', guess: '' }));
  for (let i = 0; i < 6; i++) await say(g, 'Is it big?');
  assert.deepEqual(g.th.sent, ['10 questions left.', '5 questions left.']);
});

test('after 20 questions only one final guess is allowed', async () => {
  const g = game({ used: 19 });
  fakeAi([
    { intent: 'guess', answer: 'no', guess: 'Toad' },
    { intent: 'question', answer: 'yes', guess: '' },
    { intent: 'guess', answer: 'no', guess: 'Newt' },
  ]);
  assert.deepEqual(await say(g, 'Toad?'), ['react:❌']);
  assert.match(text(g.th), /last question/);
  assert.deepEqual(await say(g, 'Is it green?'), ['No more questions. Make your final guess!']);
  assert.deepEqual(await say(g, 'Newt?'), ['react:❌']);
  assert.match(text(g.th), /That was your final guess/);
  assert.equal(g.jobs.length, 0);
});

test('anyone can stop the game by asking', async () => {
  const g = game();
  fakeAi([{ intent: 'stop', answer: 'none', guess: '' }]);
  await say(g, 'ok stop the game', 'Ana');
  assert.match(text(g.th), /Game stopped/);
  assert.match(text(g.th), /^# Frog$/m);
  assert.equal(g.jobs.length, 0);
});

test('/20questions-stop is for the starter or admins', async () => {
  const g = game();
  fakeAi([]);
  let i = command('20questions-stop', {}, { userId: 'u2' });
  await skill.handle(i, g.ctx);
  assert.match(i.replied.content, /Only the player who started/);

  i = command('20questions-stop');
  i.client = { channels: { fetch: async () => g.th } };
  i.deferReply = async () => {};
  i.editReply = async content => { i.edited = content; };
  await skill.handle(i, g.ctx);
  assert.equal(i.edited, 'Game stopped.');
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
  assert.match(g.th.sent[0], /^⏳ This round ends <t:\d+:R>\.$/);
  assert.deepEqual(g.data.warned, [10, 5, 2, 1]);
});

test('run ends the game on timeout, and silently when the thread is gone', async () => {
  fakeAi([]);
  let g = game({ threadId: 'live' });
  assert.equal(await skill.run(g.data, { channels: { fetch: async () => g.th } }), false);

  g = game({ threadId: 'late', endsAt: Date.now() - 1 });
  assert.equal(await skill.run(g.data, { channels: { fetch: async () => g.th } }), true);
  assert.match(text(g.th), /Time's up/);

  g = game({ threadId: 'gone' });
  const gone = { channels: { fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { status: 404 }); } } };
  assert.equal(await skill.run(g.data, gone), true);
  assert.equal(g.th.sent.length, 0);
});
