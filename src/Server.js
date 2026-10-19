/* Apps Script server. Public RPCs require an app session before reading or writing ledger data. */
var LEDGER_FILE_KEY = 'LEDGER_SPREADSHEET_ID';
var BACKUP_FOLDER_KEY = 'LEDGER_BACKUP_FOLDER_ID';

// 網頁可由持有連結者開啟，但每個資料 RPC 都須驗證應用程式帳號的 session。
// 執行身分為部署者時，ActiveUser 電郵可能為空，不可用它區分管理者。
function spreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty(LEDGER_FILE_KEY);
  if (!id) throw new Error('系統尚未初始化。請以主管理人登入後執行 setupProject。');
  var ss = SpreadsheetApp.openById(id);
  ensureAccountingSchema_(ss);
  return ss;
}
function sheet_(name) {
  var sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('缺少資料工作表：' + name);
  return sheet;
}
function lock_(work) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return work(); } finally { lock.releaseLock(); }
}
function now_() { return Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function id_() { return Utilities.getUuid(); }
function actor_(token) { return token ? auth_(token).username : '系統'; }
function reason_(value) {
  var reason = String(value || '').trim();
  if (!reason) throw new Error('請填寫更正或作廢原因');
  if (reason.length > 200) throw new Error('原因不可超過 200 字');
  return reason;
}
function headers_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#173d38').setFontColor('#ffffff');
  sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).setNumberFormat('@');
  var protection = sheet.protect().setDescription('僅供系統寫入；請勿直接修改');
  protection.setWarningOnly(true);
}
function setupProject(token) {
  auth_(token, 'OWNER');
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(LEDGER_FILE_KEY)) throw new Error('系統已初始化；請勿再次建立資料庫');
  var email = Session.getEffectiveUser().getEmail();
  if (!email) throw new Error('無法取得管理者 Google 帳號');
  var ss = SpreadsheetApp.create('基金帳務帳本');
  ss.setSpreadsheetTimeZone('Asia/Taipei');
  ss.getSheets()[0].setName('Transactions');
  headers_(ss.getSheetByName('Transactions'), Ledger.HEADERS);
  headers_(ss.insertSheet('AuditLog'), Ledger.AUDIT_HEADERS);
  headers_(ss.insertSheet('Imports'), Ledger.IMPORT_HEADERS);
  var folder = DriveApp.createFolder('基金帳務帳本備份');
  props.setProperties({ ADMIN_EMAIL: email, LEDGER_SPREADSHEET_ID: ss.getId(),
    LEDGER_BACKUP_FOLDER_ID: folder.getId() }, false);
  installBackupTrigger_();
  var result = { spreadsheetUrl: ss.getUrl(), backupFolderUrl: folder.getUrl(), adminEmail: email };
  Logger.log(JSON.stringify(result));
  return result;
}
function readTransactions_() {
  return readTransactionsFrom_(spreadsheet_());
}
function readTransactionsFrom_(ss) {
  var values = ss.getSheetByName('Transactions').getDataRange().getValues();
  return values.slice(1).filter(function (row) { return row[0]; }).map(function (row) {
    var tx = {};
    Ledger.HEADERS.forEach(function (header, i) { tx[header] = row[i]; });
    tx.amountCents = Number(tx.amountCents);
    tx.details = Ledger.sheetRead(String(tx.details || ''));
    tx.notes = Ledger.sheetRead(String(tx.notes || ''));
    tx.sourceKey = Ledger.sheetRead(String(tx.sourceKey || ''));
    tx.voucherNo = Ledger.sheetRead(String(tx.voucherNo || ''));
    tx.counterparty = Ledger.sheetRead(String(tx.counterparty || ''));
    tx.accountId = tx.accountId || 'CASH';
    tx.fundId = tx.fundId || 'GENERAL';
    tx.reviewStatus = tx.reviewStatus || 'APPROVED';
    return tx;
  });
}
function transactionRow_(tx) {
  return Ledger.HEADERS.map(function (header) {
    var value = tx[header] == null ? '' : tx[header];
    return (header === 'details' || header === 'notes' || header === 'sourceKey' || header === 'voucherNo' ||
      header === 'counterparty') ? Ledger.sheetSafe(String(value)) : String(value);
  });
}
function auditRow_(action, before, after, reason, token) {
  return [id_(), (after || before).id, action, Ledger.sheetSafe(String(reason || '')),
    before ? JSON.stringify(before) : '', after ? JSON.stringify(after) : '', now_(), actor_(token)];
}
function appendRows_(sheet, rows) {
  if (!rows.length) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}
function restoreOnAuditFailure_(txSheet, rowNumber, oldRow, wasNew) {
  if (wasNew) txSheet.deleteRow(rowNumber);
  else txSheet.getRange(rowNumber, 1, 1, oldRow.length).setValues([oldRow]);
}
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('基金帳務管理系統').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function getAppData(token) {
  var me = auth_(token);
  var items = readTransactions_();
  var active = Ledger.filtered(items, {});
  return { transactions: items, totals: Ledger.totals(items),
    latest: active.slice(0, 5), categories: Ledger.categories(items),
    analytics: Ledger.analytics(items, '', ''),
    categoryOptions: Ledger.CATEGORIES, incomeCategoryOptions: Ledger.INCOME_CATEGORIES,
    legacyIncomeCategory: Ledger.LEGACY_INCOME, viewerLabel: me.label, viewer: authPublicUser_(me) };
}
function getAnalytics(token, start, end) { auth_(token); return Ledger.analytics(readTransactions_(), start || '', end || ''); }
function getLunarDate(token, gregorianDate) {
  auth_(token);
  if (!gregorianDate) throw new Error('缺少日期；此函式由記帳網頁自動呼叫，請勿在編輯器直接執行');
  return Ledger.lunarDate(gregorianDate, Solar);
}
function saveTransaction(token, input) {
  auth_(token);
  if (!input || typeof input !== 'object') throw new Error('缺少收支表單資料；請從已部署的記帳網頁新增紀錄');
  return lock_(function () {
    var normalized = Ledger.normalize(input, Solar);
    assertPeriodOpen_(normalized.gregorianDate);
    var items = readTransactions_();
    var existing = input.id ? items.find(function (t) { return t.id === input.id; }) : null;
    if (input.id && !existing) throw new Error('找不到要更正的紀錄');
    if (existing && existing.status === 'VOID') throw new Error('作廢紀錄不可更正');
    if (existing) assertPeriodOpen_(existing.gregorianDate);
    var reason = existing ? reason_(input.reason) : '';
    var extras = extraFields_(input, existing, normalized);
    var tx = Object.assign({}, existing || {}, normalized, extras, {
      id: existing ? existing.id : id_(), status: 'ACTIVE',
      createdAt: existing ? existing.createdAt : now_(), updatedAt: now_(),
      sourceKey: existing ? existing.sourceKey : '', createdBy: existing ? existing.createdBy : actor_(token),
      submittedBy: actor_(token)
    });
    if (existing && tx.type === 'EXPENSE') { tx.reviewStatus = 'PENDING'; tx.reviewedBy = ''; tx.reviewedAt = ''; }
    if (tx.type === 'INCOME') { tx.reviewStatus = 'APPROVED'; tx.reviewedBy = ''; tx.reviewedAt = ''; }
    var txSheet = sheet_('Transactions');
    var rowNumber = existing ? items.findIndex(function (t) { return t.id === existing.id; }) + 2 : txSheet.getLastRow() + 1;
    var oldRow = existing ? txSheet.getRange(rowNumber, 1, 1, Ledger.HEADERS.length).getValues()[0] : null;
    var newRow = transactionRow_(tx);
    txSheet.getRange(rowNumber, 1, 1, newRow.length).setValues([newRow]);
    try { appendRows_(sheet_('AuditLog'), [auditRow_(existing ? 'EDIT' : 'CREATE', existing, tx, reason, token)]); }
    catch (e) { restoreOnAuditFailure_(txSheet, rowNumber, oldRow, !existing); throw e; }
    return tx;
  });
}
function voidTransaction(token, transactionId, reason) {
  auth_(token);
  return lock_(function () {
    reason = reason_(reason);
    var items = readTransactions_();
    var index = items.findIndex(function (t) { return t.id === transactionId; });
    if (index < 0) throw new Error('找不到要作廢的紀錄');
    var before = items[index];
    if (before.status === 'VOID') throw new Error('此紀錄已作廢');
    assertPeriodOpen_(before.gregorianDate);
    var after = Object.assign({}, before, { status: 'VOID', updatedAt: now_() });
    var txSheet = sheet_('Transactions'), rowNumber = index + 2;
    var oldRow = txSheet.getRange(rowNumber, 1, 1, Ledger.HEADERS.length).getValues()[0];
    txSheet.getRange(rowNumber, 1, 1, Ledger.HEADERS.length).setValues([transactionRow_(after)]);
    try { appendRows_(sheet_('AuditLog'), [auditRow_('VOID', before, after, reason, token)]); }
    catch (e) { restoreOnAuditFailure_(txSheet, rowNumber, oldRow, false); throw e; }
    return after;
  });
}
function reviewTransaction(token, transactionId, approved, reason) {
  var reviewer = auth_(token);
  return lock_(function () {
    var items = readTransactions_();
    var index = items.findIndex(function (tx) { return tx.id === transactionId; });
    if (index < 0) throw new Error('找不到支出紀錄');
    var before = items[index];
    if (before.type !== 'EXPENSE' || before.status === 'VOID' || before.reviewStatus !== 'PENDING') throw new Error('此筆不在待覆核狀態');
    if ((before.submittedBy || before.createdBy) === reviewer.username) throw new Error('支出須由另一位管理人覆核');
    assertPeriodOpen_(before.gregorianDate);
    var explanation = approved === true ? '' : reason_(reason);
    var after = Object.assign({}, before, { reviewStatus: approved === true ? 'APPROVED' : 'REJECTED',
      status: approved === true ? 'ACTIVE' : 'VOID', reviewedBy: reviewer.username,
      reviewedAt: now_(), updatedAt: now_() });
    var sheet = sheet_('Transactions'), rowNumber = index + 2;
    var oldRow = sheet.getRange(rowNumber, 1, 1, Ledger.HEADERS.length).getValues()[0];
    sheet.getRange(rowNumber, 1, 1, Ledger.HEADERS.length).setValues([transactionRow_(after)]);
    try { appendRows_(sheet_('AuditLog'), [auditRow_(approved === true ? 'APPROVE' : 'REJECT', before, after, explanation, token)]); }
    catch (error) { restoreOnAuditFailure_(sheet, rowNumber, oldRow, false); throw error; }
    return after;
  });
}
function receiptFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('LEDGER_RECEIPTS_FOLDER_ID');
  if (!folderId) {
    var folder = DriveApp.createFolder('基金帳務交易憑證');
    folderId = folder.getId();
    props.setProperty('LEDGER_RECEIPTS_FOLDER_ID', folderId);
  }
  return DriveApp.getFolderById(folderId);
}
function uploadVoucher(token, transactionId, filename, mimeType, base64) {
  auth_(token);
  var allowed = { 'application/pdf': true, 'image/jpeg': true, 'image/png': true };
  if (!allowed[mimeType]) throw new Error('憑證只支援 PDF、JPG 或 PNG');
  filename = String(filename || '').replace(/[^\w\u4e00-\u9fff. -]/g, '_').slice(0, 80);
  if (!filename || typeof base64 !== 'string' || base64.length > 7000000) throw new Error('憑證檔案不可超過 5 MB');
  var bytes = Utilities.base64Decode(base64);
  if (bytes.length > 5000000) throw new Error('憑證檔案不可超過 5 MB');
  return lock_(function () {
    var items = readTransactions_(), index = items.findIndex(function (tx) { return tx.id === transactionId; });
    if (index < 0 || items[index].status === 'VOID') throw new Error('找不到有效交易');
    assertPeriodOpen_(items[index].gregorianDate);
    var file = receiptFolder_().createFile(Utilities.newBlob(bytes, mimeType, transactionId + '-' + filename));
    var before = items[index], after = Object.assign({}, before, { documentUrl: file.getId(), updatedAt: now_() });
    var sheet = sheet_('Transactions'), rowNumber = index + 2;
    var oldRow = sheet.getRange(rowNumber, 1, 1, Ledger.HEADERS.length).getValues()[0];
    try {
      sheet.getRange(rowNumber, 1, 1, Ledger.HEADERS.length).setValues([transactionRow_(after)]);
      appendRows_(sheet_('AuditLog'), [auditRow_('ATTACH', before, after, filename, token)]);
    } catch (error) { restoreOnAuditFailure_(sheet, rowNumber, oldRow, false); file.setTrashed(true); throw error; }
    return { attached: true, name: filename };
  });
}
function readVoucher(token, transactionId) {
  auth_(token);
  var tx = readTransactions_().find(function (item) { return item.id === transactionId; });
  if (!tx || !tx.documentUrl) throw new Error('此筆沒有憑證附件');
  var blob = DriveApp.getFileById(tx.documentUrl).getBlob();
  return { name: blob.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}
function exportLedgerData(token) {
  auth_(token, 'OWNER');
  var ss = spreadsheet_();
  var sheets = {};
  ['Transactions', 'AuditLog', 'Imports', 'LedgerMeta'].forEach(function (name) {
    sheets[name] = ss.getSheetByName(name).getDataRange().getValues();
  });
  return { exportedAt: now_(), spreadsheetId: ss.getId(), sheets: sheets,
    note: '憑證原檔存於「基金帳務交易憑證」資料夾，請另行下載。' };
}
function importRows_(source) {
  if (!source || typeof source !== 'object') throw new Error('缺少匯入來源');
  if (source.kind === 'csv') return Ledger.csvRows(source.csv || '');
  if (source.kind === 'sheet') {
    var match = /(?:\/d\/|^)([a-zA-Z0-9_-]{20,})/.exec(String(source.sheetId || ''));
    if (!match) throw new Error('請輸入有效的 Google 試算表網址或 ID');
    var data = SpreadsheetApp.openById(match[1]).getSheets()[0].getDataRange().getDisplayValues();
    if (data.length > 1001) throw new Error('每次最多匯入 1000 筆');
    var header = data.shift();
    if (Ledger.CSV_HEADERS.some(function (name) { return header.indexOf(name) === -1; })) throw new Error('匯入欄位不符合範本');
    return data.filter(function (r) { return r.some(Boolean); }).map(function (r) {
      var item = {}; Ledger.CSV_HEADERS.forEach(function (name) { item[name] = r[header.indexOf(name)] || ''; }); return item;
    });
  }
  throw new Error('不支援的匯入來源');
}
function importSummary_(source, expectedBalance) {
  var raw = importRows_(source);
  var result = Ledger.prepareImport(raw, readTransactions_(), Solar);
  var current = Ledger.totals(readTransactions_()).balanceCents;
  var projected = current + result.incomeCents - result.expenseCents;
  var expected = expectedBalance == null || String(expectedBalance).trim() === '' ? null : Ledger.parseSignedAmount(expectedBalance);
  return { rows: result.transactions, errors: result.errors, count: result.count,
    incomeCents: result.incomeCents, expenseCents: result.expenseCents,
    currentBalanceCents: current, projectedBalanceCents: projected,
    expectedBalanceCents: expected, reconciled: expected !== null && expected === projected };
}
function previewImport(token, source, expectedBalance) {
  auth_(token);
  var result = importSummary_(source, expectedBalance);
  delete result.rows;
  return result;
}
function commitImport(token, source, expectedBalance, confirmed) {
  auth_(token);
  if (confirmed !== true) throw new Error('請先確認匯入預覽');
  return lock_(function () {
    var summary = importSummary_(source, expectedBalance);
    if (summary.errors.length) throw new Error('仍有重複或格式錯誤資料，請先修正');
    if (!summary.count) throw new Error('沒有可匯入資料');
    if (!summary.reconciled) throw new Error('預計餘額與原始帳本核定餘額不符');
    summary.rows.forEach(function (tx) { assertPeriodOpen_(tx.gregorianDate); });
    var txSheet = sheet_('Transactions'), auditSheet = sheet_('AuditLog'), importSheet = sheet_('Imports');
    var txStart = txSheet.getLastRow() + 1, auditStart = auditSheet.getLastRow() + 1,
      importStart = importSheet.getLastRow() + 1;
    var batchId = id_(), at = now_();
    var transactions = summary.rows.map(function (item) {
      return Object.assign({}, item, { id: id_(), status: 'ACTIVE', createdAt: at, updatedAt: at,
        accountId: 'CASH', fundId: 'GENERAL', reviewStatus: 'APPROVED', createdBy: actor_(token), submittedBy: actor_(token) });
    });
    try {
      appendRows_(txSheet, transactions.map(transactionRow_));
      appendRows_(auditSheet, transactions.map(function (t) { return auditRow_('IMPORT', null, t, '批次 ' + batchId, token); }));
      appendRows_(importSheet, [[batchId, Utilities.base64EncodeWebSafe(Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256, JSON.stringify(summary.rows))), summary.count,
        summary.incomeCents, summary.expenseCents, at]]);
    } catch (e) {
      if (txSheet.getLastRow() >= txStart) txSheet.deleteRows(txStart, txSheet.getLastRow() - txStart + 1);
      if (auditSheet.getLastRow() >= auditStart) auditSheet.deleteRows(auditStart, auditSheet.getLastRow() - auditStart + 1);
      if (importSheet.getLastRow() >= importStart) importSheet.deleteRows(importStart, importSheet.getLastRow() - importStart + 1);
      throw e;
    }
    return { batchId: batchId, count: summary.count, closingBalanceCents: summary.projectedBalanceCents };
  });
}
function installBackupTrigger_( ) {
  var existing = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runDailyBackup'; });
  if (!existing) ScriptApp.newTrigger('runDailyBackup').timeBased().everyDays(1).atHour(2).create();
  return { installed: true };
}
function installBackupTrigger(token) { auth_(token, 'OWNER'); return installBackupTrigger_(); }
function runDailyBackup(event) {
  var valid = event && event.triggerUid && ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === 'runDailyBackup' && trigger.getUniqueId() === event.triggerUid;
  });
  if (!valid) throw new Error('此函式僅供排程觸發');
  var file = DriveApp.getFileById(spreadsheet_().getId());
  var folderId = PropertiesService.getScriptProperties().getProperty(BACKUP_FOLDER_KEY);
  if (!folderId) throw new Error('尚未設定備份資料夾');
  var name = '基金帳務帳本-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd-HHmmss');
  var copy = file.makeCopy(name, DriveApp.getFolderById(folderId));
  var checked = validateBackup_(copy.getId());
  copy.setDescription('自動備份驗證：交易 ' + checked.transactionCount + ' 筆；帳面餘額 ' + checked.totals.balanceCents + ' 分');
  return { name: name, url: copy.getUrl(), transactionCount: checked.transactionCount,
    balanceCents: checked.totals.balanceCents };
}
function spreadsheetId_(value) {
  var match = /(?:\/d\/|^)([a-zA-Z0-9_-]{20,})/.exec(String(value || ''));
  if (!match) throw new Error('請提供有效的試算表網址或 ID');
  return match[1];
}
function validateBackup_(backupUrlOrId) {
  var id = spreadsheetId_(backupUrlOrId);
  var ss = SpreadsheetApp.openById(id);
  [['Transactions', Ledger.HEADERS], ['AuditLog', Ledger.AUDIT_HEADERS], ['Imports', Ledger.IMPORT_HEADERS]].forEach(function (pair) {
    var sheet = ss.getSheetByName(pair[0]);
    if (!sheet) throw new Error('備份缺少工作表：' + pair[0]);
    var length = pair[0] === 'Transactions' ? Math.min(sheet.getLastColumn(), pair[1].length) : pair[1].length;
    var header = sheet.getRange(1, 1, 1, length).getValues()[0];
    if (header.some(function (value, index) { return value !== pair[1][index]; }) ||
      length < (pair[0] === 'Transactions' ? 12 : pair[1].length)) {
      throw new Error('備份欄位與目前版本不符：' + pair[0]);
    }
  });
  var items = readTransactionsFrom_(ss);
  if (items.some(function (t) { return !Number.isSafeInteger(t.amountCents) || t.amountCents <= 0; })) {
    throw new Error('備份存在無效金額');
  }
  return { spreadsheetId: id, transactionCount: items.length,
    auditCount: ss.getSheetByName('AuditLog').getLastRow() - 1, totals: Ledger.totals(items),
    url: ss.getUrl() };
}
function validateBackup(token, backupUrlOrId) { auth_(token, 'OWNER'); return validateBackup_(backupUrlOrId); }
function activateBackup(token, backupUrlOrId, confirmation) {
  auth_(token, 'OWNER');
  if (confirmation !== '切換正式帳本') throw new Error('請輸入指定確認文字：切換正式帳本');
  return lock_(function () {
    var checked = validateBackup_(backupUrlOrId);
    var props = PropertiesService.getScriptProperties();
    var currentId = props.getProperty(LEDGER_FILE_KEY);
    if (checked.spreadsheetId === currentId) throw new Error('選擇的是目前正式帳本');
    var folder = DriveApp.getFolderById(props.getProperty(BACKUP_FOLDER_KEY));
    var stamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd-HHmmss');
    var currentCopy = DriveApp.getFileById(currentId).makeCopy('切換前帳本-' + stamp, folder);
    var replacement = DriveApp.getFileById(checked.spreadsheetId).makeCopy('基金帳務帳本-還原-' + stamp);
    props.setProperty(LEDGER_FILE_KEY, replacement.getId());
    var result = { restoredUrl: replacement.getUrl(), previousBackupUrl: currentCopy.getUrl(),
      restoredTotals: checked.totals };
    Logger.log(JSON.stringify(result));
    return result;
  });
}
