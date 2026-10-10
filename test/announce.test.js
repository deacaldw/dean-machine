const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ctx, command, component, client } = require('./fakes');

const skill = require(path.join(__dirname, '..', 'Skills', 'Announce', 'skill.js'));
const admin = { admin: true, userId: 'a1', displayName: 'Boss' };
const announce = async (jobs, options, who) => {
  const i = command('announce', options, who);
  await skill.handle(i, ctx(jobs));
  return i.replied;
};
const announcement = extra => ({ channelId: 'c1', userId: 'u1', username: 'Dean', message: 'Hi', image: false, repeat: 0, nextAt: 0, postIds: [], ...extra });

test('announce confirms with a preview and a Delete button', async () => {
  const jobs = [];
  const reply = await announce(jobs, { message: 'Game night @everyone!', delay: 60 });
  assert.match(reply.content, /^Announcement scheduled: posts <t:\d+:R> \(<t:\d+:f>\), once\.\n\*\*Preview:\*\*\n\*\*Dean\*\* says: @everyone$/);
  assert.equal(reply.embeds[0].description, 'Game night @everyone!');
  assert.equal(reply.components[0].components[0].data.custom_id, 'Announce:delete:j0');
  assert.deepEqual(reply.allowedMentions, { parse: [] });
  assert.equal(jobs[0].data.message, 'Game night @everyone!');
  assert.ok(jobs[0].data.nextAt > Date.now() + 59 * 60000);
});

test('announce enforces permissions and limits', async () => {
  const jobs = [];
  assert.match((await announce(jobs, { message: 'x', repeat: 1440 })).content, /Manage Server.*repeating/);
  assert.match((await announce(jobs, { message: 'https://x.com/a.png?s=1' })).content, /Manage Server.*image/);
  assert.match((await announce(jobs, { message: 'x', repeat: 100 }, admin)).content, /between 300 and 44640/);
  await announce(jobs, { message: 'one' });
  await announce(jobs, { message: 'two' });
  assert.match((await announce(jobs, { message: 'three' })).content, /only have 2/);
  assert.equal(jobs.length, 2);

  await announce(jobs, { message: 'Daily', repeat: 1440 }, admin);
  await announce(jobs, { message: 'https://x.com/cat.gif' }, admin);
  assert.deepEqual(jobs.slice(2).map(j => [j.data.repeat, j.data.image]), [[1440, false], [0, true]]);

  while (jobs.length < 25) jobs.push({ id: `f${jobs.length}`, data: announcement({ userId: 'other' }) });
  assert.match((await announce(jobs, { message: 'x' }, admin)).content, /maximum/);
});

test('stop-announce lists own announcements, or all for admins', async () => {
  const jobs = [
    { id: 'j0', data: announcement({ message: 'Later', nextAt: Date.now() + 90 * 60000 }) },
    { id: 'j1', data: announcement({ userId: 'a1', username: 'Boss', message: 'Daily news', repeat: 1440 }) },
  ];
  const labels = i => i.replied.components[0].components[0].options.map(o => o.data.label);

  let i = command('stop-announce');
  await skill.handle(i, ctx(jobs));
  assert.deepEqual(labels(i), ['Dean (in 1.5h once): Later']);

  i = command('stop-announce', {}, admin);
  await skill.handle(i, ctx(jobs));
  assert.deepEqual(labels(i), ['Dean (in 1.5h once): Later', 'Boss (now every 24h): Daily news']);

  i = command('stop-announce', {}, { userId: 'nobody' });
  await skill.handle(i, ctx(jobs));
  assert.match(i.replied.content, /no announcements/);
});

test('stopping checks ownership and handles stale selections', async () => {
  const jobs = [{ id: 'j0', data: announcement({ message: 'Mine' }) }];
  for (const [i, expected] of [
    [component('Announce:stop', { values: ['j0'], userId: 'u2' }), /only stop your own/],
    [component('Announce:delete:j0'), /^Stopped: Mine$/],
    [component('Announce:stop', { values: ['j0'] }), /already ended/],
  ]) {
    await skill.handle(i, ctx(jobs));
    assert.match(i.updated.content, expected);
    assert.deepEqual(i.updated.components, []);
  }
  assert.equal(jobs.length, 0);
});

test('text announcements repeat mentions so they ping; images are embedded', async () => {
  const c = client();
  assert.equal(await skill.run(announcement({ message: 'Hey @everyone, <@123> and <@&456>!' }), c), true);
  assert.equal(await skill.run(announcement({ message: 'https://x.com/cat.gif', image: true }), c), true);
  assert.equal(c.channel.sent[0].content, '**Dean** says: @everyone <@123> <@&456>');
  assert.equal(c.channel.sent[0].embeds[0].description, 'Hey @everyone, <@123> and <@&456>!');
  assert.deepEqual(c.channel.sent[1].embeds[0].image, { url: 'https://x.com/cat.gif' });
  assert.equal(c.channel.sent[1].content, undefined);
});

test('repeats skip if a recent post is still in the last 3 messages, and stay on schedule', async () => {
  const c = client();
  const data = announcement({ repeat: 1440, nextAt: Date.now() - 3 * 864e5 - 1000 }); // bot was offline for 3 days
  assert.equal(await skill.run(data, c), false);
  assert.equal(c.channel.sent.length, 1);
  assert.ok(Math.abs(data.nextAt - Date.now() - 864e5) < 2000); // next slot ~24h away

  c.channel.recent = [data.postIds[0]];
  data.nextAt = 0;
  await skill.run(data, c);
  assert.equal(c.channel.sent.length, 1);

  c.channel.recent = ['x', 'y', 'z'];
  data.nextAt = 0;
  await skill.run(data, c);
  assert.equal(c.channel.sent.length, 2);
});

test('failed posts: one-offs retry up to 10 times, repeats wait for the next slot, deleted channels end', async () => {
  const failing = code => ({ channels: { fetch: async () => { throw Object.assign(new Error('fail'), { code }); } } });
  const error = console.error;
  console.error = () => {};
  try {
    const once = announcement();
    for (let i = 1; i < 10; i++) {
      assert.equal(await skill.run({ ...once, nextAt: 0 }, failing()), false);
      once.retries = i;
    }
    assert.equal(await skill.run({ ...once, nextAt: 0 }, failing()), true);

    const daily = announcement({ repeat: 1440, nextAt: Date.now() - 1000 });
    assert.equal(await skill.run(daily, failing()), false);
    assert.ok(Math.abs(daily.nextAt - Date.now() - 864e5) < 2000);

    assert.equal(await skill.run(announcement({ repeat: 1440 }), failing(10003)), true);
  } finally {
    console.error = error;
  }
});

test('nothing is posted before the scheduled time', async () => {
  const c = client();
  assert.equal(await skill.run(announcement({ nextAt: Date.now() + 60000 }), c), false);
  assert.equal(c.channel.sent.length, 0);
});
