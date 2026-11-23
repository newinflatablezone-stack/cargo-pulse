import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TABLES, TencentDataStore, EMPTY_WEEKLY_REPORT_MESSAGE, addCalendarDays as serverAddDays, beijingWeekRange as serverWeekRange } from '../server/tencent-data-core.mjs';
import {
  EMPTY_WEEKLY_REPORT_MESSAGE as CLIENT_EMPTY,
  PRC_ADJUSTED_WORKDAYS,
  addCalendarDays,
  addDecimal,
  beijingWeekRange,
  canOpenWeeklyReport,
  canSubmitWeeklyReport,
  weeklyReportNavCacheKey,
  weeklyReportNavVisible,
  isOfficialHolidayRestDay,
  nextWeeklyReminderWednesday,
  groupWeeklyReportsByMonth,
  renderWeeklyReport,
  sumWeeklyReports,
  validateWeeklyReportInput,
  weeklyReminder,
  weeklyReportMonthKey,
  weeklyReportTotalTitle,
  weeklyReportWeekShortLabel
} from '../weekly-report.js';

const history = JSON.parse(readFileSync(new URL('../fixtures/weekly-reports-history.json', import.meta.url), 'utf8'));
const WEEK = '2026-11-12';

function storeFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-weekly-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account = (email, role = 'business') => store.upsertAccount({ email, password: 'weekly-pass', role });
  return {
    store,
    sherry: account('sherry@inflatable-zone.com'),
    demi: account('demi@inflatable-zone.com'),
    rayna: account('rayna@inflatable-zone.com'),
    ella: account('sales@inflatable-zone.com'),
    follower: account('follower@example.com', 'follower'),
    supervisor: account('505863160@qq.com', 'business')
  };
}

function saved(store, user, extra = {}) {
  return store.weeklyReport(user.id, {
    action: 'save',
    week_start: WEEK,
    inquiries: '2',
    calls: '1',
    unpaid_orders: '0',
    performance: '10',
    body: '已记录',
    ...extra
  });
}

test('Beijing weeks run Thursday through Wednesday, including the Shanghai midnight boundary', () => {
  assert.deepEqual(serverWeekRange('2026-10-29'), { week_start: '2026-10-29', week_end: '2026-11-04' });
  assert.deepEqual(serverWeekRange('2026-11-04'), { week_start: '2026-10-29', week_end: '2026-11-04' });
  assert.deepEqual(serverWeekRange('2026-11-05'), { week_start: '2026-11-05', week_end: '2026-11-11' });
  assert.deepEqual(serverWeekRange('2026-11-12'), { week_start: '2026-11-12', week_end: '2026-11-18' });
  assert.deepEqual(beijingWeekRange('2026-11-18'), serverWeekRange('2026-11-18'));
  const beforeMidnight = new Date('2026-11-18T15:59:59.000Z');
  const midnight = new Date('2026-11-18T16:00:00.000Z');
  assert.deepEqual(serverWeekRange(beforeMidnight), { week_start: '2026-11-12', week_end: '2026-11-18' });
  assert.deepEqual(beijingWeekRange(beforeMidnight), serverWeekRange(beforeMidnight));
  assert.deepEqual(serverWeekRange(midnight), { week_start: '2026-11-19', week_end: '2026-11-25' });
  assert.deepEqual(beijingWeekRange(midnight), serverWeekRange(midnight));
  let cursor = '2025-01-01';
  while (cursor <= '2027-12-31') {
    assert.deepEqual(beijingWeekRange(cursor), serverWeekRange(cursor));
    const noon = new Date(`${cursor}T04:00:00.000Z`);
    const late = new Date(`${cursor}T15:59:00.000Z`);
    assert.deepEqual(beijingWeekRange(noon), serverWeekRange(noon));
    assert.deepEqual(beijingWeekRange(late), serverWeekRange(late));
    cursor = addCalendarDays(cursor, 1);
  }
});

test('official holiday rest days defer the Wednesday reminder, and 调休 workdays do not', () => {
  assert.equal(isOfficialHolidayRestDay('2025-01-01'), true);
  assert.equal(isOfficialHolidayRestDay('2025-10-01'), true);
  assert.equal(isOfficialHolidayRestDay('2025-10-08'), true);
  assert.equal(isOfficialHolidayRestDay('2026-02-18'), true);
  assert.equal(isOfficialHolidayRestDay('2026-10-07'), true);
  assert.equal(isOfficialHolidayRestDay('2027-06-09'), true);
  assert.equal(isOfficialHolidayRestDay('2027-09-15'), true);
  assert.equal(isOfficialHolidayRestDay('2025-10-15'), false);
  assert.equal(isOfficialHolidayRestDay('2026-11-18'), false);
  assert.equal(isOfficialHolidayRestDay('2024-10-01'), false);
  for (const day of PRC_ADJUSTED_WORKDAYS) assert.equal(isOfficialHolidayRestDay(day), false, day);
  assert.equal(nextWeeklyReminderWednesday('2025-10-01'), '2025-10-15');
  assert.equal(nextWeeklyReminderWednesday('2025-10-06'), '2025-10-15');
  assert.equal(nextWeeklyReminderWednesday('2027-06-09'), '2027-06-16');
  assert.equal(nextWeeklyReminderWednesday('2026-02-14'), '2026-02-25');
  assert.equal(nextWeeklyReminderWednesday('2026-11-18'), '2026-11-18');
  const deferred = weeklyReminder('2025-10-01', false);
  assert.equal(deferred.kind, 'deferred');
  assert.equal(deferred.text.includes('2025-10-15'), true);
  assert.equal(deferred.text.includes('尚未保存'), false);
  const due = weeklyReminder('2026-11-16', false);
  assert.equal(due.kind, 'due');
  assert.match(due.text, /2026-11-12 至 2026-11-18/);
  assert.match(due.text, /周三 17:00/);
  assert.equal(weeklyReminder('2026-11-16', true), null);
});

test('empty weekly report input is rejected before a request would be sent', () => {
  assert.equal(CLIENT_EMPTY, EMPTY_WEEKLY_REPORT_MESSAGE);
  const empty = validateWeeklyReportInput({ inquiries: ' ', calls: '', unpaid_orders: '', performance: '', body: '  ' });
  assert.equal(empty.ok, false);
  assert.equal(empty.message, EMPTY_WEEKLY_REPORT_MESSAGE);
  assert.equal(validateWeeklyReportInput({ inquiries: '0', calls: '', unpaid_orders: '', performance: '', body: '' }).ok, true);
  const bodyOnly = validateWeeklyReportInput({ body: '已记录' });
  assert.equal(bodyOnly.ok, false);
  assert.equal(bodyOnly.message, EMPTY_WEEKLY_REPORT_MESSAGE);
  assert.equal(validateWeeklyReportInput({ inquiries: '1', body: '已记录' }).value.body, '已记录');
  assert.equal(validateWeeklyReportInput({ inquiries: '1.5' }).ok, false);
  assert.equal(validateWeeklyReportInput({ performance: '-1' }).ok, false);
  assert.equal(validateWeeklyReportInput({ performance: '5189.15' }).value.performance, '5189.15');
  const source = readFileSync(new URL('../weekly-report.js', import.meta.url), 'utf8');
  const submit = source.slice(source.indexOf("button.addEventListener('click'"), source.indexOf("action: 'save'"));
  assert.ok(submit.indexOf('validateWeeklyReportInput') < submit.indexOf('alert(parsed.message)'));
  assert.ok(submit.indexOf('alert(parsed.message)') < submit.lastIndexOf('return;'));
});

test('the home button is limited to the supervisor, Ella, and submitting salespeople', () => {
  const follower = { role: 'follower', email: 'follower@example.com' };
  const ella = { role: 'business', email: 'sales@inflatable-zone.com' };
  const sherry = { role: 'business', email: 'sherry@inflatable-zone.com' };
  const namedElla = { role: 'business', email: 'other@example.com', display_name: 'Ella' };
  const supervisor = { role: 'follower', email: '505863160@qq.com' };
  assert.equal(canOpenWeeklyReport(follower, false), false);
  assert.equal(canSubmitWeeklyReport(follower, false), false);
  assert.equal(canOpenWeeklyReport(ella, false), true);
  assert.equal(canSubmitWeeklyReport(ella, false), false);
  assert.equal(canSubmitWeeklyReport(namedElla, false), false);
  assert.equal(canOpenWeeklyReport(sherry, false), true);
  assert.equal(canSubmitWeeklyReport(sherry, false), true);
  assert.equal(canOpenWeeklyReport(supervisor, true), true);
  assert.equal(canSubmitWeeklyReport(supervisor, true), false);
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const header = app.slice(app.indexOf('<header>'), app.indexOf('</header>'));
  const resourceStart = header.indexOf('<div class="resource-links">');
  const resource = header.slice(resourceStart, header.indexOf('</div>', resourceStart) + 6);
  const weeklyButton = '<button type="button" id="weeklyReport">周报</button>';
  assert.match(resource, /库存/);
  assert.match(resource, /物流参数/);
  assert.match(resource, /<button id="imageResource">图片下载<\/button>\$\{weeklyReportNavVisible\(\{profile,supervisor,cached:cachedWeeklyNav\(\)\}\)\?`<button type="button" id="weeklyReport">周报<\/button>`:""\}/);
  const toolbarStart = app.indexOf('<div class="tool-actions">');
  const toolbar = app.slice(toolbarStart, app.indexOf('</div>', toolbarStart) + 6);
  assert.equal(toolbar.includes('周报'), false);
  assert.equal(toolbar.includes('weeklyReport'), false);
  assert.match(toolbar, /用户管理/);
  assert.match(toolbar, /工厂 \/ 货代/);
  assert.equal(app.split('id="weeklyReport"').length - 1, 1);
  assert.match(app, /\$\('#weeklyReport'\)\?\.addEventListener\('click',event=>\{event\.stopPropagation\(\);void openWeeklyReport\(\)\}\)/);
  assert.match(app, /weekly-report\.js\?v=20261123-1/);
  assert.match(app, /weekly-report=1/);
  assert.match(html, /\/app-v2\.js\?v=20261123-5"/);
  const followerMarkup = app.slice(app.indexOf('${follower?`'), app.indexOf("`:\"\"}${profile?.role==='business'"));
  assert.equal(followerMarkup.includes('周报'), false);
  assert.equal(followerMarkup.includes('weeklyReport'), false);
  const topNav = (person, supervisor, cached = false) => weeklyReportNavVisible({ profile: person, supervisor, cached })
    ? resource.replace(/\$\{weeklyReportNavVisible\(\{profile,supervisor,cached:cachedWeeklyNav\(\)\}\)\?`([\s\S]*?)`:""\}/, '$1')
    : resource.replace(/\$\{weeklyReportNavVisible\(\{profile,supervisor,cached:cachedWeeklyNav\(\)\}\)\?`[\s\S]*?`:""\}/, '');
  for (const nav of [
    topNav(supervisor, true),
    topNav(sherry, false),
    topNav(ella, false),
    topNav(namedElla, false)
  ]) {
    assert.equal(nav.includes(weeklyButton), true);
    assert.equal((nav.match(/id="weeklyReport"/g) || []).length, 1);
  }
  for (const nav of [
    topNav(follower, false),
    topNav({ role: 'business', email: 'sherry@inflatable-zone.com', disabled_at: '2026-11-01' }, false),
    topNav(null, false)
  ]) {
    assert.equal(nav.includes('周报'), false);
    assert.equal(nav.includes('weeklyReport'), false);
  }
});

test('周报 stays in the first header paint for the supervisor and a cached salesperson', () => {
  const follower = { role: 'follower', email: 'follower@example.com' };
  const sherry = { role: 'business', email: 'sherry@inflatable-zone.com' };
  assert.equal(weeklyReportNavVisible({ profile: null, supervisor: true, cached: false }), true);
  assert.equal(weeklyReportNavVisible({ profile: null, supervisor: false, cached: true }), true);
  assert.equal(weeklyReportNavVisible({ profile: null, supervisor: false, cached: false }), false);
  assert.equal(weeklyReportNavVisible({ profile: follower, supervisor: false, cached: true }), false);
  assert.equal(weeklyReportNavVisible({ profile: sherry, supervisor: false, cached: false }), true);
  assert.equal(weeklyReportNavVisible({ profile: { ...sherry, disabled_at: '2026-11-01' }, supervisor: false, cached: true }), false);
  assert.equal(canOpenWeeklyReport(null, true), false);
  assert.equal(weeklyReportNavCacheKey('user-sherry'), 'cp_weekly_nav_user-sherry');
  assert.equal(weeklyReportNavCacheKey('user-follower'), 'cp_weekly_nav_user-follower');
  assert.equal(weeklyReportNavCacheKey('sherry@inflatable-zone.com'), '');
  assert.equal(weeklyReportNavCacheKey(''), '');
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const refresh = app.slice(app.indexOf('async function refresh'), app.indexOf('function workInProgress'));
  assert.match(refresh, /profile=snapshot\.profile;rememberWeeklyNav\(\)/);
  assert.match(refresh, /profile=nextProfile;rememberWeeklyNav\(\)/);
  assert.match(app, /localStorage\.setItem\(key,canOpenWeeklyReport\(profile,isSupervisor\(\)\)\?'1':'0'\)/);
  assert.match(app, /localStorage\.getItem\(key\)==='1'/);
  const open = app.slice(app.indexOf('async function openWeeklyReport'), app.indexOf('async function uploadShopifyProductImage'));
  assert.ok(open.indexOf('await (refreshInFlight||homeBoot)') < open.indexOf('canOpenWeeklyReport'));
  assert.match(app, /weekly-report\.js\?v=20261123-1/);
});

test('shared monthly summary is the same for viewers and salespeople, and a week belongs to its Wednesday', () => {
  assert.equal(weeklyReportMonthKey('2026-11-04'), '2026-11');
  assert.equal(weeklyReportMonthKey('2026-10-28'), '2026-10');
  const grouped = groupWeeklyReportsByMonth(history.reports);
  assert.deepEqual(grouped.map(group => group.month), ['2026-11']);
  assert.equal(grouped[0].rows.filter(row => row.week_start === '2026-10-29').length, 3);
  const split = groupWeeklyReportsByMonth([
    { salesperson_name: 'Sherry', week_start: '2026-10-22', week_end: '2026-10-28', inquiries: '1', calls: '1', unpaid_orders: '1', performance: '1' },
    { salesperson_name: 'Sherry', week_start: '2026-10-29', week_end: '2026-11-04', inquiries: '2', calls: '2', unpaid_orders: '2', performance: '2' }
  ]);
  assert.deepEqual(split.map(group => [group.month, group.rows.map(row => row.week_start)]), [['2026-11', ['2026-10-29']], ['2026-10', ['2026-10-22']]]);
  assert.equal(grouped[0].totals.performance, '86112.5');
  const view = renderWeeklyReport({ access: 'view', reports: history.reports, today: '2026-11-16' });
  const submit = renderWeeklyReport({
    access: 'submit',
    reports: history.reports.map(row => ({ ...row, user_id: row.salesperson_name })),
    weekStart: WEEK,
    today: '2026-11-16',
    viewerId: 'Sherry'
  });
  for (const html of [view, submit]) {
    assert.equal(html.includes('weeklyReportPrev'), false);
    assert.equal(html.includes('上一周'), false);
    assert.equal(html.includes('2026年10月'), false);
    assert.equal(html.includes('data-month="2026-10"'), false);
    assert.match(html, /2026年11月/);
    assert.match(html, /周期为周四至周三（北京时间）/);
    assert.match(html, /29-4号/);
    assert.match(html, /5-11号/);
    assert.match(html, /12-18号/);
    assert.equal((html.match(/data-month="/g) || []).length, 1);
  }
  const viewSummary = view.slice(view.indexOf('weekly-report-summary'));
  assert.equal((viewSummary.match(/2026-10-29 至 2026-11-04/g) || []).length, 4);
  assert.match(view, />Sherry</);
  assert.match(view, />Demi</);
  assert.match(view, />Rayna</);
  assert.match(view, /三人合计/);
  assert.match(view, />122</);
  assert.match(view, />86112\.5</);
  const submitSummary = submit.slice(submit.indexOf('weekly-report-summary'));
  assert.equal((submitSummary.match(/2026-10-29 至 2026-11-04/g) || []).length, 1);
  assert.match(submit, />Sherry</);
  assert.equal(submit.includes('>Demi<'), false);
  assert.equal(submit.includes('>Rayna<'), false);
  assert.equal(submit.includes('三人合计'), false);
  assert.equal(submit.includes('>122<'), false);
  assert.equal(submit.includes('>86112.5<'), false);
  assert.equal(view.includes('<form'), false);
  assert.equal(view.includes('<input'), false);
  assert.equal(view.includes('weekly-report-save'), false);
  assert.equal(view.includes('data-access="view"'), true);
  assert.equal(submit.includes('<form'), false);
  assert.equal(submit.includes('填写本人周报'), false);
  assert.equal(submit.includes('data-access="submit"'), true);
  assert.equal(submit.includes('导出 Excel'), false);
  assert.equal(view.includes('导出 Excel'), false);
  assert.equal(submit.match(/<input /g), null);
  assert.equal(submit.includes('<textarea'), false);
  assert.equal(submit.includes('weekly-report-save'), false);
  const own = submit.slice(submit.indexOf('data-own="true"'), submit.indexOf('</tbody>', submit.indexOf('data-own="true"')));
  assert.match(own, />Sherry</);
  assert.equal(own.includes('<input'), false);
  assert.deepEqual([...own.matchAll(/data-metric="(inquiries|unpaid_orders|calls|performance)"/g)].map(match => match[1]).filter((metric, index, all) => all.indexOf(metric) === index), ['inquiries', 'unpaid_orders', 'calls', 'performance']);
  const labels = [...own.matchAll(/<th class="sheet-label">([^<]+)<\/th>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['询盘', '下单未付', '电话', '业绩', '备注']);
  assert.equal(own.includes('class="sheet-label">周报<'), false);
  const kept = renderWeeklyReport({
    access: 'submit',
    reports: history.reports.map(row => ({ ...row, user_id: row.salesperson_name, body: row.salesperson_name === 'Sherry' && row.week_start === WEEK ? '已有正文' : '' })),
    today: '2026-11-16',
    viewerId: 'Sherry'
  });
  assert.equal(kept.includes('weekly-report-save'), false);
  assert.equal(kept.includes('data-body="已有正文"'), false);
  assert.equal(kept.includes('<textarea'), false);
  assert.match(submit, />22</);
  assert.match(submit, />24176</);
  assert.equal(submit.includes('value="22"'), false);
  assert.equal(submit.includes('value="24176"'), false);
  assert.equal(submit.includes('value="809.73"'), false);
  assert.equal(own.includes('name="note"'), false);
  assert.equal(submit.includes('尚未保存'), false);
  assert.match(own, /询盘另\+2地址不存在；下单未付另\+1电话冲突/);
  assert.match(submit, />51</);
  assert.match(submit, />57661</);
  assert.equal(submit.includes('>27159.41<'), false);
  assert.match(view, />27159\.41</);
  const unsaved = renderWeeklyReport({ access: 'submit', reports: history.reports, today: '2026-11-16', viewerId: 'sherry' });
  assert.match(unsaved, /尚未保存/);
  assert.equal(unsaved.includes('<form'), false);
  assert.equal(unsaved.includes('导出 Excel'), false);
  const unsavedOwn = unsaved.slice(unsaved.indexOf('data-own="true"'), unsaved.indexOf('</tbody>', unsaved.indexOf('data-own="true"')));
  assert.equal(unsavedOwn.match(/<input /g).length, 4);
  assert.equal(unsavedOwn.includes('<textarea'), false);
  assert.equal(unsavedOwn.includes('class="sheet-label">周报<'), false);
  assert.equal(unsaved.match(/class="weekly-report-save"/g).length, 1);
  assert.equal(unsaved.includes('value="22"'), false);
  assert.match(unsavedOwn, /data-week="2026-11-12"/);
  assert.match(unsaved, /2026年11月/);
  assert.equal(unsaved.includes('>Demi<'), false);
  assert.equal(unsaved.includes('三人合计'), false);
  assert.equal(unsaved.includes('15149'), false);
  assert.equal((unsaved.match(/data-own="true"/g) || []).length, 1);
  assert.equal(unsavedOwn.includes('name="note"'), false);
  assert.equal(unsavedOwn.includes('name="inquiries" data-week="2026-10-29"'), false);
  assert.match(unsavedOwn, /name="inquiries" data-week="2026-11-12"/);
  assert.equal((unsavedOwn.match(/class="weekly-report-save"/g) || []).length, 1);
  const currentOpen = renderWeeklyReport({
    access: 'submit',
    reports: history.reports.map(row => ({ ...row, user_id: row.salesperson_name })),
    today: '2026-11-23',
    viewerId: 'Sherry'
  });
  assert.match(currentOpen, /尚未保存/);
  assert.equal(currentOpen.match(/class="weekly-report-save"/g).length, 1);
  assert.match(currentOpen, /data-week="2026-11-19"/);
  const currentOwn = currentOpen.slice(currentOpen.indexOf('data-own="true"'), currentOpen.indexOf('</tbody>', currentOpen.indexOf('data-own="true"')));
  assert.equal(currentOwn.match(/<input /g).length, 4);
  assert.equal(currentOwn.includes('value="22"'), false);
  assert.match(currentOwn, />22</);
  assert.match(currentOwn, />15149</);
  assert.equal(currentOpen.includes('value="809.73"'), false);
  const otherBlocks = currentOpen.replace(currentOwn, '');
  assert.equal(otherBlocks.includes('<input'), false);
  assert.equal(otherBlocks.includes('weekly-report-save'), false);
  assert.equal(currentOpen.includes('>Demi<'), false);
  assert.equal(currentOpen.includes('>Rayna<'), false);
  assert.equal(currentOpen.includes('三人合计'), false);
});

test('the spreadsheet keeps other months separate and uses 合计 when the people are not exactly the three', () => {
  assert.equal(weeklyReportWeekShortLabel('2026-10-29', '2026-11-04'), '29-4号');
  assert.equal(weeklyReportTotalTitle(['Rayna', 'Demi', 'Sherry']), '三人合计');
  assert.equal(weeklyReportTotalTitle(['Sherry', 'Demi', 'Rayna', 'Amy']), '合计');
  const october = { salesperson_name: 'Sherry', week_start: '2026-10-22', week_end: '2026-10-28', inquiries: '1', calls: '1', unpaid_orders: '1', performance: '9', note: '', body: '正文留在页面' };
  const html = renderWeeklyReport({ access: 'view', reports: [...history.reports, october, { ...october, week_start: '2026-11-19', week_end: '2026-11-25', salesperson_name: 'Amy', body: 'Amy正文' }], today: '2026-11-16' });
  assert.equal(html.includes('导出 Excel'), false);
  assert.equal(html.includes('<input'), false);
  const november = html.slice(html.indexOf('data-month="2026-11"'), html.indexOf('data-month="2026-10"'));
  assert.equal(november.includes('2026-10-22'), false);
  assert.match(november, /29-4号/);
  assert.match(november, /合计/);
  assert.equal(november.includes('三人合计'), false);
  assert.match(html, /data-month="2026-10"/);
  assert.equal(html.includes('Amy正文'), false);
  assert.equal(html.includes('class="sheet-label">周报<'), false);
  const source = readFileSync(new URL('../weekly-report.js', import.meta.url), 'utf8');
  assert.equal(source.includes('导出 Excel'), false);
  assert.equal(source.includes('weekly-report-excel.js'), false);
  assert.equal(canOpenWeeklyReport({ role: 'follower', email: 'follower@example.com' }, false), false);
});

test('historical fixture keeps the confirmed rows, exact 业绩, and separate 备注', () => {
  assert.equal(history.currency, null);
  assert.equal(history.reports.length, 9);
  assert.deepEqual([...new Set(history.reports.map(row => row.week_start))], ['2026-10-29', '2026-11-05', '2026-11-12']);
  assert.deepEqual([...new Set(history.reports.map(row => row.salesperson_name))], ['Sherry', 'Demi', 'Rayna']);
  const text = JSON.stringify(history);
  assert.equal(text.includes('@'), false);
  assert.equal(text.includes('http'), false);
  const byPerson = name => history.reports.filter(row => row.salesperson_name === name);
  assert.deepEqual(byPerson('Sherry').map(row => row.performance), ['15149', '18336', '24176']);
  assert.deepEqual(byPerson('Demi').map(row => row.performance), ['5189.15', '6378.15', '809.73']);
  assert.deepEqual(byPerson('Rayna').map(row => row.performance), ['6821.26', '8373.65', '879.56']);
  assert.equal(byPerson('Sherry')[0].note, '下单未付另+1个 Demi 客户；电话另+2 Demi、+1 Rayna、+1 问物流');
  assert.equal(byPerson('Sherry')[1].note, '询盘另+2个同个客户、+1退信、+1客户自己下单、+1以前客户；下单未付的 1 个是以前客户');
  assert.equal(byPerson('Sherry')[2].note, '询盘另+2地址不存在；下单未付另+1电话冲突');
  assert.equal(byPerson('Demi')[0].note, '询盘另+2个是 Sherry 的客户');
  assert.equal(byPerson('Demi')[1].note, '');
  assert.equal(byPerson('Demi')[2].note, '');
  assert.equal(byPerson('Rayna')[0].note, '询盘另+1已下单用户；下单未付另+1个 Sherry 客户');
  assert.equal(byPerson('Rayna')[1].note, '询盘另+6 Sherry、+1 Demi、+1邮件地址不存在、+2已下单用户；电话另+1 Sherry 客户');
  assert.equal(byPerson('Rayna')[2].note, '询盘另+3 Sherry、+2 Demi、+1邮件地址不存在');
  assert.deepEqual(byPerson('Sherry').map(row => [row.inquiries, row.calls, row.unpaid_orders]), [['6', '6', '3'], ['23', '5', '1'], ['22', '6', '4']]);
  assert.deepEqual(byPerson('Demi').map(row => [row.inquiries, row.calls, row.unpaid_orders]), [['2', '0', '3'], ['21', '1', '1'], ['18', '2', '3']]);
  assert.deepEqual(byPerson('Rayna').map(row => [row.inquiries, row.calls, row.unpaid_orders]), [['4', '1', '3'], ['16', '2', '1'], ['10', '2', '2']]);
  const summed = sumWeeklyReports(history.reports);
  assert.equal(summed.inquiries, '122');
  assert.equal(summed.calls, '25');
  assert.equal(summed.unpaid_orders, '21');
  assert.equal(summed.performance, '86112.5');
  assert.equal(addDecimal(byPerson('Demi').map(row => row.performance)), '12377.03');
  assert.equal(addDecimal(history.reports.filter(row => row.week_start === '2026-11-05').map(row => row.performance)), '33087.8');
  for (const row of history.reports) {
    assert.equal(serverWeekRange(row.week_start).week_end, row.week_end);
    assert.equal(row.body, '');
  }
});

test('salespeople can save and update only their own week; Ella, the supervisor, and followers cannot write', t => {
  const { store, sherry, demi, ella, follower, supervisor } = storeFor(t);
  assert.equal(store.profile(ella.id).role, 'business');
  assert.equal(store.profile(supervisor.id).role, 'follower');
  assert.equal(TABLES.includes('weekly_reports'), false);
  assert.throws(() => store.importRows('weekly_reports', history.reports), /不支持的数据表/);
  assert.throws(() => store.weeklyReport(follower.id, { action: 'list' }), error => error.status === 403 && error.message === '没有周报权限');
  const namedFollower = store.upsertAccount({ email: 'named-follower@example.com', role: 'follower' });
  store.put('profiles', { ...store.profile(namedFollower.id), display_name: 'Ella' });
  assert.throws(() => store.weeklyReport(namedFollower.id, { action: 'list' }), error => error.status === 403);
  assert.throws(() => saved(store, ella), error => error.status === 403 && error.message === '只能查看周报，不能保存');
  assert.throws(() => saved(store, supervisor), error => error.status === 403 && error.message === '只能查看周报，不能保存');
  assert.equal(store.profile(ella.id).role, 'business');
  assert.throws(() => saved(store, sherry, { inquiries: '', calls: '', unpaid_orders: '', performance: '', body: ' ' }), error => error.status === 400 && error.message === EMPTY_WEEKLY_REPORT_MESSAGE);
  assert.equal(store.all('weekly_reports').length, 0);
  assert.throws(() => saved(store, sherry, { week_start: '2026-11-18' }), error => error.status === 400);
  assert.throws(() => saved(store, sherry, { inquiries: '6.2' }), error => error.status === 400);
  assert.equal(store.all('weekly_reports').length, 0);
  const first = saved(store, sherry, { performance: '5189.15', note: '不应写入' });
  assert.equal(first.report.performance, '5189.15');
  assert.equal(first.report.note, '');
  assert.equal(first.report.salesperson_name, 'Sherry');
  assert.equal(first.report.week_end, '2026-11-18');
  assert.equal(JSON.stringify(first).includes('@'), false);
  store.put('weekly_reports', { ...store.all('weekly_reports')[0], note: '历史备注' });
  const updated = saved(store, sherry, { inquiries: '9', calls: '4', unpaid_orders: '2', performance: '15149', body: '已更新', note: '替换备注' });
  assert.equal(updated.report.inquiries, '9');
  assert.equal(updated.report.body, '已更新');
  assert.equal(updated.report.note, '历史备注');
  assert.equal(store.all('weekly_reports').length, 1);
  saved(store, demi, { week_start: '2026-10-29', inquiries: '2', calls: '0', unpaid_orders: '3', performance: '5189.15', body: '' });
  const sherryList = store.weeklyReport(sherry.id, { action: 'list' });
  assert.equal(sherryList.access, 'submit');
  assert.equal(sherryList.viewer_id, sherry.id);
  assert.deepEqual(sherryList.reports.map(row => row.user_id), [sherry.id]);
  const ellaList = store.weeklyReport(ella.id, { action: 'list' });
  const supervisorList = store.weeklyReport(supervisor.id, { action: 'list' });
  assert.equal(ellaList.access, 'view');
  assert.equal(supervisorList.access, 'view');
  assert.equal(ellaList.viewer_id, ella.id);
  assert.deepEqual(ellaList.reports.map(row => row.user_id).sort(), [demi.id, sherry.id].sort());
  assert.deepEqual(supervisorList.reports.map(row => row.user_id).sort(), [demi.id, sherry.id].sort());
  assert.equal(JSON.stringify(supervisorList).includes('@'), false);
  const other = store.upsertAccount({ email: 'other-sales@example.com', role: 'business' });
  assert.equal(saved(store, other, { inquiries: '1' }).report.user_id, other.id);
  assert.equal(store.weeklyReport(sherry.id, { action: 'list' }).reports.some(row => row.user_id === other.id), false);
  assert.equal(store.weeklyReport(sherry.id, { action: 'list' }).reports.some(row => row.user_id === demi.id), false);
  assert.equal(store.weeklyReport(ella.id, { action: 'list' }).reports.some(row => row.user_id === other.id), true);
  assert.equal(store.weeklyReport(supervisor.id, { action: 'list' }).reports.some(row => row.user_id === other.id), true);
  const aliasElla = store.upsertAccount({ email: 'alias-ella@example.com', role: 'business' });
  store.put('profiles', { ...store.profile(aliasElla.id), business_name: 'Ella' });
  assert.throws(() => saved(store, aliasElla), error => error.status === 403);
  assert.equal(store.profile(aliasElla.id).role, 'business');
  store.setUserActive(other.id, false);
  assert.throws(() => store.weeklyReport(other.id, { action: 'list' }), error => error.status === 403);
});

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const { port } = socket.address();
      socket.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw Error(`data server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw Error('data server did not become healthy');
}

test('weekly report API enforces the same permissions and does not expose a table import', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-weekly-http-'));
  const database = join(dir, 'db.sqlite');
  const store = new TencentDataStore(database);
  const sherry = store.upsertAccount({ email: 'sherry@inflatable-zone.com', password: 'weekly-pass', role: 'business' });
  const demi = store.upsertAccount({ email: 'demi@inflatable-zone.com', password: 'weekly-pass', role: 'business' });
  store.upsertAccount({ email: 'sales@inflatable-zone.com', password: 'weekly-pass', role: 'business' });
  store.upsertAccount({ email: 'follower@example.com', password: 'weekly-pass', role: 'follower' });
  store.upsertAccount({ email: '505863160@qq.com', password: 'weekly-pass', role: 'business' });
  assert.equal(store.profile(sherry.id).role, 'business');
  store.db.close();
  const port = await freePort();
  const child = spawn(process.execPath, [resolve('server/tencent-data-server.mjs')], {
    env: { ...process.env, PORT: String(port), CARGO_PULSE_DATA_DIR: dir, CARGO_PULSE_DB: database, CARGO_PULSE_ORDER_UPLOADS: join(dir, 'uploads'), LEGACY_SUPABASE_URL: '', LEGACY_SUPABASE_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    child.kill();
    await new Promise(resolveExit => child.once('exit', resolveExit));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(base, child);
  const login = async email => {
    const response = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'weekly-pass' })
    });
    assert.equal(response.status, 200);
    return { Authorization: `Bearer ${(await response.json()).access_token}`, 'Content-Type': 'application/json' };
  };
  const rpc = (headers, body, method = 'POST') => fetch(`${base}/rest/v1/rpc/weekly_report`, { method, headers, body: JSON.stringify(body) });
  assert.equal((await rpc({}, { action: 'list' })).status, 401);
  const follower = await login('follower@example.com');
  const followerDenied = await rpc(follower, { action: 'list' });
  assert.equal(followerDenied.status, 403);
  assert.equal((await followerDenied.json()).message, '没有周报权限');
  const ella = await login('sales@inflatable-zone.com');
  const ellaSave = await rpc(ella, { action: 'save', week_start: WEEK, inquiries: '1' });
  assert.equal(ellaSave.status, 403);
  assert.equal((await ellaSave.json()).message, '只能查看周报，不能保存');
  const supervisor = await login('505863160@qq.com');
  assert.equal((await rpc(supervisor, { action: 'save', week_start: WEEK, body: '代写' })).status, 403);
  const sherryHeaders = await login('sherry@inflatable-zone.com');
  const empty = await rpc(sherryHeaders, { action: 'save', week_start: WEEK, inquiries: '', calls: '', unpaid_orders: '', performance: '', body: '' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).message, EMPTY_WEEKLY_REPORT_MESSAGE);
  const created = await rpc(sherryHeaders, { action: 'save', week_start: WEEK, inquiries: '22', calls: '6', unpaid_orders: '4', performance: '24176', body: '已记录' });
  assert.equal(created.status, 200);
  const demiHeaders = await login('demi@inflatable-zone.com');
  assert.equal((await rpc(demiHeaders, { action: 'save', week_start: '2026-10-29', inquiries: '2', calls: '0', unpaid_orders: '3', performance: '5189.15', body: '' })).status, 200);
  const updated = await rpc(sherryHeaders, { action: 'save', week_start: WEEK, inquiries: '21', calls: '6', unpaid_orders: '4', performance: '24176', body: '已更新' });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).report.inquiries, '21');
  const own = await (await rpc(sherryHeaders, { action: 'list' })).json();
  assert.equal(own.access, 'submit');
  assert.equal(own.viewer_id, sherry.id);
  assert.equal(own.reports.length, 1);
  assert.equal(own.reports.some(row => row.user_id === sherry.id && row.inquiries === '21'), true);
  assert.equal(own.reports.some(row => row.user_id === demi.id), false);
  const everyone = await (await rpc(ella, { action: 'list' })).json();
  assert.equal(everyone.access, 'view');
  assert.equal(everyone.reports.length, 2);
  assert.deepEqual(everyone.reports.map(row => row.user_id).sort(), [sherry.id, demi.id].sort());
  const supervisorList = await (await rpc(supervisor, { action: 'list' })).json();
  assert.equal(supervisorList.access, 'view');
  assert.deepEqual(supervisorList.reports.map(row => row.user_id).sort(), [sherry.id, demi.id].sort());
  assert.equal((await rpc(supervisor, { action: 'list' })).status, 200);
  assert.equal((await fetch(`${base}/rest/v1/weekly_reports`, { headers: sherryHeaders })).status, 404);
  assert.equal((await fetch(`${base}/rest/v1/rpc/weekly_report`, { method: 'GET', headers: sherryHeaders })).status, 405);
  const core = readFileSync(new URL('../server/tencent-data-core.mjs', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server/tencent-data-server.mjs', import.meta.url), 'utf8');
  assert.equal(core.includes('weekly-report.js'), false);
  assert.equal(server.includes('weekly-report.js'), false);
  assert.equal(serverAddDays('2026-11-12', 6), '2026-11-18');
});
