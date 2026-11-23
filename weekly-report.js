// Merchandiser weekly reports. Beijing weeks run Thursday through Wednesday.
// This module is loaded by the browser only. The data service must not import
// it: the live deployer does not copy new modules into the runtime.

export const EMPTY_WEEKLY_REPORT_MESSAGE = '请先填写周报内容，再保存';
export const WEEKLY_REPORT_FIELDS = Object.freeze([
  ['inquiries', '询盘', true],
  ['calls', '电话', true],
  ['unpaid_orders', '下单未付', true],
  ['performance', '业绩', false]
]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

// Official rest days from the State Council 放假安排 for 2025–2027.
// Extended rest days are included. 调休工作日 are not rest days.
const PRC_HOLIDAY_REST = Object.freeze([
  ['2025-01-01', '2025-01-01'],
  ['2025-01-28', '2025-02-04'],
  ['2025-04-04', '2025-04-06'],
  ['2025-05-01', '2025-05-05'],
  ['2025-05-31', '2025-06-02'],
  ['2025-10-01', '2025-10-08'],
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'],
  ['2027-01-01', '2027-01-03'],
  ['2027-02-05', '2027-02-13'],
  ['2027-04-03', '2027-04-05'],
  ['2027-05-01', '2027-05-05'],
  ['2027-06-09', '2027-06-09'],
  ['2027-09-15', '2027-09-15'],
  ['2027-10-01', '2027-10-07']
]);

export const PRC_ADJUSTED_WORKDAYS = Object.freeze([
  '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
  '2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10',
  '2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09'
]);

const ELLA_EMAIL = 'sales@inflatable-zone.com';

function calendarUtc(iso) {
  if (!DATE_ONLY.test(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return utc;
}

export function addCalendarDays(iso, days) {
  const utc = calendarUtc(iso);
  if (!utc || !Number.isInteger(days)) return '';
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export function beijingCalendarDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(value);
}

export function beijingWeekRange(value = new Date()) {
  const today = typeof value === 'string' ? value : beijingCalendarDate(value);
  const utc = calendarUtc(today);
  if (!utc) throw Error('日期无效');
  const weekStart = addCalendarDays(today, -((utc.getUTCDay() + 7 - 4) % 7));
  return { week_start: weekStart, week_end: addCalendarDays(weekStart, 6) };
}

export function isOfficialHolidayRestDay(value) {
  const iso = typeof value === 'string' ? value : beijingCalendarDate(value);
  if (!DATE_ONLY.test(iso)) return false;
  return PRC_HOLIDAY_REST.some(([start, end]) => iso >= start && iso <= end);
}

// When this Beijing week's Wednesday is a holiday rest day, the reminder waits
// for the next Wednesday that is not one.
export function nextWeeklyReminderWednesday(value = new Date()) {
  let wednesday = beijingWeekRange(value).week_end;
  for (let guard = 0; isOfficialHolidayRestDay(wednesday) && guard < 54; guard += 1) {
    wednesday = addCalendarDays(wednesday, 7);
  }
  return wednesday;
}

export function weeklyReminder(today, savedCurrentWeek) {
  const todayIso = typeof today === 'string' ? today : beijingCalendarDate(today);
  const current = beijingWeekRange(todayIso);
  const due = nextWeeklyReminderWednesday(todayIso);
  if (due !== current.week_end) {
    return {
      kind: 'deferred',
      text: `本周三（${current.week_end}）是国务院放假安排中的休息日，本周不提醒提交。下次提醒为 ${due}（周三）。`
    };
  }
  if (savedCurrentWeek) return null;
  return {
    kind: 'due',
    text: `本周周报尚未保存。请在周三 17:00 前填写并点击保存。周期：${current.week_start} 至 ${current.week_end}（北京时间，周四至周三）。`
  };
}

function namedElla(profile) {
  const email = String(profile?.email || '').trim().toLowerCase();
  if (email === ELLA_EMAIL) return true;
  return [profile?.business_name, profile?.display_name, profile?.name]
    .filter(value => typeof value === 'string' && value.trim())
    .some(value => value.trim().toLowerCase() === 'ella');
}

export function canOpenWeeklyReport(profile, supervisor = false) {
  if (!profile || profile.disabled_at) return false;
  if (supervisor) return true;
  return profile.role === 'business';
}

export function canSubmitWeeklyReport(profile, supervisor = false) {
  return canOpenWeeklyReport(profile, supervisor) && !supervisor && profile.role === 'business' && !namedElla(profile);
}

function canonicalNumber(text) {
  return text.includes('.') ? text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : text;
}

export function parseWeeklyNumber(value, { integer = false, label = '数字' } = {}) {
  if (value == null || String(value).trim() === '') return { ok: true, value: null };
  const text = String(value).trim();
  if (!NUMBER.test(text) || text.length > 16) return { ok: false, message: `请填写有效的${label}` };
  if (integer && text.includes('.')) return { ok: false, message: `${label}请填写整数` };
  return { ok: true, value: canonicalNumber(text) };
}

export function validateWeeklyReportInput(input = {}) {
  const value = {};
  for (const [key, label, integer] of WEEKLY_REPORT_FIELDS) {
    const parsed = parseWeeklyNumber(input[key], { integer, label });
    if (!parsed.ok) return parsed;
    value[key] = parsed.value;
  }
  value.body = String(input.body ?? '').trim();
  if (value.body.length > 8000) return { ok: false, message: '周报内容过长' };
  if (WEEKLY_REPORT_FIELDS.every(([key]) => value[key] == null) && !value.body) {
    return { ok: false, message: EMPTY_WEEKLY_REPORT_MESSAGE };
  }
  value.week_start = String(input.week_start || '');
  return { ok: true, value };
}

export function addDecimal(values) {
  const texts = values.filter(value => value != null && String(value).trim() !== '').map(value => String(value).trim());
  const scale = texts.reduce((max, text) => Math.max(max, (text.split('.')[1] || '').length), 0);
  let total = 0n;
  for (const text of texts) {
    const negative = text.startsWith('-');
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    total += (negative ? -1n : 1n) * BigInt((whole || '0') + fraction.padEnd(scale, '0'));
  }
  const negative = total < 0n;
  const raw = (negative ? -total : total).toString().padStart(scale + 1, '0');
  if (!scale) return (negative ? '-' : '') + raw;
  const head = raw.slice(0, -scale);
  const tail = raw.slice(-scale).replace(/0+$/, '');
  return (negative ? '-' : '') + head + (tail ? '.' + tail : '');
}

export function sumWeeklyReports(rows) {
  return {
    inquiries: addDecimal(rows.map(row => row.inquiries)),
    calls: addDecimal(rows.map(row => row.calls)),
    unpaid_orders: addDecimal(rows.map(row => row.unpaid_orders)),
    performance: addDecimal(rows.map(row => row.performance))
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function displayNumber(value) {
  return value == null || value === '' ? '—' : escapeHtml(value);
}

export function weeklyReportMonthKey(weekEnd) {
  const iso = String(weekEnd || '');
  return DATE_ONLY.test(iso) ? iso.slice(0, 7) : '';
}

export function weeklyReportMonthLabel(monthKey) {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return '';
  return `${monthKey.slice(0, 4)}年${Number(monthKey.slice(5, 7))}月`;
}

function reportMonthKey(row) {
  const fromEnd = weeklyReportMonthKey(row?.week_end);
  if (fromEnd) return fromEnd;
  const start = String(row?.week_start || '');
  if (!DATE_ONLY.test(start)) return '';
  try { return weeklyReportMonthKey(beijingWeekRange(start).week_end); } catch { return ''; }
}

export function groupWeeklyReportsByMonth(reports = []) {
  const groups = new Map();
  for (const row of reports) {
    const month = reportMonthKey(row);
    if (!month) continue;
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(row);
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([month, rows]) => ({
    month,
    label: weeklyReportMonthLabel(month),
    rows: rows.slice().sort((a, b) => String(a.week_start).localeCompare(String(b.week_start)) || String(a.salesperson_name || '').localeCompare(String(b.salesperson_name || ''), 'zh-CN')),
    totals: sumWeeklyReports(rows)
  }));
}

const PREFERRED_SALESPEOPLE = ['Sherry', 'Demi', 'Rayna'];
const SHEET_METRICS = [
  ['inquiries', '询盘', false],
  ['unpaid_orders', '下单未付', false],
  ['calls', '电话', false],
  ['performance', '业绩', true]
];

export function weeklyReportWeekShortLabel(weekStart, weekEnd) {
  const end = weekEnd || (DATE_ONLY.test(String(weekStart || '')) ? beijingWeekRange(weekStart).week_end : '');
  return `${Number(String(weekStart).slice(8))}-${Number(String(end).slice(8))}号`;
}

export function weeklyReportTotalTitle(names) {
  const present = new Set(names);
  return names.length === PREFERRED_SALESPEOPLE.length && PREFERRED_SALESPEOPLE.every(name => present.has(name)) ? '三人合计' : '合计';
}

function personName(row) {
  return String(row?.salesperson_name || '').trim() || '业务员';
}

function weekEndOf(row) {
  const end = String(row?.week_end || '');
  if (DATE_ONLY.test(end)) return end;
  return DATE_ONLY.test(String(row?.week_start || '')) ? beijingWeekRange(row.week_start).week_end : '';
}

function formatMetric(value) {
  if (value == null || String(value).trim() === '') return '';
  return addDecimal([String(value).trim()]);
}

function orderedNames(names) {
  return [...names].sort((a, b) => {
    const left = PREFERRED_SALESPEOPLE.indexOf(a);
    const right = PREFERRED_SALESPEOPLE.indexOf(b);
    if (left !== -1 || right !== -1) return (left === -1 ? 99 : left) - (right === -1 ? 99 : right);
    return a.localeCompare(b, 'zh-CN');
  });
}

function savedOwnCurrentWeek(reports, weekStart, viewerId) {
  return reports.some(row => row.week_start === weekStart && (viewerId ? row.user_id === viewerId : true));
}

function viewerSalesName(reports, viewerId) {
  const named = reports.find(row => row.user_id === viewerId && String(row.salesperson_name || '').trim());
  return named ? String(named.salesperson_name).trim() : '本人';
}

function sheetWeeks(rows, current) {
  const weeks = new Map();
  for (const row of rows) {
    if (!DATE_ONLY.test(String(row?.week_start || ''))) continue;
    weeks.set(row.week_start, { week_start: row.week_start, week_end: weekEndOf(row) });
  }
  if (current) weeks.set(current.week_start, current);
  return [...weeks.values()].sort((a, b) => a.week_start.localeCompare(b.week_start));
}

function findSheetRow(rows, name, weekStart, viewerId) {
  if (viewerId) {
    const own = rows.find(row => row.user_id === viewerId && row.week_start === weekStart && personName(row) === name);
    if (own) return own;
  }
  return rows.find(row => personName(row) === name && row.week_start === weekStart) || null;
}

function metricValues(rows, names, weeks, metric) {
  const values = [];
  for (const name of names) {
    for (const week of weeks) values.push(formatMetric(findSheetRow(rows, name, week.week_start)?.[metric]));
  }
  return values.filter(Boolean);
}

function numberCell(row, name, week, metric, decimal, editable) {
  const value = formatMetric(row?.[metric]);
  if (!editable) return `<td class="sheet-num" data-person="${escapeHtml(name)}" data-metric="${metric}" data-week="${escapeHtml(week.week_start)}" data-raw="${escapeHtml(value)}">${value ? escapeHtml(value) : ''}</td>`;
  return `<td class="sheet-num" data-person="${escapeHtml(name)}" data-metric="${metric}" data-week="${escapeHtml(week.week_start)}"><input name="${metric}" data-week="${escapeHtml(week.week_start)}" inputmode="${decimal ? 'decimal' : 'numeric'}" value="${escapeHtml(value)}" autocomplete="off"></td>`;
}

function personBlock(name, rows, weeks, own, current) {
  const editableWeeks = new Set(weeks.filter(week => own && (findSheetRow(rows, name, week.week_start, own.viewerId) || (current && week.week_start === current.week_start))).map(week => week.week_start));
  const span = weeks.length + 2;
  const head = `<tr class="sheet-banner"><th colspan="${span}">${escapeHtml(name)}</th></tr><tr class="sheet-head"><th>项目</th>${weeks.map(week => `<th>${escapeHtml(weeklyReportWeekShortLabel(week.week_start, week.week_end))}</th>`).join('')}<th>合计</th></tr><tr class="sheet-dates"><td></td>${weeks.map(week => `<td>${escapeHtml(week.week_start)} 至 ${escapeHtml(week.week_end)}</td>`).join('')}<td></td></tr>`;
  const metrics = SHEET_METRICS.map(([metric, label, decimal], index) => {
    const total = addDecimal(weeks.map(week => formatMetric(findSheetRow(rows, name, week.week_start, own?.viewerId)?.[metric])).filter(Boolean));
    return `<tr class="${index % 2 === 0 ? 'sheet-zebra' : ''}"><th class="sheet-label">${label}</th>${weeks.map(week => numberCell(findSheetRow(rows, name, week.week_start, own?.viewerId), name, week, metric, decimal, editableWeeks.has(week.week_start))).join('')}<td class="sheet-sum" data-sum="person" data-person="${escapeHtml(name)}" data-metric="${metric}">${escapeHtml(total)}</td></tr>`;
  }).join('');
  const bodyRow = `<tr class="sheet-zebra"><th class="sheet-label">周报</th>${weeks.map(week => {
    const record = findSheetRow(rows, name, week.week_start, own?.viewerId);
    const text = String(record?.body || '').trim();
    if (!editableWeeks.has(week.week_start)) return `<td class="sheet-note">${text ? escapeHtml(text) : '未填写'}</td>`;
    return `<td class="sheet-note"><textarea name="body" data-week="${escapeHtml(week.week_start)}">${escapeHtml(text)}</textarea></td>`;
  }).join('')}<td class="sheet-sum"></td></tr>`;
  const noteRow = `<tr><th class="sheet-label">备注</th>${weeks.map(week => {
    const note = String(findSheetRow(rows, name, week.week_start, own?.viewerId)?.note || '').trim();
    return `<td class="sheet-note">${note ? escapeHtml(note) : '—'}</td>`;
  }).join('')}<td class="sheet-sum"></td></tr>`;
  const saveRow = own ? `<tr class="sheet-save"><th></th>${weeks.map(week => editableWeeks.has(week.week_start) ? `<td><button type="button" class="weekly-report-save" data-week="${escapeHtml(week.week_start)}">保存</button><p class="weekly-report-error" data-week="${escapeHtml(week.week_start)}" role="alert"></p></td>` : '<td></td>').join('')}<td></td></tr>` : '';
  return `<tbody class="sheet-person"${own ? ' data-own="true"' : ''} data-person="${escapeHtml(name)}">${head}${metrics}${bodyRow}${noteRow}${saveRow}</tbody>`;
}

function grandBlock(title, rows, names, weeks) {
  const span = weeks.length + 2;
  const head = `<tr class="sheet-banner"><th colspan="${span}">${escapeHtml(title)}</th></tr><tr class="sheet-head"><th>项目</th>${weeks.map(week => `<th>${escapeHtml(weeklyReportWeekShortLabel(week.week_start, week.week_end))}</th>`).join('')}<th>合计</th></tr><tr class="sheet-dates"><td></td>${weeks.map(week => `<td>${escapeHtml(week.week_start)} 至 ${escapeHtml(week.week_end)}</td>`).join('')}<td></td></tr>`;
  const metrics = SHEET_METRICS.map(([metric, label]) => {
    const weekTotals = weeks.map(week => addDecimal(names.map(name => formatMetric(findSheetRow(rows, name, week.week_start)?.[metric])).filter(Boolean)));
    const all = addDecimal(names.flatMap(name => weeks.map(week => formatMetric(findSheetRow(rows, name, week.week_start)?.[metric]))).filter(Boolean));
    return `<tr class="sheet-grand"><th class="sheet-label">${label}</th>${weekTotals.map((total, index) => `<td class="sheet-sum" data-sum="week" data-metric="${metric}" data-week="${escapeHtml(weeks[index].week_start)}">${escapeHtml(total)}</td>`).join('')}<td class="sheet-sum" data-sum="all" data-metric="${metric}">${escapeHtml(all)}</td></tr>`;
  }).join('');
  return `<tbody class="sheet-total-block">${head}${metrics}</tbody>`;
}

function summaryTables(reports, edit = null) {
  const months = groupWeeklyReportsByMonth(reports);
  const currentMonth = edit?.current ? weeklyReportMonthKey(edit.current.week_end) : '';
  const ownsCurrent = Boolean(edit?.viewerId && reports.some(row => row.user_id === edit.viewerId && row.week_start === edit.current.week_start));
  if (edit?.canSubmit && currentMonth && !ownsCurrent && !months.some(group => group.month === currentMonth)) {
    months.push({ month: currentMonth, label: weeklyReportMonthLabel(currentMonth), rows: [] });
    months.sort((a, b) => b.month.localeCompare(a.month));
  }
  if (!months.length) return '<p class="weekly-report-empty">还没有周报。</p>';
  return months.map(group => {
    const includeCurrent = Boolean(edit?.canSubmit && !ownsCurrent && group.month === currentMonth);
    const weeks = sheetWeeks(group.rows, includeCurrent ? edit.current : null);
    const names = orderedNames([...new Set(group.rows.map(personName))]);
    if (edit?.canSubmit && !names.includes(edit.viewerName) && (includeCurrent || group.rows.some(row => row.user_id === edit.viewerId))) names.push(edit.viewerName);
    const ordered = orderedNames(names);
    const blocks = ordered.map(name => personBlock(name, group.rows, weeks, edit?.canSubmit && name === edit.viewerName ? edit : null, includeCurrent ? edit.current : null)).join('');
    const title = weeklyReportTotalTitle(ordered);
    return `<section class="sheet-month" data-month="${escapeHtml(group.month)}"><p class="sheet-subtitle">${escapeHtml(group.label)}&nbsp;&nbsp;&nbsp;&nbsp;周期为周四至周三（北京时间）</p><div class="sheet-scroll"><table class="sheet">${blocks}${grandBlock(title, group.rows, ordered, weeks)}</table></div></section>`;
  }).join('');
}

export function renderWeeklyReport({ access = 'view', reports = [], today = new Date(), viewerId = '' } = {}) {
  const todayIso = typeof today === 'string' ? today : beijingCalendarDate(today);
  const current = beijingWeekRange(todayIso);
  const canSubmit = access === 'submit';
  const reminder = canSubmit ? weeklyReminder(todayIso, savedOwnCurrentWeek(reports, current.week_start, viewerId)) : null;
  const reminderHtml = reminder ? `<p class="${reminder.kind === 'due' ? 'weekly-report-reminder' : 'weekly-report-defer'}" role="${reminder.kind === 'due' ? 'alert' : 'status'}">${escapeHtml(reminder.text)}</p>` : '';
  const heading = `<div class="weekly-report-head"><div><p class="kicker">WEEKLY REPORT</p><h1>周报</h1><p>${canSubmit ? '在月度汇总表中修改并保存本人的周报。不能修改他人的数据或备注。' : '查看各业务员的月度汇总，不能代为保存。'}</p></div><div class="weekly-report-head-actions"><button type="button" id="closeWeeklyReport">← 返回订单中心</button></div></div>`;
  const edit = canSubmit && viewerId ? { canSubmit, viewerId, viewerName: viewerSalesName(reports, viewerId), current } : null;
  return `<section class="weekly-report-shell" data-access="${canSubmit ? 'submit' : 'view'}">${heading}${reminderHtml}<div class="weekly-report-summary">${summaryTables(reports, edit)}</div></section>`;
}

export async function mountWeeklyReport(page, { api, onClose, today = () => new Date() } = {}) {
  let data = { access: 'view', reports: [], viewer_id: '' };
  const paint = () => {
    page.className = 'weekly-report-page';
    page.innerHTML = renderWeeklyReport({ ...data, today: today(), viewerId: data.viewer_id || '' });
    page.querySelector('#closeWeeklyReport')?.addEventListener('click', event => {
      event.stopPropagation();
      onClose?.();
    });
    const refreshSheetSums = () => {
      page.querySelectorAll('[data-month]').forEach(month => {
        const cells = [...month.querySelectorAll('.sheet-num')].map(cell => ({
          person: cell.dataset.person,
          metric: cell.dataset.metric,
          week: cell.dataset.week,
          raw: (cell.querySelector('input')?.value ?? cell.dataset.raw ?? '').trim()
        })).filter(item => item.raw !== '' && Number.isFinite(Number(item.raw)));
        month.querySelectorAll('[data-sum="person"]').forEach(cell => {
          cell.textContent = addDecimal(cells.filter(item => item.person === cell.dataset.person && item.metric === cell.dataset.metric).map(item => item.raw));
        });
        month.querySelectorAll('[data-sum="week"]').forEach(cell => {
          cell.textContent = addDecimal(cells.filter(item => item.week === cell.dataset.week && item.metric === cell.dataset.metric).map(item => item.raw));
        });
        month.querySelectorAll('[data-sum="all"]').forEach(cell => {
          cell.textContent = addDecimal(cells.filter(item => item.metric === cell.dataset.metric).map(item => item.raw));
        });
      });
    };
    page.querySelectorAll('.sheet-num input').forEach(input => input.addEventListener('input', refreshSheetSums));
    page.querySelectorAll('.weekly-report-save').forEach(button => button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const week = button.dataset.week || '';
      const block = button.closest('tbody');
      const field = name => block?.querySelector(`[name="${name}"][data-week="${week}"]`)?.value;
      const input = { week_start: week, inquiries: field('inquiries'), calls: field('calls'), unpaid_orders: field('unpaid_orders'), performance: field('performance'), body: field('body') };
      const parsed = validateWeeklyReportInput(input);
      const error = block?.querySelector(`.weekly-report-error[data-week="${week}"]`);
      if (!parsed.ok) {
        if (error) error.textContent = parsed.message;
        alert(parsed.message);
        return;
      }
      button.disabled = true;
      try {
        await api('/rest/v1/rpc/weekly_report', { method: 'POST', body: JSON.stringify({ action: 'save', ...parsed.value }) });
        await load();
      } catch (caught) {
        if (error) error.textContent = caught.message || '保存失败';
        button.disabled = false;
      }
    }));
  };
  async function load() {
    data = await api('/rest/v1/rpc/weekly_report', { method: 'POST', body: JSON.stringify({ action: 'list' }) });
    if (page.isConnected !== false) paint();
  }
  await load();
}
