var Ledger = (function () {
  'use strict';
  var CATEGORIES = [
    ['ACTIVITY_SUPPLIES', '活動物資'],
    ['CARE_SUPPORT', '關懷與協助'],
    ['GIFTS', '禮品'],
    ['MEAL', '餐飲'],
    ['SUBSIDY', '補貼'],
    ['OTHER', '其他']
  ];
  var INCOME_CATEGORIES = [
    ['MEMBER_DUES', '成員繳款'],
    ['DONATION', '捐款'],
    ['EVENT_INCOME', '活動收入'],
    ['INTEREST', '利息／回饋'],
    ['OTHER_INCOME', '其他收入']
  ];
  var LEGACY_INCOME = ['UNCATEGORIZED_INCOME', '未分類收入（舊帳）'];
  var CATEGORY_NAMES = Object.fromEntries(CATEGORIES);
  var INCOME_CATEGORY_NAMES = Object.fromEntries(INCOME_CATEGORIES.concat([LEGACY_INCOME]));
  var ALIASES = {
    '活動物資': 'ACTIVITY_SUPPLIES', '活動用品': 'ACTIVITY_SUPPLIES', '物資': 'ACTIVITY_SUPPLIES',
    '關懷與協助': 'CARE_SUPPORT', '關懷': 'CARE_SUPPORT', '協助': 'CARE_SUPPORT',
    '禮品': 'GIFTS', '餐飲': 'MEAL', '聚餐': 'MEAL',
    '補貼': 'SUBSIDY', '其他': 'OTHER'
  };
  var INCOME_ALIASES = {
    '成員繳款': 'MEMBER_DUES', '會費': 'MEMBER_DUES', '固定繳款': 'MEMBER_DUES',
    '捐款': 'DONATION', '活動收入': 'EVENT_INCOME', '利息': 'INTEREST',
    '回饋': 'INTEREST', '利息／回饋': 'INTEREST', '其他收入': 'OTHER_INCOME'
  };
  var HEADERS = ['id', 'type', 'gregorianDate', 'lunarDate', 'amountCents', 'category',
    'details', 'notes', 'status', 'createdAt', 'updatedAt', 'sourceKey',
    'accountId', 'fundId', 'voucherNo', 'counterparty', 'paymentMethod', 'documentUrl',
    'reviewStatus', 'reviewedBy', 'reviewedAt', 'createdBy', 'memberId', 'submittedBy'];
  var AUDIT_HEADERS = ['eventId', 'transactionId', 'action', 'reason', 'beforeJson', 'afterJson', 'at', 'actor'];
  var IMPORT_HEADERS = ['batchId', 'sourceDigest', 'count', 'incomeCents', 'expenseCents', 'at'];
  var CSV_HEADERS = ['externalId', 'type', 'gregorianDate', 'amount', 'category', 'details', 'notes'];

  function cleanText(value, max) {
    var text = String(value == null ? '' : value).trim();
    if (text.length > max) throw new Error('文字欄位超過 ' + max + ' 字');
    return text;
  }
  function sheetSafe(value) { return /^[=+@\-]/.test(value) ? "'" + value : value; }
  function sheetRead(value) { return /^'[=+@\-]/.test(value) ? value.slice(1) : value; }
  function parseAmount(value) {
    var text = String(value == null ? '' : value).trim().replace(/,/g, '');
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) throw new Error('金額須為正數，最多兩位小數');
    var parts = text.split('.');
    var cents = Number(parts[0]) * 100 + Number((parts[1] || '').padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('金額必須大於零且不可過大');
    return cents;
  }
  function parseSignedAmount(value) {
    var text = String(value == null ? '' : value).trim();
    return text[0] === '-' ? -parseAmount(text.slice(1)) : (text === '0' || text === '0.00' ? 0 : parseAmount(text));
  }
  function dateString(value) {
    var text = String(value == null ? '' : value).trim().replace(/\//g, '-');
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
    if (!m) throw new Error('國曆日期格式須為 YYYY-MM-DD');
    var y = +m[1], month = +m[2], day = +m[3];
    var d = new Date(Date.UTC(y, month - 1, day));
    if (y < 1900 || y > 2100 || d.getUTCFullYear() !== y || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
      throw new Error('國曆日期不正確或超出 1900–2100 範圍');
    }
    return [String(y), String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  }
  function lunarDate(date, solarFactory) {
    var p = dateString(date).split('-').map(Number);
    var lunar = solarFactory.fromYmd(p[0], p[1], p[2]).getLunar();
    return (lunar.getYearInGanZhi() + '年' + lunar.getMonthInChinese() + '月' + lunar.getDayInChinese())
      .replace(/闰/g, '閏').replace(/腊/g, '臘');
  }
  function categoryCode(value) {
    var v = cleanText(value, 40);
    return Object.prototype.hasOwnProperty.call(CATEGORY_NAMES, v) ? v :
      (Object.prototype.hasOwnProperty.call(ALIASES, v) ? ALIASES[v] : '');
  }
  function incomeCategoryCode(value) {
    var v = cleanText(value, 40);
    return Object.prototype.hasOwnProperty.call(INCOME_CATEGORY_NAMES, v) && v !== LEGACY_INCOME[0] ? v :
      (Object.prototype.hasOwnProperty.call(INCOME_ALIASES, v) ? INCOME_ALIASES[v] : '');
  }
  function normalize(input, solarFactory, options) {
    if (!input || typeof input !== 'object') throw new Error('缺少收支表單資料；請從已部署的網頁新增紀錄');
    var type = cleanText(input.type, 20).toUpperCase();
    if (type === '收入') type = 'INCOME';
    if (type === '支出') type = 'EXPENSE';
    if (type !== 'INCOME' && type !== 'EXPENSE') throw new Error('類型須為收入或支出');
    var date = dateString(input.gregorianDate);
    var category = type === 'EXPENSE' ? categoryCode(input.category) : incomeCategoryCode(input.category);
    if (type === 'EXPENSE' && !category) throw new Error('支出須選擇有效分類');
    if (type === 'INCOME' && !category) {
      if (options && options.allowLegacyIncome &&
          (!cleanText(input.category, 40) || input.category === LEGACY_INCOME[0] || input.category === LEGACY_INCOME[1])) {
        category = LEGACY_INCOME[0];
      }
      else throw new Error('收入須選擇有效分類');
    }
    var details = cleanText(input.details, 300);
    var notes = cleanText(input.notes, 500);
    return { type: type, gregorianDate: date, lunarDate: lunarDate(date, solarFactory),
      amountCents: parseAmount(input.amount), category: category, details: details, notes: notes };
  }
  function fingerprint(tx) {
    var category = tx.category || (tx.type === 'INCOME' ? LEGACY_INCOME[0] : '');
    return [tx.type, tx.gregorianDate, tx.amountCents, category, tx.details, tx.notes].join('\u001f');
  }
  function csvRows(text) {
    if (typeof text !== 'string' || text.length > 250000) throw new Error('CSV 不可超過 250 KB');
    var rows = [], row = [], field = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '"') {
        if (quoted && text[i + 1] === '"') { field += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) { row.push(field); field = ''; }
      else if ((ch === '\n' || ch === '\r') && !quoted) {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); if (row.some(function (v) { return v !== ''; })) rows.push(row);
        row = []; field = '';
      } else field += ch;
    }
    if (quoted) throw new Error('CSV 引號未結束');
    row.push(field); if (row.some(function (v) { return v !== ''; })) rows.push(row);
    if (!rows.length) throw new Error('匯入檔沒有資料');
    var header = rows.shift().map(function (v) { return v.trim(); });
    if (CSV_HEADERS.some(function (v) { return header.indexOf(v) === -1; })) throw new Error('匯入欄位不符合範本');
    if (rows.length > 1000) throw new Error('每次最多匯入 1000 筆');
    return rows.map(function (values, index) {
      if (values.length !== header.length) throw new Error('第 ' + (index + 2) + ' 列欄位數不符');
      var item = {}; CSV_HEADERS.forEach(function (name) { item[name] = values[header.indexOf(name)] || ''; }); return item;
    });
  }
  function prepareImport(raw, existing, solarFactory) {
    var seen = new Set();
    existing.forEach(function (t) { seen.add(fingerprint(t)); if (t.sourceKey) seen.add(t.sourceKey); });
    var errors = [], prepared = [], incomeCents = 0, expenseCents = 0;
    raw.forEach(function (item, index) {
      try {
        var tx = normalize(item, solarFactory, { allowLegacyIncome: true });
        var key = cleanText(item.externalId, 100) || fingerprint(tx);
        var fp = fingerprint(tx);
        if (seen.has(key) || seen.has(fp)) throw new Error('與既有或本次資料重複');
        seen.add(key); seen.add(fp); tx.sourceKey = key; prepared.push(tx);
        if (tx.type === 'INCOME') incomeCents += tx.amountCents; else expenseCents += tx.amountCents;
      } catch (e) { errors.push({ row: index + 2, message: e.message }); }
    });
    return { transactions: prepared, errors: errors, incomeCents: incomeCents,
      expenseCents: expenseCents, count: prepared.length };
  }
  function active(items) { return items.filter(function (t) { return t.status !== 'VOID'; }); }
  function totals(items) {
    return active(items).reduce(function (a, t) {
      if (t.type === 'INCOME') a.incomeCents += t.amountCents;
      else a.expenseCents += t.amountCents;
      a.balanceCents = a.incomeCents - a.expenseCents;
      return a;
    }, { incomeCents: 0, expenseCents: 0, balanceCents: 0 });
  }
  function filtered(items, filters) {
    filters = filters || {}; var start = filters.start ? dateString(filters.start) : '';
    var end = filters.end ? dateString(filters.end) : '';
    if (start && end && start > end) throw new Error('起始日期不可晚於結束日期');
    var keyword = cleanText(filters.keyword, 100).toLocaleLowerCase();
    return active(items).filter(function (t) {
      return (!start || t.gregorianDate >= start) && (!end || t.gregorianDate <= end) &&
        (!filters.type || t.type === filters.type) && (!filters.category || t.category === filters.category) &&
        (!keyword || (t.details + ' ' + t.notes).toLocaleLowerCase().includes(keyword));
    }).sort(function (a, b) { return b.gregorianDate.localeCompare(a.gregorianDate) || b.createdAt.localeCompare(a.createdAt); });
  }
  function report(items, start, end) {
    var range = filtered(items, { start: start, end: end });
    var opening = start ? totals(items.filter(function (t) { return t.gregorianDate < start; })).balanceCents : 0;
    var period = totals(range);
    return { rows: range.slice().reverse(), openingCents: opening, incomeCents: period.incomeCents,
      expenseCents: period.expenseCents, closingCents: opening + period.balanceCents };
  }
  function categories(items) {
    var result = CATEGORIES.map(function (pair) { return { code: pair[0], label: pair[1], amountCents: 0 }; });
    active(items).forEach(function (t) {
      if (t.type === 'EXPENSE') { var found = result.find(function (r) { return r.code === t.category; }); if (found) found.amountCents += t.amountCents; }
    });
    return result;
  }
  function incomeCategories(items) {
    var result = INCOME_CATEGORIES.concat([LEGACY_INCOME]).map(function (pair) {
      return { code: pair[0], label: pair[1], amountCents: 0 };
    });
    active(items).forEach(function (t) {
      if (t.type === 'INCOME') {
        var code = t.category || LEGACY_INCOME[0];
        var found = result.find(function (r) { return r.code === code; });
        if (found) found.amountCents += t.amountCents;
      }
    });
    return result;
  }
  function analytics(items, start, end) {
    var range = filtered(items, { start: start, end: end });
    var period = totals(range);
    var opening = start ? totals(items.filter(function (t) { return t.gregorianDate < start; })).balanceCents : 0;
    var dates = range.map(function (t) { return t.gregorianDate; }).sort();
    var first = start || dates[0] || '';
    var last = end || dates[dates.length - 1] || '';
    var buckets = [];
    if (first && last && first <= last) {
      var months = (+last.slice(0, 4) - +first.slice(0, 4)) * 12 + (+last.slice(5, 7) - +first.slice(5, 7)) + 1;
      var yearly = months > 24;
      var year = +first.slice(0, 4), month = yearly ? 1 : +first.slice(5, 7);
      var lastYear = +last.slice(0, 4), lastMonth = yearly ? 1 : +last.slice(5, 7);
      while (year < lastYear || (year === lastYear && month <= lastMonth)) {
        buckets.push({ key: yearly ? String(year) : String(year) + '-' + String(month).padStart(2, '0'),
          incomeCents: 0, expenseCents: 0 });
        if (yearly || month === 12) { year++; month = 1; } else month++;
      }
      range.forEach(function (t) {
        var key = yearly ? t.gregorianDate.slice(0, 4) : t.gregorianDate.slice(0, 7);
        var bucket = buckets.find(function (b) { return b.key === key; });
        if (bucket) bucket[t.type === 'INCOME' ? 'incomeCents' : 'expenseCents'] += t.amountCents;
      });
    }
    return { start: start || '', end: end || '', openingCents: opening,
      incomeCents: period.incomeCents, expenseCents: period.expenseCents,
      netCents: period.balanceCents, closingCents: opening + period.balanceCents,
      transactionCount: range.length, buckets: buckets,
      expenseCategories: categories(range), incomeCategories: incomeCategories(range) };
  }
  function centsText(cents) {
    var sign = cents < 0 ? '-' : ''; var n = Math.abs(cents);
    return sign + Math.floor(n / 100).toLocaleString('en-US') + '.' + String(n % 100).padStart(2, '0');
  }
  return { CATEGORIES: CATEGORIES, INCOME_CATEGORIES: INCOME_CATEGORIES,
    LEGACY_INCOME: LEGACY_INCOME, CATEGORY_NAMES: CATEGORY_NAMES,
    INCOME_CATEGORY_NAMES: INCOME_CATEGORY_NAMES, HEADERS: HEADERS,
    AUDIT_HEADERS: AUDIT_HEADERS, IMPORT_HEADERS: IMPORT_HEADERS, CSV_HEADERS: CSV_HEADERS,
    normalize: normalize, dateString: dateString, lunarDate: lunarDate, parseAmount: parseAmount,
    parseSignedAmount: parseSignedAmount, csvRows: csvRows, prepareImport: prepareImport,
    fingerprint: fingerprint, totals: totals, filtered: filtered, report: report,
    categories: categories, incomeCategories: incomeCategories,
    analytics: analytics, centsText: centsText,
    sheetSafe: sheetSafe, sheetRead: sheetRead };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = Ledger;
