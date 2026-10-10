const fs = require('fs');
const path = require('path');

// Each server's data lives in Servers/<Server_ID>.json and is cached in memory.
module.exports = function (dir) {
  fs.mkdirSync(dir, { recursive: true });
  const cache = {};
  const file = id => path.join(dir, `${id}.json`);

  function get(id) {
    if (!cache[id]) {
      cache[id] = fs.existsSync(file(id))
        ? JSON.parse(fs.readFileSync(file(id), 'utf8'))
        : { jobs: [] };
      cache[id].jobs ??= [];
    }
    return cache[id];
  }

  function save(id) {
    fs.writeFileSync(file(id), JSON.stringify(cache[id], null, 2));
  }

  function list() {
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
  }

  return { get, save, list };
};
