const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const SKILLS = path.join(root, 'Skills');
const SKILL_FILE = 'skill.js';
const loadStrings = require(path.join(root, 'src', 'strings.js'));
const createDb = require(path.join(root, 'src', 'db.js'));

test('strings: fills placeholders, returns raw values, falls back to the key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strings-'));
  fs.writeFileSync(path.join(dir, 'strings.yaml'), 'hello: "Hi {name}, {name}!"\nlist: [a, b]\nnested:\n  key: "x"\n');
  const t = loadStrings(dir);
  assert.equal(t('hello', { name: 'Bob' }), 'Hi Bob, Bob!');
  assert.equal(t('hello'), 'Hi {name}, {name}!');
  assert.equal(t('nested.key'), 'x');
  assert.deepEqual(t.get('list'), ['a', 'b']);
  assert.equal(t('missing'), 'missing');
});

test('db: creates, saves and lists server files', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'Servers');
  const db = createDb(dir);
  assert.deepEqual(db.get('123'), { jobs: [] });
  db.get('123').jobs.push({ id: 'a', type: 'X', data: {} });
  db.save('123');
  assert.deepEqual(db.list(), ['123']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '123.json'), 'utf8')).jobs[0].id, 'a');
});

test('skills: each exports commands, handle and run with valid, unique commands', () => {
  const names = new Set();
  for (const name of fs.readdirSync(SKILLS)) {
    const skill = require(path.join(SKILLS, name, SKILL_FILE));
    assert.equal(typeof skill.handle, 'function', name);
    assert.equal(typeof skill.run, 'function', name);
    for (const cmd of skill.commands) {
      assert.match(cmd.name, /^[-_a-z0-9]{1,32}$/, `${name}: command name`);
      assert.ok(cmd.description.length >= 1 && cmd.description.length <= 100, `${name}: /${cmd.name} description`);
      for (const opt of cmd.options ?? []) {
        assert.match(opt.name, /^[-_a-z0-9]{1,32}$/, `${name}: option name`);
        assert.ok(opt.description.length <= 100, `${name}: /${cmd.name} ${opt.name} description`);
      }
      assert.ok(!names.has(cmd.name), `duplicate command /${cmd.name}`);
      names.add(cmd.name);
    }
  }
  assert.ok(names.size > 0);
});
