/* Small-group fund controls. LedgerMeta is append-only; current state is derived from events. */
var META_HEADERS = ['id', 'kind', 'dataJson', 'at', 'actor'];
var SCHEMA_READY = false;

function ensureAccountingSchema_(ss) {
  if (SCHEMA_READY) return;
  var txSheet = ss.getSheetByName('Transactions');
  var width = Ledger.HEADERS.length;
  if (txSheet.getMaxColumns() < width) txSheet.insertColumnsAfter(txSheet.getMaxColumns(), width - txSheet.getMaxColumns());
  var existing = txSheet.getRange(1, 1, 1, width).getValues()[0];
  Ledger.HEADERS.forEach(function (name, index) {
    if (existing[index] && existing[index] !== name) throw new Error('交易欄位順序與程式版本不符：' + name);
  });
  txSheet.getRange(1, 1, 1, width).setValues([Ledger.HEADERS]);
  var meta = ss.getSheetByName('LedgerMeta');
  if (!meta) {
    meta = ss.insertSheet('LedgerMeta');
    meta.getRange(1, 1, 1, META_HEADERS.length).setValues([META_HEADERS]);
    meta.setFrozenRows(1);
    meta.protect().setDescription('系統會計設定與結帳紀錄').setWarningOnly(true);
    var at = now_();
    meta.getRange(2, 1, 3, META_HEADERS.length).setValues([
      ['CASH', 'ACCOUNT', JSON.stringify({ name: '現金', active: true }), at, '系統'],
      ['BANK', 'ACCOUNT', JSON.stringify({ name: '銀行存款', active: true }), at, '系統'],
      ['GENERAL', 'FUND', JSON.stringify({ name: '一般基金', restricted: false, active: true }), at, '系統']
    ]);
  }
  SCHEMA_READY = true;
}
function metaEvents_() {
  return sheet_('LedgerMeta').getDataRange().getValues().slice(1).filter(function (row) { return row[0]; }).map(function (row) {
    return { id: String(row[0]), kind: String(row[1]), data: JSON.parse(String(row[2] || '{}')),
      at: String(row[3]), actor: String(row[4]) };
  });
}
function appendMeta_(kind, id, data, token) {
  appendRows_(sheet_('LedgerMeta'), [[id, kind, JSON.stringify(data), now_(), actor_(token)]]);
}
function latestMeta_(events, kind) {
  var map = {};
  events.forEach(function (event) {
    if (event.kind === kind) map[event.id] = Object.assign({ id: event.id }, event.data);
  });
  return Object.keys(map).map(function (key) { return map[key]; });
}
function activeClosures_(events) {
  var reopened = new Set(events.filter(function (event) { return event.kind === 'REOPEN'; }).map(function (event) { return event.id; }));
  return events.filter(function (event) { return event.kind === 'CLOSE' && !reopened.has(event.id); })
    .map(function (event) { return Object.assign({ id: event.id, actor: event.actor, at: event.at }, event.data); })
    .sort(function (a, b) { return a.throughDate.localeCompare(b.throughDate); });
}
function closedThrough_() {
  var closures = activeClosures_(metaEvents_());
  return closures.length ? closures[closures.length - 1].throughDate : '';
}
function assertPeriodOpen_(date) {
  var through = closedThrough_();
  if (through && date <= through) throw new Error('此日期已結帳至 ' + through + '；請由主管理人先重新開帳');
}
function requiredText_(value, max, label) {
  var text = String(value == null ? '' : value).trim();
  if (!text || text.length > max) throw new Error(label + '須填寫，最多 ' + max + ' 字');
  return text;
}
function accountById_(id, events) {
  var found = latestMeta_(events || metaEvents_(), 'ACCOUNT').find(function (item) { return item.id === id && item.active; });
  if (!found) throw new Error('請選擇有效的收付款帳戶');
  return found;
}
function fundById_(id, events) {
  var found = latestMeta_(events || metaEvents_(), 'FUND').find(function (item) { return item.id === id && item.active; });
  if (!found) throw new Error('請選擇有效的基金用途');
  return found;
}
function extraFields_(input, existing, normalized) {
  var events = metaEvents_();
  var accountId = String(input.accountId || (existing && existing.accountId) || 'CASH');
  var fundId = String(input.fundId || (existing && existing.fundId) || 'GENERAL');
  accountById_(accountId, events); fundById_(fundId, events);
  var memberId = String(input.memberId || '');
  if (memberId && !latestMeta_(events, 'MEMBER').some(function (item) { return item.id === memberId && item.active; })) throw new Error('成員資料無效');
  return {
    accountId: accountId, fundId: fundId,
    voucherNo: String(input.voucherNo || '').trim().slice(0, 60),
    counterparty: String(input.counterparty || '').trim().slice(0, 100),
    paymentMethod: String(input.paymentMethod || '').trim().slice(0, 40),
    memberId: normalized.type === 'INCOME' ? memberId : '',
    documentUrl: existing ? existing.documentUrl || '' : '',
    reviewStatus: existing ? existing.reviewStatus || 'APPROVED' : (normalized.type === 'EXPENSE' ? 'PENDING' : 'APPROVED'),
    reviewedBy: existing ? existing.reviewedBy || '' : '',
    reviewedAt: existing ? existing.reviewedAt || '' : ''
  };
}
function accountBalance_(accountId, throughDate, items, events) {
  var balance = 0;
  items.forEach(function (tx) {
    if (tx.status === 'VOID' || (throughDate && tx.gregorianDate > throughDate)) return;
    if ((tx.accountId || 'CASH') === accountId) balance += (tx.type === 'INCOME' ? 1 : -1) * Number(tx.amountCents);
  });
  events.forEach(function (event) {
    if (event.kind !== 'TRANSFER' || (throughDate && event.data.date > throughDate)) return;
    if (event.data.fromAccountId === accountId) balance -= Number(event.data.amountCents);
    if (event.data.toAccountId === accountId) balance += Number(event.data.amountCents);
  });
  return balance;
}
function fundBalance_(fundId, items, events) {
  var balance = 0;
  items.forEach(function (tx) {
    if (tx.status !== 'VOID' && (tx.fundId || 'GENERAL') === fundId) balance += (tx.type === 'INCOME' ? 1 : -1) * Number(tx.amountCents);
  });
  events.forEach(function (event) {
    if (event.kind !== 'FUND_TRANSFER') return;
    if (event.data.fromFundId === fundId) balance -= Number(event.data.amountCents);
    if (event.data.toFundId === fundId) balance += Number(event.data.amountCents);
  });
  return balance;
}
function getAccountingData(token) {
  auth_(token);
  var events = metaEvents_(), items = readTransactions_();
  var accounts = latestMeta_(events, 'ACCOUNT').filter(function (item) { return item.active; }).map(function (item) {
    return Object.assign({}, item, { balanceCents: accountBalance_(item.id, '', items, events) });
  });
  var funds = latestMeta_(events, 'FUND').filter(function (item) { return item.active; }).map(function (item) {
    return Object.assign({}, item, { balanceCents: fundBalance_(item.id, items, events) });
  });
  var members = latestMeta_(events, 'MEMBER').filter(function (item) { return item.active; });
  var month = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  var memberDues = members.map(function (member) {
    var paid = items.filter(function (tx) { return tx.status !== 'VOID' && tx.memberId === member.id && tx.category === 'MEMBER_DUES' && tx.gregorianDate.slice(0, 7) === month; })
      .reduce(function (sum, tx) { return sum + Number(tx.amountCents); }, 0);
    return { id: member.id, name: member.name, dueCents: member.dueCents, paidCents: paid, balanceCents: member.dueCents - paid };
  });
  var budgets = latestMeta_(events, 'BUDGET').filter(function (item) { return item.active; }).map(function (item) {
    var actual = items.filter(function (tx) { return tx.status !== 'VOID' && tx.type === 'EXPENSE' &&
      tx.gregorianDate >= item.start && tx.gregorianDate <= item.end && (tx.fundId || 'GENERAL') === item.fundId && tx.category === item.category; })
      .reduce(function (sum, tx) { return sum + Number(tx.amountCents); }, 0);
    return Object.assign({}, item, { actualCents: actual, remainingCents: item.amountCents - actual });
  });
  var reconciliations = events.filter(function (event) { return event.kind === 'RECONCILE'; }).slice(-20).reverse().map(function (event) {
    return Object.assign({ id: event.id, actor: event.actor, at: event.at }, event.data);
  });
  return { accounts: accounts, funds: funds, members: members, memberDues: memberDues, budgets: budgets,
    reconciliations: reconciliations, closures: activeClosures_(events), month: month,
    pending: items.filter(function (tx) { return tx.status !== 'VOID' && tx.reviewStatus === 'PENDING'; })
      .map(function (tx) { return { id: tx.id, gregorianDate: tx.gregorianDate, amountCents: tx.amountCents,
        details: tx.details, createdBy: tx.createdBy, submittedBy: tx.submittedBy || tx.createdBy }; }) };
}
function createAccount(token, name) {
  auth_(token, 'OWNER');
  name = requiredText_(name, 40, '帳戶名稱');
  var id = id_(); appendMeta_('ACCOUNT', id, { name: name, active: true }, token);
  return { id: id, name: name };
}
function createFund(token, name, restricted) {
  auth_(token, 'OWNER');
  name = requiredText_(name, 40, '基金名稱');
  var id = id_(); appendMeta_('FUND', id, { name: name, restricted: restricted === true, active: true }, token);
  return { id: id, name: name };
}
function createMember(token, name, monthlyDue) {
  auth_(token, 'OWNER');
  name = requiredText_(name, 50, '成員姓名');
  var dueCents = monthlyDue === '' || monthlyDue == null ? 0 : Ledger.parseAmount(monthlyDue);
  var id = id_(); appendMeta_('MEMBER', id, { name: name, dueCents: dueCents, active: true }, token);
  return { id: id, name: name, dueCents: dueCents };
}
function setBudget(token, input) {
  auth_(token, 'OWNER');
  if (!input || typeof input !== 'object') throw new Error('缺少預算資料');
  var start = Ledger.dateString(input.start), end = Ledger.dateString(input.end);
  if (start > end) throw new Error('預算起日不可晚於迄日');
  fundById_(String(input.fundId || 'GENERAL'));
  if (!Ledger.CATEGORY_NAMES[input.category]) throw new Error('請選擇支出分類');
  var amountCents = Ledger.parseAmount(input.amount);
  var id = id_(); appendMeta_('BUDGET', id, { start: start, end: end, fundId: input.fundId || 'GENERAL',
    category: input.category, amountCents: amountCents, active: true }, token);
  return { id: id, amountCents: amountCents };
}
function recordTransfer(token, input) {
  auth_(token);
  if (!input || typeof input !== 'object') throw new Error('缺少轉帳資料');
  return lock_(function () {
    var date = Ledger.dateString(input.date), from = String(input.fromAccountId), to = String(input.toAccountId);
    assertPeriodOpen_(date);
    if (from === to) throw new Error('轉出與轉入帳戶不可相同');
    var events = metaEvents_(), items = readTransactions_();
    accountById_(from, events); accountById_(to, events);
    var amountCents = Ledger.parseAmount(input.amount);
    if (accountBalance_(from, date, items, events) < amountCents) throw new Error('轉出帳戶帳面餘額不足');
    var id = id_(); appendMeta_('TRANSFER', id, { date: date, fromAccountId: from, toAccountId: to,
      amountCents: amountCents, details: String(input.details || '').trim().slice(0, 200) }, token);
    return { id: id, amountCents: amountCents };
  });
}
function transferFund(token, input) {
  auth_(token, 'OWNER');
  if (!input || typeof input !== 'object') throw new Error('缺少基金調撥資料');
  return lock_(function () {
    var date = Ledger.dateString(input.date), from = String(input.fromFundId), to = String(input.toFundId);
    assertPeriodOpen_(date);
    if (from === to) throw new Error('來源與目的基金不可相同');
    var events = metaEvents_(), items = readTransactions_(); fundById_(from, events); fundById_(to, events);
    var amountCents = Ledger.parseAmount(input.amount);
    if (fundBalance_(from, items, events) < amountCents) throw new Error('來源基金餘額不足');
    var reason = requiredText_(input.reason, 200, '調撥原因');
    var id = id_(); appendMeta_('FUND_TRANSFER', id, { date: date, fromFundId: from, toFundId: to,
      amountCents: amountCents, reason: reason }, token);
    return { id: id, amountCents: amountCents };
  });
}
function reconcileAccount(token, input) {
  auth_(token);
  if (!input || typeof input !== 'object') throw new Error('缺少對帳資料');
  return lock_(function () {
    var accountId = String(input.accountId), date = Ledger.dateString(input.date);
    accountById_(accountId);
    var actualCents = Ledger.parseSignedAmount(input.actualBalance);
    var bookCents = accountBalance_(accountId, date, readTransactions_(), metaEvents_());
    var id = id_(); appendMeta_('RECONCILE', id, { accountId: accountId, date: date, actualCents: actualCents,
      bookCents: bookCents, differenceCents: actualCents - bookCents,
      note: String(input.note || '').trim().slice(0, 200) }, token);
    return { id: id, bookCents: bookCents, actualCents: actualCents, differenceCents: actualCents - bookCents };
  });
}
function closePeriod(token, throughDate) {
  auth_(token, 'OWNER');
  return lock_(function () {
    var date = Ledger.dateString(throughDate), events = metaEvents_(), items = readTransactions_();
    assertPeriodOpen_(date);
    if (items.some(function (tx) { return tx.status !== 'VOID' && tx.reviewStatus === 'PENDING' && tx.gregorianDate <= date; })) {
      throw new Error('仍有待覆核支出，不可結帳');
    }
    var accounts = latestMeta_(events, 'ACCOUNT').filter(function (item) { return item.active; });
    accounts.forEach(function (account) {
      var reconciled = events.some(function (event) { return event.kind === 'RECONCILE' && event.data.accountId === account.id &&
        event.data.date === date && event.data.differenceCents === 0 &&
        event.data.bookCents === accountBalance_(account.id, date, items, events); });
      if (!reconciled) throw new Error(account.name + '尚未在 ' + date + ' 完成零差異對帳');
    });
    var totals = Ledger.totals(items.filter(function (tx) { return tx.gregorianDate <= date; }));
    var id = id_(); appendMeta_('CLOSE', id, { throughDate: date, totals: totals }, token);
    return { id: id, throughDate: date, totals: totals };
  });
}
function reopenPeriod(token, closeId, reason) {
  auth_(token, 'OWNER');
  return lock_(function () {
    var closures = activeClosures_(metaEvents_());
    if (!closures.length || closures[closures.length - 1].id !== closeId) throw new Error('只能重新開啟最近一期結帳');
    reason = requiredText_(reason, 200, '重新開帳原因');
    appendMeta_('REOPEN', closeId, { reason: reason }, token);
    return { reopened: closeId };
  });
}
