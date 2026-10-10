// Runs after `pkg`: puts each executable in its own folder with everything needed to run it.
//   dist/windows/  deanmachine.exe + .env + editable strings
//   dist/linux/    deanmachine     + .env + editable strings + install.sh/uninstall.sh
// Anything in deploy/<target>/ (e.g. deploy/linux/install.sh) is copied in too.
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
  const deploy = path.join(root, 'deploy', target.dir);
  for (const file of fs.existsSync(deploy) ? fs.readdirSync(deploy) : []) {
    let content = fs.readFileSync(path.join(deploy, file));
    // Shell scripts must have Unix line endings, even if git checked them out with CRLF.
    if (file.endsWith('.sh')) content = content.toString('utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(path.join(out, file), content, { mode: 0o755 });
  }
  console.log(`Bundled dist/${target.dir}`);
}
if (env !== '.env') console.log('No .env found; copied .env.example. Fill in DISCORD_TOKEN before running.');
