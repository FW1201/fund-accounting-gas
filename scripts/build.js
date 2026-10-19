const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
const manual = path.join(root, 'install');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(manual, { recursive: true });
const license = fs.readFileSync(path.join(root, 'node_modules/lunar-javascript/LICENSE'), 'utf8');
const lunar = fs.readFileSync(path.join(root, 'node_modules/lunar-javascript/lunar.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'src/Core.js'), 'utf8');
const authSeed = fs.readFileSync(path.join(root, 'src/AuthSeed.js'), 'utf8');
const auth = fs.readFileSync(path.join(root, 'src/Auth.js'), 'utf8');
const accounting = fs.readFileSync(path.join(root, 'src/Accounting.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/Server.js'), 'utf8');
fs.writeFileSync(path.join(out, 'Code.gs'), `/* lunar-javascript 1.7.7 MIT license\n${license}\n*/\n${lunar}\n${core}\n${authSeed}\n${auth}\n${accounting}\n${server}`);
fs.copyFileSync(path.join(root, 'src/Index.html'), path.join(out, 'Index.html'));
fs.copyFileSync(path.join(root, 'src/appsscript.json'), path.join(out, 'appsscript.json'));
for (const name of ['Code.gs', 'Index.html', 'appsscript.json']) {
  fs.copyFileSync(path.join(out, name), path.join(manual, name));
}
console.log('Built dist/ for Google Apps Script');
