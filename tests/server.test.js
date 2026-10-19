const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const Ledger = require('../src/Core.js');
const { Solar } = require('lunar-javascript');

function mockServer() {
  const password = 'test-long-secure-password-1234';
  const coPassword = 'second-long-secure-password-5678';
  const cache = new Map(), props = new Map([['LEDGER_SPREADSHEET_ID', 'test-id']]);
  const users = [['owner', '主管理人', 'OWNER', password], ['coadmin', '共同管理人', 'MANAGER', coPassword]].map(([username, label, role, secret]) => {
    const salt = username + '-salt';
    return { username, label, role, enabled: true, salt, hash: crypto.createHash('sha256').update(salt + '\0' + secret).digest('hex') };
  });
  function makeSheet(header) {
    const rows = [header.slice()]; let maxColumns = Math.max(header.length, 12);
    const sheet = {
      rows, failNextWrite: false,
      getDataRange() { return { getValues: () => rows.map(row => row.slice()) }; },
      getLastRow() { return rows.length; },
      getLastColumn() { return Math.max(...rows.map(row => row.length)); },
      getMaxColumns() { return maxColumns; },
      insertColumnsAfter(_, count) { maxColumns += count; },
      setFrozenRows() {}, protect() { return { setDescription() { return this; }, setWarningOnly() { return this; } }; },
      getRange(row, col, count = 1, width = 1) {
        return {
          getValues() { return Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => (rows[row - 1 + i] || [])[col - 1 + j] || '')); },
          setValues(values) { if (sheet.failNextWrite) { sheet.failNextWrite = false; throw new Error('模擬寫入失敗'); } values.forEach((value, i) => { const existing = rows[row - 1 + i] || []; value.forEach((cell, j) => { existing[col - 1 + j] = cell; }); rows[row - 1 + i] = existing; }); }
        };
      },
      deleteRow(row) { rows.splice(row - 1, 1); },
      deleteRows(row, count) { rows.splice(row - 1, count); }
    };
    return sheet;
  }
  const sheets = { Transactions: makeSheet(Ledger.HEADERS), AuditLog: makeSheet(Ledger.AUDIT_HEADERS), Imports: makeSheet(Ledger.IMPORT_HEADERS) };
  const spreadsheet = { getSheetByName: name => sheets[name], insertSheet(name) { sheets[name] = makeSheet([]); return sheets[name]; } };
  const context = vm.createContext({
    Ledger, Solar, AUTH_SEED_USERS: users,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => props.get(key), setProperty: (key, value) => props.set(key, value), deleteProperty: key => props.delete(key), setProperties: values => Object.entries(values).forEach(([key, value]) => props.set(key, value)) }) },
    CacheService: { getScriptCache: () => ({ get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key) }) },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => 'admin@example.com' }) },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Utilities: { getUuid: () => crypto.randomUUID(), formatDate: (_, __, format) => format === 'yyyy-MM' ? '2026-10' : '2026-10-18T12:00:00+08:00',
      Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()],
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url') }
  });
  for (const filename of ['Auth.js', 'Accounting.js', 'Server.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', filename), 'utf8'), context);
  }
  const owner = context.login('owner', password).token;
  const coadmin = context.login('coadmin', coPassword).token;
  return { context, sheets, owner, coadmin, password, coPassword };
}

test('login protects data and permits owner to control co-manager', () => {
  const { context, owner, coadmin, password } = mockServer();
  assert.throws(() => context.getAppData(), /請先登入/);
  assert.equal(context.getAppData(owner).viewer.username, 'owner');
  assert.equal(context.getAppData(coadmin).viewer.username, 'coadmin');
  assert.throws(() => context.listUsers(coadmin), /主管理人/);
  context.setUserEnabled(owner, 'coadmin', false);
  assert.throws(() => context.getAppData(coadmin), /登入已失效/);
  context.changePassword(owner, password, 'new-owner-password-very-long');
  assert.throws(() => context.getAppData(owner), /登入已到期|登入已失效/);
  assert.equal(context.login('owner', 'new-owner-password-very-long').user.username, 'owner');
});

test('create, independent approval, edit and void keep totals and audit aligned', () => {
  const { context, sheets, owner, coadmin } = mockServer();
  assert.throws(() => context.getLunarDate(owner), /編輯器直接執行/);
  assert.throws(() => context.saveTransaction(owner), /記帳網頁/);
  const created = context.saveTransaction(owner, { type: 'EXPENSE', gregorianDate: '2026-01-01', amount: '100.25', category: 'GIFTS', details: '水果' });
  assert.equal(created.reviewStatus, 'PENDING');
  assert.throws(() => context.reviewTransaction(owner, created.id, true), /另一位/);
  context.reviewTransaction(coadmin, created.id, true);
  assert.equal(context.getAppData(owner).totals.balanceCents, -10025);
  context.saveTransaction(owner, { id: created.id, type: 'EXPENSE', gregorianDate: '2026-01-01', amount: '120.25', category: 'GIFTS', details: '水果', reason: '收據更正' });
  assert.equal(context.getAppData(owner).totals.balanceCents, -12025);
  assert.throws(() => context.saveTransaction(owner, { id: created.id, type: 'EXPENSE', gregorianDate: '2026-01-01', amount: '90', category: 'GIFTS' }), /原因/);
  context.voidTransaction(owner, created.id, '重複輸入');
  assert.equal(context.getAppData(owner).totals.balanceCents, 0);
  assert.deepEqual(sheets.AuditLog.rows.slice(1).map(row => row[2]), ['CREATE', 'APPROVE', 'EDIT', 'VOID']);
  assert.equal(sheets.AuditLog.rows[1][7], 'owner');
  assert.equal(sheets.AuditLog.rows[2][7], 'coadmin');
});

test('import commits only when all rows and reconciled balance pass', () => {
  const { context, sheets, owner } = mockServer();
  const source = { kind: 'csv', csv: 'externalId,type,gregorianDate,amount,category,details,notes\n'
    + '01,INCOME,2026-01-01,1000,,成員捐款,\n'
    + '02,EXPENSE,2026-01-02,200,活動物資,物資,\n' };
  assert.equal(context.previewImport(owner, source, '800').reconciled, true);
  assert.throws(() => context.commitImport(owner, source, '700', true), /核定餘額/);
  assert.equal(sheets.Transactions.rows.length, 1);
  const result = context.commitImport(owner, source, '800', true);
  assert.equal(result.count, 2);
  assert.equal(context.getAppData(owner).totals.balanceCents, 80000);
  assert.equal(sheets.Imports.rows.length, 2);
  assert.equal(context.previewImport(owner, source, '800').errors.length, 2);
});

test('failed final import write rolls back every sheet', () => {
  const { context, sheets, owner } = mockServer();
  const source = { kind: 'csv', csv: 'externalId,type,gregorianDate,amount,category,details,notes\n01,INCOME,2026-01-01,100,,捐款,\n' };
  sheets.Imports.failNextWrite = true;
  assert.throws(() => context.commitImport(owner, source, '100', true), /模擬寫入失敗/);
  assert.equal(sheets.Transactions.rows.length, 1);
  assert.equal(sheets.AuditLog.rows.length, 1);
  assert.equal(sheets.Imports.rows.length, 1);
});

test('account transfers preserve total, reconciliation and close lock the period', () => {
  const { context, owner, coadmin } = mockServer();
  context.saveTransaction(owner, { type: 'INCOME', gregorianDate: '2026-01-01', amount: '1000', category: 'DONATION' });
  context.recordTransfer(owner, { date: '2026-01-02', fromAccountId: 'CASH', toAccountId: 'BANK', amount: '300' });
  const data = context.getAccountingData(owner);
  assert.equal(data.accounts.find(item => item.id === 'CASH').balanceCents, 70000);
  assert.equal(data.accounts.find(item => item.id === 'BANK').balanceCents, 30000);
  assert.equal(context.getAppData(owner).totals.balanceCents, 100000);
  context.reconcileAccount(coadmin, { accountId: 'CASH', date: '2026-01-31', actualBalance: '700' });
  context.reconcileAccount(coadmin, { accountId: 'BANK', date: '2026-01-31', actualBalance: '300' });
  context.closePeriod(owner, '2026-01-31');
  assert.throws(() => context.saveTransaction(owner, { type: 'INCOME', gregorianDate: '2026-01-15', amount: '1', category: 'DONATION' }), /已結帳/);
});

test('fresh public install hashes bootstrap passwords and removes plaintext properties', () => {
  const ownerPassword = 'sample-owner-password-123456789';
  const managerPassword = 'sample-manager-password-987654321';
  const props = new Map([
    ['BOOTSTRAP_OWNER_PASSWORD', ownerPassword],
    ['BOOTSTRAP_MANAGER_PASSWORD', managerPassword]
  ]);
  const cache = new Map();
  const context = vm.createContext({
    AUTH_SEED_USERS: [],
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props.get(key),
      setProperty: (key, value) => props.set(key, value),
      deleteProperty: key => props.delete(key)
    }) },
    CacheService: { getScriptCache: () => ({
      get: key => cache.get(key), put: (key, value) => cache.set(key, value), remove: key => cache.delete(key)
    }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()]
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/Auth.js'), 'utf8'), context);
  assert.equal(context.login('owner', ownerPassword).user.role, 'OWNER');
  assert.equal(context.login('coadmin', managerPassword).user.role, 'MANAGER');
  assert.equal(props.has('BOOTSTRAP_OWNER_PASSWORD'), false);
  assert.equal(props.has('BOOTSTRAP_MANAGER_PASSWORD'), false);
  assert.equal(JSON.stringify(props.get('LEDGER_USERS_V1')).includes(ownerPassword), false);
  assert.equal(JSON.stringify(props.get('LEDGER_USERS_V1')).includes(managerPassword), false);
});
