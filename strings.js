const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;

// Returns a t() function for the strings.yaml in `dir`.
// A copy at the same relative path next to the exe (e.g. Jobs/VoteTime/strings.yaml)
// overrides the bundled one, so strings can be edited without rebuilding.
module.exports = function load(dir) {
  const bundled = path.join(dir, 'strings.yaml');
  const external = path.join(baseDir, path.relative(__dirname, dir), 'strings.yaml');
  const file = fs.existsSync(external) ? external : bundled;
  const strings = yaml.load(fs.readFileSync(file, 'utf8'));

  const get = key => key.split('.').reduce((obj, k) => obj?.[k], strings);

  // t('result', { name: 'Raid', time: 1791738000 }) fills in {name} and {time}
  function t(key, vars = {}) {
    const value = get(key);
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
  }
  t.get = get; // raw value (lists, etc.)
  return t;
};
