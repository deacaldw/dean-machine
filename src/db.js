const fs = require('fs');
const path = require('path');

// Each server's data lives in Servers/<Server_ID>.json and is cached in memory:
// { jobs: [{ id, skill, data }], storage: { <Skill>: {...} } }. Jobs come and go; storage is kept for good.
module.exports = function (dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cache = {};
  const file = id => path.join(dir, `${id}.json`);

  function get(id) {
    if (!cache[id]) {
      cache[id] = fs.existsSync(file(id))
        ? JSON.parse(fs.readFileSync(file(id), 'utf8'))
        : { jobs: [], storage: {} };
      cache[id].jobs ??= [];
      cache[id].storage ??= {};
    }
    return cache[id];
  }

  function save(id) {
    fs.writeFileSync(file(id), JSON.stringify(cache[id], null, 2));
  }

  // A skill's storage on a server, created on first use.
  const storage = (id, skill) => (get(id).storage[skill] ??= {});

  function list() {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
  }

  return { get, save, list, storage };
};
