const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Prefer strings.yaml next to the exe so it can be edited without rebuilding;
// fall back to the copy bundled with the code.
const external = path.join(process.pkg ? path.dirname(process.execPath) : __dirname, 'strings.yaml');
const file = fs.existsSync(external) ? external : path.join(__dirname, 'strings.yaml');
const strings = yaml.load(fs.readFileSync(file, 'utf8'));

// t('timer.done', { username: 'Bob' }) -> "Bob, your timer is up."
module.exports = function t(key, vars = {}) {
  const value = key.split('.').reduce((obj, k) => obj?.[k], strings);
  if (typeof value !== 'string') return key;
  return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? vars[name] : match));
};
