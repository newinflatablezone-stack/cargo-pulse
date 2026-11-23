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

function weekRangeLabel(row) {
  const start = String(row?.week_start || '');
  const end = String(row?.week_end || '') || (DATE_ONLY.test(start) ? beijingWeekRange(start).week_end : '');
  return start && end ? `${start} 至 ${end}` : start || end;
}

function savedOwnCurrentWeek(reports, weekStart, viewerId) {
  return reports.some(row => row.week_start === weekStart && (viewerId ? row.user_id === viewerId : true));
}

function viewerSalesName(reports, viewerId) {
  const named = reports.find(row => row.user_id === viewerId && String(row.salesperson_name || '').trim());
  return named ? String(named.salesperson_name).trim() : '本人';
}

function sortReportRows(rows) {
  return rows.sort((a, b) => String(a.week_start).localeCompare(String(b.week_start)) || String(a.salesperson_name || '').localeCompare(String(b.salesperson_name || ''), 'zh-CN'));
}

function fieldInput(name, value, decimal = false) {
  return `<input name="${name}" inputmode="${decimal ? 'decimal' : 'numeric'}" value="${escapeHtml(value ?? '')}" autocomplete="off">`;
}

function reportRow(row, editable) {
  const note = String(row.note || '').trim();
  const text = String(row.body || '').trim();
  const reportCell = editable
    ? `<textarea name="body">${escapeHtml(text)}</textarea><button type="button" class="weekly-report-save">保存</button><p class="weekly-report-error" role="alert"></p>`
    : `<div class="weekly-report-text">${text ? escapeHtml(text) : '未填写'}</div>`;
  const numberCell = (name, value, decimal = false) => editable ? fieldInput(name, value ?? '', decimal) : displayNumber(value);
  return `<tr${editable ? ` class="weekly-report-row-own" data-own="true" data-week="${escapeHtml(row.week_start)}"` : ''}><th>${escapeHtml(row.salesperson_name || '业务员')}</th><td>${escapeHtml(weekRangeLabel(row))}</td><td>${numberCell('inquiries', row.inquiries)}</td><td>${numberCell('calls', row.calls)}</td><td>${numberCell('unpaid_orders', row.unpaid_orders)}</td><td>${numberCell('performance', row.performance, true)}</td><td>${reportCell}</td><td>${note ? escapeHtml(note) : '—'}</td></tr>`;
}

function summaryTables(reports, edit = null) {
  const months = groupWeeklyReportsByMonth(reports);
  const currentMonth = edit?.current ? weeklyReportMonthKey(edit.current.week_end) : '';
  const ownsCurrent = Boolean(edit?.viewerId && edit.current && reports.some(row => row.week_start === edit.current.week_start && row.user_id === edit.viewerId));
  if (edit?.canSubmit && edit.viewerId && currentMonth && !ownsCurrent && !months.some(group => group.month === currentMonth)) {
    months.push({ month: currentMonth, label: weeklyReportMonthLabel(currentMonth), rows: [], totals: sumWeeklyReports([]) });
    months.sort((a, b) => b.month.localeCompare(a.month));
  }
  if (!months.length) return '<p class="weekly-report-empty">还没有周报。</p>';
  return months.map(group => {
    const rows = group.rows.slice();
    if (edit?.canSubmit && edit.viewerId && edit.current && group.month === currentMonth && !ownsCurrent) {
      rows.push({
        user_id: edit.viewerId,
        salesperson_name: edit.viewerName,
        week_start: edit.current.week_start,
        week_end: edit.current.week_end,
        inquiries: null,
        calls: null,
        unpaid_orders: null,
        performance: null,
        body: '',
        note: ''
      });
      sortReportRows(rows);
    }
    const body = rows.map(row => reportRow(row, Boolean(edit?.canSubmit && edit.viewerId && row.user_id === edit.viewerId))).join('');
    const totals = group.totals;
    return `<section class="weekly-report-month-block" data-month="${escapeHtml(group.month)}"><h2 class="weekly-report-month">${escapeHtml(group.label)}</h2><article class="weekly-report-card"><div class="weekly-report-table-scroll"><table class="weekly-report-table"><thead><tr><th>业务员</th><th>周期（周四至周三）</th><th>询盘</th><th>电话</th><th>下单未付</th><th>业绩</th><th>周报</th><th>备注</th></tr></thead><tbody>${body}<tr class="weekly-report-total"><th>合计</th><td></td><td>${escapeHtml(totals.inquiries)}</td><td>${escapeHtml(totals.calls)}</td><td>${escapeHtml(totals.unpaid_orders)}</td><td>${escapeHtml(totals.performance)}</td><td></td><td></td></tr></tbody></table></div></article></section>`;
  }).join('');
}

export function renderWeeklyReport({ access = 'view', reports = [], today = new Date(), viewerId = '' } = {}) {
  const todayIso = typeof today === 'string' ? today : beijingCalendarDate(today);
  const current = beijingWeekRange(todayIso);
  const canSubmit = access === 'submit';
  const reminder = canSubmit ? weeklyReminder(todayIso, savedOwnCurrentWeek(reports, current.week_start, viewerId)) : null;
  const reminderHtml = reminder ? `<p class="${reminder.kind === 'due' ? 'weekly-report-reminder' : 'weekly-report-defer'}" role="${reminder.kind === 'due' ? 'alert' : 'status'}">${escapeHtml(reminder.text)}</p>` : '';
  const heading = `<div class="weekly-report-head"><div><p class="kicker">WEEKLY REPORT</p><h1>周报</h1><p>${canSubmit ? '在月度汇总表中修改并保存本人的周报。不能修改他人的数据或备注。' : '查看各业务员的月度汇总，不能代为保存。'}</p></div><button type="button" id="closeWeeklyReport">← 返回订单中心</button></div>`;
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
    page.querySelectorAll('.weekly-report-save').forEach(button => button.addEventListener('click', async event => {
      event.preventDefault();
      event.stopPropagation();
      const row = button.closest('tr');
      const input = {
        week_start: row?.dataset.week || '',
        inquiries: row?.querySelector('[name="inquiries"]')?.value,
        calls: row?.querySelector('[name="calls"]')?.value,
        unpaid_orders: row?.querySelector('[name="unpaid_orders"]')?.value,
        performance: row?.querySelector('[name="performance"]')?.value,
        body: row?.querySelector('[name="body"]')?.value
      };
      const parsed = validateWeeklyReportInput(input);
      const error = row?.querySelector('.weekly-report-error');
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
