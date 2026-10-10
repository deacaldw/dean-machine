const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ctx, command, client } = require('./fakes');

const skill = require(path.join(__dirname, '..', 'Skills', 'VoteTime', 'skill.js'));
const DAY = 86400;
const thu = Date.UTC(2026, 9, 15, 17) / 1000; // Thursday 17:00 UTC

let n = 0;
const vote = extra => ({ channelId: 'c1', pollId: `poll${++n}`, timesId: `times${n}`, name: 'Next Session', times: [thu], endsAt: 0, ...extra });
const poll = counts => ({ poll: { resultsFinalized: true, answers: new Map(counts.map((c, i) => [i + 1, { voteCount: c }])) } });
const closeWith = async (data, counts) => {
  const c = client({ [data.pollId]: poll(counts), [data.timesId]: {} });
  assert.equal(await skill.run(data, c), true);
  return c.channel.sent[0];
};

test('vote-time with defaults posts local times, then a 3-day poll', async () => {
  const jobs = [];
  const i = command('vote-time');
  await skill.handle(i, ctx(jobs));

  assert.match(i.replied, /^# Next Session\nVote on the time for the next game session!\n\nHere are the options translated to your local time:\n🔶 <t:\d+:F>, <t:\d+:R>\n🔹 .+\n🟢 .+$/);
  const { poll } = i.followedUp;
  assert.equal(poll.question.text, 'Next Session');
  assert.equal(poll.duration, 24);
  assert.equal(poll.allowMultiselect, true);
  assert.deepEqual(poll.answers.map(a => a.emoji), ['🔶', '🔹', '🟢']);
  for (const a of poll.answers) assert.match(a.text, /^\w{3} \d{1,2} \w{3}, 17:00 UTC \(\d\d:00 London\)$/);

  const { data } = jobs[0];
  const now = new Date();
  assert.equal(data.times[0], Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 17) / 1000);
  assert.deepEqual(data.times.map(t => t - data.times[0]), [0, DAY, 2 * DAY]);
  assert.equal(data.pollId, 'followup1');
  assert.equal(data.timesId, 'reply1');
});

test('vote-time accepts custom options', async () => {
  const jobs = [];
  const i = command('vote-time', { days: 10, time: '9:05', name: 'Raid', message: 'Pick!', dayoffset: 0 });
  await skill.handle(i, ctx(jobs));
  assert.equal(i.followedUp.poll.answers.length, 10);
  assert.ok(i.followedUp.poll.answers.every(a => a.text.length <= 55));
  assert.match(i.followedUp.poll.answers[0].text, /09:05 UTC/);
  assert.match(i.replied, /^# Raid\nPick!/);
});

test('vote-time rejects a bad time', async () => {
  const jobs = [];
  const i = command('vote-time', { time: '25:00' });
  await skill.handle(i, ctx(jobs));
  assert.match(i.replied.content, /Invalid time/);
  assert.equal(jobs.length, 0);
});

test('vote-time allows one vote per server and links to it', async () => {
  const jobs = [{ id: 'x', data: vote({ endsAt: 1791700000000 }) }];
  const i = command('vote-time');
  await skill.handle(i, ctx(jobs));
  assert.match(i.replied.content, /already running: https:\/\/discord\.com\/channels\/g1\/c1\/poll\d+/);
  assert.match(i.replied.content, /<t:1791700000:R>/);
  assert.match(i.replied.content, /admin deletes the poll/);
  assert.equal(jobs.length, 1);
});

test('vote-time keeps running while both messages exist', async () => {
  const data = vote({ endsAt: Date.now() + 864e5 });
  assert.equal(await skill.run(data, client({ [data.pollId]: poll([]), [data.timesId]: {} })), false);
});

test('deleting either message deletes the other and ends the vote', async () => {
  for (const missing of ['pollId', 'timesId']) {
    const data = vote({ endsAt: Date.now() + 864e5 });
    const kept = missing === 'pollId' ? data.timesId : data.pollId;
    const c = client({ [kept]: poll([]) });
    assert.equal(await skill.run(data, c), true);
    assert.deepEqual(c.channel.deleted, [kept]);
  }
});

test('vote-time waits for Discord to finalize results', async () => {
  const data = vote({ endsAt: Date.now() - 1000 });
  const c = client({ [data.pollId]: { poll: { resultsFinalized: false, answers: new Map() } }, [data.timesId]: {} });
  assert.equal(await skill.run(data, c), false);
});

test('vote-time announces the winner; ties prefer Fri-Sun, then the earliest', async () => {
  const times = [thu, thu + DAY, thu + 2 * DAY]; // Thu, Fri, Sat
  const result = time => `# Next Session\nThe poll has closed. See you all on:\n\n **<t:${time}:F>, <t:${time}:R>**`;
  assert.equal((await closeWith(vote({ times }), [1, 2, 3])), result(times[2]));
  assert.equal((await closeWith(vote({ times }), [2, 2, 2])), result(times[1]));
  assert.equal((await closeWith(vote({ times }), [2, 1, 2])), result(times[2]));
  assert.equal((await closeWith(vote({ times: [thu - 3 * DAY, thu - 2 * DAY] }), [1, 1])), result(thu - 3 * DAY));
  assert.equal((await closeWith(vote({ times }), [0, 0, 0])), '# Next Session\nThe poll has closed with no votes.');
});
