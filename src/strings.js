const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const baseDir = process.pkg ? path.dirname(process.execPath) : root;

// Returns t() for the strings.yaml in a skill's folder. A copy at the same relative path
// next to the executable (e.g. Skills/VoteTime/strings.yaml) overrides the bundled one.
module.exports = function load(dir) {
  const external = path.join(baseDir, path.relative(root, dir), 'strings.yaml');
  const file = fs.existsSync(external) ? external : path.join(dir, 'strings.yaml');
  const strings = yaml.load(fs.readFileSync(file, 'utf8'));
  const get = key => key.split('.').reduce((obj, k) => obj?.[k], strings);

  // t('result', { name: 'Raid' }) fills in {name}; unknown keys return the key itself.
  function t(key, vars = {}) {
    const value = get(key);
    if (typeof value !== 'string') return key;
    return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
  }
  t.get = get; // raw values, e.g. lists
  return t;
};
