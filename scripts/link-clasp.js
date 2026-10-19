const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2] || '';
const match = input.match(/^https:\/\/script\.google\.com\/(?:home\/projects|d)\/([A-Za-z0-9_-]+)(?:\/|$)/);
const scriptId = match ? match[1] : input;
if (!/^[A-Za-z0-9_-]{20,}$/.test(scriptId)) {
  console.error('請提供 Apps Script 專案網址或 Script ID：npm run clasp:link -- <網址或 ID>');
  process.exit(1);
}
const configPath = path.resolve(__dirname, '..', '.clasp.json');
if (fs.existsSync(configPath)) {
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (current.scriptId !== scriptId) {
    console.error('此資料夾已連結其他 Apps Script 專案；請先核對 .clasp.json。');
    process.exit(1);
  }
  console.log('Clasp 已連結此專案。');
} else {
  fs.writeFileSync(configPath, JSON.stringify({ scriptId, rootDir: 'dist' }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('已建立 .clasp.json，Clasp 將使用 dist/ 內的部署檔案。');
}
