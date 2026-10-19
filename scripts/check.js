const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.js')).sort().map(name => path.join(root, 'tests', name));
if (!tests.length) throw new Error('找不到測試檔案');
run(['--test', ...tests]);
run([path.join(root, 'scripts', 'build.js')]);

const code = fs.readFileSync(path.join(root, 'dist', 'Code.gs'), 'utf8');
const html = fs.readFileSync(path.join(root, 'dist', 'Index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('Index.html 缺少應用程式程式碼');
new vm.Script(code, { filename: 'Code.gs' });
new vm.Script(match[1], { filename: 'Index.html' });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'appsscript.json'), 'utf8'));
if (manifest.timeZone !== 'Asia/Taipei') throw new Error('Apps Script 時區不是 Asia/Taipei');
if (manifest.webapp.access !== 'ANYONE_ANONYMOUS' || manifest.webapp.executeAs !== 'USER_DEPLOYING') {
  throw new Error('共同管理部署設定不正確');
}
console.log('本機檢查通過：測試、建置、程式語法及部署設定。');
