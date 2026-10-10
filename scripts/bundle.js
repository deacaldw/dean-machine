// Runs after `pkg`: puts each executable in its own folder with everything needed to run it.
//   dist/windows/  deanmachine.exe + .env + editable strings
//   dist/linux/    deanmachine     + .env + editable strings
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const targets = [
  { dir: 'windows', from: 'deanmachine-win.exe', to: 'deanmachine.exe' },
  { dir: 'linux', from: 'deanmachine-linux', to: 'deanmachine' },
];

// All strings.yaml files, so messages can be edited without rebuilding.
const strings = ['strings.yaml'];
for (const name of fs.readdirSync(path.join(root, 'Jobs'))) {
  const file = path.join('Jobs', name, 'strings.yaml');
  if (fs.existsSync(path.join(root, file))) strings.push(file);
}

const env = fs.existsSync(path.join(root, '.env')) ? '.env' : '.env.example';

for (const target of targets) {
  const out = path.join(dist, target.dir);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  fs.renameSync(path.join(dist, target.from), path.join(out, target.to));
  fs.copyFileSync(path.join(root, env), path.join(out, '.env'));
  for (const file of strings) {
    fs.mkdirSync(path.join(out, path.dirname(file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(out, file));
  }
  console.log(`Bundled dist/${target.dir}`);
}
if (env !== '.env') console.log('No .env found; copied .env.example. Fill in DISCORD_TOKEN before running.');
