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

function selectedWeek(weekStart, todayIso) {
  const current = beijingWeekRange(todayIso);
  if (!weekStart) return current;
  try {
    const candidate = beijingWeekRange(weekStart);
    return candidate.week_start === weekStart ? candidate : current;
  } catch {
    return current;
  }
}

function displayNumber(value) {
  return value == null || value === '' ? '—' : escapeHtml(value);
}

function reportText(row) {
  const body = String(row.body || '').trim();
  const note = String(row.note || '').trim();
  return `<div class="weekly-report-text">${body ? escapeHtml(body) : '未填写'}</div>${note ? `<p class="weekly-report-note">备注：${escapeHtml(note)}</p>` : ''}`;
}

export function renderWeeklyReport({ access = 'view', reports = [], weekStart = '', today = new Date() } = {}) {
  const todayIso = typeof today === 'string' ? today : beijingCalendarDate(today);
  const current = beijingWeekRange(todayIso);
  const week = selectedWeek(weekStart, todayIso);
  const rows = reports.filter(row => row.week_start === week.week_start)
    .slice()
    .sort((a, b) => String(a.salesperson_name).localeCompare(String(b.salesperson_name), 'zh-CN'));
  const own = rows[0];
  const savedCurrent = reports.some(row => row.week_start === current.week_start);
  const reminder = access === 'submit' ? weeklyReminder(todayIso, savedCurrent) : null;
  const range = `${week.week_start} 至 ${week.week_end}（周四至周三，北京时间）`;
  const history = [...new Set(reports.map(row => row.week_start).filter(Boolean))].sort().reverse();
  const weekControls = `<div class="weekly-report-week"><button type="button" id="weeklyReportPrev">上一周</button><strong id="weeklyReportRange">${escapeHtml(range)}</strong><button type="button" id="weeklyReportNext">下一周</button></div>`;
  const historyControl = history.length ? `<label class="weekly-report-history">已保存的周次<select id="weeklyReportHistory"><option value="">选择周次</option>${history.map(start => {
    const item = beijingWeekRange(start);
    const label = `${item.week_start} 至 ${item.week_end}`;
    return `<option value="${escapeHtml(start)}"${start === week.week_start ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('')}</select></label>` : '';
  const reminderHtml = reminder ? `<p class="${reminder.kind === 'due' ? 'weekly-report-reminder' : 'weekly-report-defer'}" role="${reminder.kind === 'due' ? 'alert' : 'status'}">${escapeHtml(reminder.text)}</p>` : '';
  const heading = `<div class="weekly-report-head"><div><p class="kicker">WEEKLY REPORT</p><h1>周报</h1><p>${access === 'submit' ? '填写本人本周的询盘、电话、下单未付、业绩和周报。' : '查看各业务员周报，不能代为保存。'}</p></div><button type="button" id="closeWeeklyReport">← 返回订单中心</button></div>`;

  if (access !== 'submit') {
    const totals = sumWeeklyReports(rows);
    const table = rows.length ? `<table class="weekly-report-table"><thead><tr><th>业务员</th><th>询盘</th><th>电话</th><th>下单未付</th><th>业绩</th><th>周报</th></tr></thead><tbody>${rows.map(row => `<tr><th>${escapeHtml(row.salesperson_name || '业务员')}</th><td>${displayNumber(row.inquiries)}</td><td>${displayNumber(row.calls)}</td><td>${displayNumber(row.unpaid_orders)}</td><td>${displayNumber(row.performance)}</td><td>${reportText(row)}</td></tr>`).join('')}<tr class="weekly-report-total"><th>合计</th><td>${escapeHtml(totals.inquiries)}</td><td>${escapeHtml(totals.calls)}</td><td>${escapeHtml(totals.unpaid_orders)}</td><td>${escapeHtml(totals.performance)}</td><td></td></tr></tbody></table>` : '<p class="weekly-report-empty">这一周还没有周报。</p>';
    return `<section class="weekly-report-shell" data-access="view">${heading}${weekControls}${historyControl}<article class="weekly-report-card">${table}</article></section>`;
  }

  const valueOf = key => own?.[key] == null ? '' : String(own[key]);
  const note = String(own?.note || '').trim();
  const noteHtml = note ? `<p class="weekly-report-note">备注：${escapeHtml(note)}</p>` : '';
  return `<section class="weekly-report-shell" data-access="submit">${heading}${weekControls}${historyControl}<article class="weekly-report-card">${reminderHtml}${noteHtml}<form id="weeklyReportForm"><p class="weekly-report-range">填写周期：${escapeHtml(range)}</p><div class="weekly-report-form"><label>询盘<input name="inquiries" inputmode="numeric" value="${escapeHtml(valueOf('inquiries'))}" autocomplete="off"></label><label>电话<input name="calls" inputmode="numeric" value="${escapeHtml(valueOf('calls'))}" autocomplete="off"></label><label>下单未付<input name="unpaid_orders" inputmode="numeric" value="${escapeHtml(valueOf('unpaid_orders'))}" autocomplete="off"></label><label>业绩<input name="performance" inputmode="decimal" value="${escapeHtml(valueOf('performance'))}" autocomplete="off"></label><label class="wide">周报<textarea name="body">${escapeHtml(valueOf('body'))}</textarea></label></div><p class="weekly-report-error" role="alert"></p><div class="weekly-report-actions"><button class="primary" type="submit" id="saveWeeklyReport">保存</button></div></form></article></section>`;
}

export async function mountWeeklyReport(page, { api, onClose, today = () => new Date() } = {}) {
  let selected = '';
  let data = { access: 'view', reports: [] };
  const paint = () => {
    page.className = 'weekly-report-page';
    page.innerHTML = renderWeeklyReport({ ...data, weekStart: selected, today: today() });
    page.querySelector('#closeWeeklyReport')?.addEventListener('click', event => {
      event.stopPropagation();
      onClose?.();
    });
    page.querySelector('#weeklyReportPrev')?.addEventListener('click', event => {
      event.stopPropagation();
      selected = addCalendarDays(selected, -7);
      paint();
    });
    page.querySelector('#weeklyReportNext')?.addEventListener('click', event => {
      event.stopPropagation();
      selected = addCalendarDays(selected, 7);
      paint();
    });
    page.querySelector('#weeklyReportHistory')?.addEventListener('change', event => {
      event.stopPropagation();
      if (event.target.value) {
        selected = event.target.value;
        paint();
      }
    });
    const form = page.querySelector('#weeklyReportForm');
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      event.stopPropagation();
      const input = Object.fromEntries(new FormData(form).entries());
      input.week_start = selected;
      const parsed = validateWeeklyReportInput(input);
      const error = page.querySelector('.weekly-report-error');
      if (!parsed.ok) {
        if (error) error.textContent = parsed.message;
        alert(parsed.message);
        return;
      }
      const button = form.querySelector('#saveWeeklyReport');
      if (button) button.disabled = true;
      try {
        await api('/rest/v1/rpc/weekly_report', { method: 'POST', body: JSON.stringify({ action: 'save', ...parsed.value }) });
        await load();
      } catch (caught) {
        if (error) error.textContent = caught.message || '保存失败';
        if (button) button.disabled = false;
      }
    });
  };
  async function load() {
    data = await api('/rest/v1/rpc/weekly_report', { method: 'POST', body: JSON.stringify({ action: 'list' }) });
    if (!selected) selected = beijingWeekRange(today()).week_start;
    if (page.isConnected !== false) paint();
  }
  await load();
}
