const test = require('node:test');
const assert = require('node:assert/strict');
const Ledger = require('../src/Core.js');
const { Solar } = require('lunar-javascript');

function tx(type, date, amount, category = '', details = '') {
  if (type === 'INCOME' && !category) category = '成員繳款';
  return Object.assign(Ledger.normalize({ type, gregorianDate: date, amount, category, details }, Solar),
    { id: Math.random().toString(), status: 'ACTIVE', createdAt: date, updatedAt: date });
}
test('amounts use integer cents and reject invalid values', () => {
  assert.equal(Ledger.parseAmount('1,250.50'), 125050);
  assert.equal(Ledger.centsText(125050), '1,250.50');
  assert.throws(() => Ledger.parseAmount('0'));
  assert.throws(() => Ledger.parseAmount('12.345'));
  assert.throws(() => Ledger.parseAmount('12abc'));
});
test('missing form data gives a useful error', () => {
  assert.throws(() => Ledger.normalize(undefined, Solar), /記帳網頁|網頁/);
});
test('Gregorian and lunar dates cover leap day and lunar new year', () => {
  assert.equal(Ledger.dateString('2024-2-29'), '2024-02-29');
  assert.throws(() => Ledger.dateString('2025-02-29'));
  assert.equal(Ledger.lunarDate('2024-02-10', Solar), '甲辰年正月初一');
  assert.equal(Ledger.lunarDate('2026-02-17', Solar), '丙午年正月初一');
});
test('income, expense, void and period report reconcile', () => {
  const items = [tx('INCOME', '2026-01-01', '1000'), tx('EXPENSE', '2026-01-20', '200', '活動物資'),
    tx('INCOME', '2026-02-01', '50.25'), tx('EXPENSE', '2026-02-03', '30', '補貼')];
  assert.equal(Ledger.totals(items).balanceCents, 82025);
  const report = Ledger.report(items, '2026-02-01', '2026-02-28');
  assert.equal(report.openingCents, 80000);
  assert.equal(report.closingCents, 82025);
  assert.equal(Ledger.categories(items).find(x => x.code === 'SUBSIDY').amountCents, 3000);
  items[3].status = 'VOID';
  assert.equal(Ledger.totals(items).balanceCents, 85025);
  assert.equal(Ledger.report(items, '2026-02-01', '2026-02-28').closingCents, 85025);
});
test('CSV quotes, category aliases, duplicates and all-row validation', () => {
  const csv = 'externalId,type,gregorianDate,amount,category,details,notes\n'
    + 'A1,EXPENSE,2026-03-01,120,活動物資,"水果,物資",\n'
    + 'A2,INCOME,2026-03-02,200,,捐款,\n';
  const rows = Ledger.csvRows(csv);
  assert.equal(rows[0].details, '水果,物資');
  assert.throws(() => Ledger.csvRows('externalId,type,gregorianDate,amount,category,details,notes\nX,INCOME,2026-01-01'));
  const first = Ledger.prepareImport(rows, [], Solar);
  assert.equal(first.errors.length, 0);
  assert.equal(first.transactions[0].category, 'ACTIVITY_SUPPLIES');
  assert.equal(first.transactions[1].category, 'UNCATEGORIZED_INCOME');
  assert.equal(first.incomeCents - first.expenseCents, 8000);
  const duplicate = Ledger.prepareImport(rows, first.transactions, Solar);
  assert.equal(duplicate.errors.length, 2);
  const invalid = Ledger.prepareImport([{ type: 'EXPENSE', gregorianDate: '2026-03-01', amount: '4', category: '' }], [], Solar);
  assert.equal(invalid.errors[0].row, 2);
  assert.throws(() => Ledger.normalize({ type: 'EXPENSE', gregorianDate: '2026-03-01', amount: '4', category: '__proto__' }, Solar));
});
test('new income requires a selected category while legacy import can stay unclassified', () => {
  assert.throws(() => Ledger.normalize({ type: 'INCOME', gregorianDate: '2026-03-01', amount: '100' }, Solar), /收入須選擇/);
  assert.equal(Ledger.normalize({ type: 'INCOME', gregorianDate: '2026-03-01', amount: '100', category: '捐款' }, Solar).category, 'DONATION');
  assert.equal(Ledger.incomeCategories([{ type: 'INCOME', category: '', amountCents: 10000, status: 'ACTIVE' }]).at(-1).amountCents, 10000);
});
test('date and keyword filtering exclude void records', () => {
  const a = tx('EXPENSE', '2026-04-02', '75', '聚餐', '成員聚餐');
  const b = tx('INCOME', '2026-04-03', '100', '', '成員捐款');
  const c = tx('EXPENSE', '2026-04-04', '5', '其他', '文具'); c.status = 'VOID';
  assert.deepEqual(Ledger.filtered([a, b, c], { start: '2026-04-01', end: '2026-04-30', keyword: '成員' }).map(x => x.id), [b.id, a.id]);
});
test('analytics groups monthly income and expense and excludes void items', () => {
  const a = tx('INCOME', '2026-01-02', '100');
  const b = tx('EXPENSE', '2026-02-03', '20', '聚餐');
  const c = tx('EXPENSE', '2026-02-04', '5', '其他'); c.status = 'VOID';
  const result = Ledger.analytics([a, b, c], '2026-01-01', '2026-03-31');
  assert.equal(result.incomeCents, 10000);
  assert.equal(result.expenseCents, 2000);
  assert.equal(result.closingCents, 8000);
  assert.deepEqual(result.buckets.map(x => [x.key, x.incomeCents, x.expenseCents]), [
    ['2026-01', 10000, 0], ['2026-02', 0, 2000], ['2026-03', 0, 0]
  ]);
  assert.equal(result.expenseCategories.find(x => x.code === 'MEAL').amountCents, 2000);
});
test('spreadsheet text beginning with formula syntax is escaped and restored', () => {
  for (const value of ['=HYPERLINK("x")', '+SUM(1,2)', '-cmd', '@name']) {
    assert.equal(Ledger.sheetRead(Ledger.sheetSafe(value)), value);
  }
});
