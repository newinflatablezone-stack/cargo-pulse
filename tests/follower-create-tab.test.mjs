import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { STEP_LABELS } from '../workflow.js';

const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const TAB_LABEL = '待跟单创建订单';

function lineFunction(name) {
  const line = app.split('\n').find(item => item.startsWith('function ' + name + '('));
  assert.ok(line, name);
  return line;
}

const orderMatchesStatusTab = runInNewContext(lineFunction('orderMatchesStatusTab') + '\norderMatchesStatusTab');

function roleHelpers() {
  const start = app.indexOf("const SUPERVISOR_EMAIL=");
  const end = app.indexOf('const factoryExportSelection');
  const ctx = { profile: null, session: null };
  runInNewContext(app.slice(start, end) + '\nthis.canFollowOrders=canFollowOrders;', ctx);
  return ctx;
}

function statusTabs(statusFilter, follower, activeOrders, deletedOrders) {
  const start = app.indexOf('<div class="status-tabs">');
  const end = app.indexOf('</div><div class="result-count">') + '</div>'.length;
  const raw = app.slice(start, end);
  return runInNewContext(
    '(function(statusFilter, follower, activeOrders, deletedOrders){ return `' + raw + '`; })'
  )(statusFilter, follower, activeOrders, deletedOrders);
}

function button(html, status) {
  const match = html.match(new RegExp('<button class="([^"]*)" data-status="' + status + '">([\\s\\S]*?)</button>'));
  return match && { className: match[1], text: match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), html: match[0] };
}

function applyStatusClick(status, state) {
  const body = app.match(/\[data-status\]'\)\.forEach\(b=>b\.onclick=\(\)=>\{([^}]+)\}\)/)[1];
  const ctx = { ...state, b: { dataset: { status } }, render() { ctx.rendered = true; } };
  runInNewContext('(function(b){ ' + body + ' })(b)', ctx);
  return ctx;
}

function applyWorkflowStep(step, state) {
  const body = app.match(/workflowStepFilter=e\.target\.value;if\(workflowStepFilter==='completed'\)redDelayCauseFilter='all';else forwarderPaidFilter='all';alertFilter='all';statusFilter=workflowStepFilter==='completed'\?'delivered':'active'/)[0];
  const ctx = { ...state, e: { target: { value: step } } };
  runInNewContext(body, ctx);
  return ctx;
}

function tabOrders(rows, status, follower) {
  const source = status === 'trash' && follower ? rows.filter(order => order.deleted_at) : rows.filter(order => !order.deleted_at);
  return source.filter(order => orderMatchesStatusTab(order, status));
}

function sampleOrders() {
  const rows = [];
  for (let index = 0; index < 60; index++) rows.push({ id: 'wait-' + index, order_no: 'W-' + index, current_step: 'follower_create', deleted_at: null });
  rows.push(
    { id: 'wait-deleted', order_no: 'W-DEL', current_step: 'follower_create', deleted_at: '2026-11-01' },
    { id: 'supplement', order_no: 'SUP', current_step: 'sales_supplement', deleted_at: null },
    { id: 'production', order_no: 'PROD', current_step: 'production', deleted_at: null },
    { id: 'done', order_no: 'DONE', current_step: 'completed', deleted_at: null },
    { id: 'done-deleted', order_no: 'DONE-DEL', current_step: 'completed', deleted_at: '2026-11-02' }
  );
  return rows;
}

test('待跟单创建订单 is the existing follower_create step', () => {
  assert.equal(STEP_LABELS.follower_create, TAB_LABEL);
  assert.equal(app.includes("data-status=\"follower_create\">" + TAB_LABEL), true);
  assert.equal(app.includes('data-status="pending_create"'), false);
  assert.match(app, /function orderMatchesStatusTab\(order,status\)\{if\(status==='trash'\)return true;if\(status==='delivered'\)return order\.current_step==='completed';if\(status==='follower_create'\)return order\.current_step==='follower_create';return order\.current_step!=='completed'\}/);
  assert.match(app, /source=statusFilter==='trash'&&follower\?deletedOrders:activeOrders,filteredList=source\.filter\(o=>orderMatchesStatusTab\(o,statusFilter\)/);
  const filterAt = app.indexOf('filteredList=source.filter(o=>orderMatchesStatusTab(o,statusFilter)');
  const sliceAt = app.indexOf('list=filteredList.slice', filterAt);
  assert.ok(filterAt > 0 && sliceAt > filterAt);
});

test('the tab is visible to 跟单 and 主管, and hidden from 业务员', () => {
  const { canFollowOrders } = roleHelpers();
  const follower = { role: 'follower', email: 'follow@example.com' };
  const supervisor = { role: 'business', email: '505863160@qq.com' };
  const salesperson = { role: 'business', email: 'demi@inflatable-zone.com' };
  assert.equal(canFollowOrders(follower), true);
  assert.equal(canFollowOrders(supervisor), true);
  assert.equal(supervisor.role, 'follower');
  assert.equal(canFollowOrders(salesperson), false);
  assert.match(app, /const follower=canFollowOrders\(\),supervisor=isSupervisor\(\);if\(statusFilter==='follower_create'&&!follower\)statusFilter='active'/);

  const activeOrders = [
    { current_step: 'follower_create' },
    { current_step: 'follower_create' },
    { current_step: 'production' },
    { current_step: 'completed' }
  ];
  const deletedOrders = [{ current_step: 'follower_create', deleted_at: '2026-11-01' }];
  const html = statusTabs('active', true, activeOrders, deletedOrders);
  const pending = button(html, 'follower_create');
  assert.ok(pending);
  assert.equal(pending.text, TAB_LABEL + ' 2');
  assert.equal(pending.className, '');
  assert.equal(button(html, 'active').className, 'active');
  assert.ok(button(html, 'trash'));
  assert.equal(html.includes('data-status="follower_create"'), true);
  const hidden = statusTabs('follower_create', false, activeOrders, deletedOrders);
  assert.equal(hidden.includes(TAB_LABEL), false);
  assert.equal(hidden.includes('data-status="follower_create"'), false);
  assert.equal(hidden.includes('回收站'), false);
  assert.ok(button(hidden, 'active'));
  assert.ok(button(hidden, 'delivered'));
  const selected = statusTabs('follower_create', true, activeOrders, deletedOrders);
  assert.equal(button(selected, 'follower_create').className, 'active');
  assert.equal(button(selected, 'active').className, '');
  assert.equal(button(selected, 'delivered').className, '');
  assert.equal(button(selected, 'trash').className, '');

  const business = app.slice(app.indexOf("${profile?.role==='business'?`"), app.indexOf('<div class="index-filters">'));
  assert.equal(business.includes(TAB_LABEL), false);
  assert.equal(business.includes('follower_create'), false);
});

test('clicking 待跟单创建订单 filters every visible order in that step, then the other tabs clear it', () => {
  const rows = sampleOrders();
  const state = { statusFilter: 'active', alertFilter: 'red', workflowStepFilter: 'production', currentPage: 3 };
  const opened = applyStatusClick('follower_create', state);
  assert.equal(opened.rendered, true);
  assert.equal(opened.statusFilter, 'follower_create');
  assert.equal(opened.alertFilter, 'all');
  assert.equal(opened.workflowStepFilter, 'all');
  assert.equal(opened.currentPage, 1);
  const waiting = tabOrders(rows, opened.statusFilter, true);
  assert.equal(waiting.length, 60);
  assert.ok(waiting.every(order => order.current_step === 'follower_create' && !order.deleted_at));
  assert.equal(waiting.some(order => order.id === 'wait-59'), true);
  assert.equal(waiting.some(order => order.id === 'wait-0'), true);
  assert.equal(waiting.some(order => order.id === 'wait-deleted'), false);
  assert.equal(waiting.some(order => order.id === 'supplement'), false);
  assert.equal(waiting.some(order => order.id === 'production'), false);
  assert.equal(waiting.some(order => order.id === 'done'), false);
  const pageSize = 50;
  assert.equal(waiting.slice(0, pageSize).length, pageSize);
  assert.equal(waiting.slice(pageSize).some(order => order.id === 'wait-59'), true);

  const active = applyStatusClick('active', opened);
  assert.equal(active.statusFilter, 'active');
  assert.equal(active.workflowStepFilter, 'all');
  const inProgress = tabOrders(rows, active.statusFilter, true);
  assert.equal(inProgress.some(order => order.id === 'wait-59'), true);
  assert.equal(inProgress.some(order => order.id === 'production'), true);
  assert.equal(inProgress.some(order => order.id === 'supplement'), true);
  assert.equal(inProgress.some(order => order.id === 'done'), false);
  assert.equal(inProgress.some(order => order.deleted_at), false);

  const delivered = applyStatusClick('delivered', active);
  const arrived = tabOrders(rows, delivered.statusFilter, true);
  assert.deepEqual(arrived.map(order => order.id), ['done']);

  const trash = applyStatusClick('trash', delivered);
  const deleted = tabOrders(rows, trash.statusFilter, true);
  assert.deepEqual(deleted.map(order => order.id).sort(), ['done-deleted', 'wait-deleted']);

  const again = applyStatusClick('follower_create', { ...trash, workflowStepFilter: 'production', currentPage: 2 });
  assert.equal(again.workflowStepFilter, 'all');
  assert.equal(tabOrders(rows, again.statusFilter, true).length, 60);

  const workflow = applyWorkflowStep('production', { ...again, redDelayCauseFilter: 'factory', forwarderPaidFilter: 'unpaid' });
  assert.equal(workflow.workflowStepFilter, 'production');
  assert.equal(workflow.statusFilter, 'active');
  assert.equal(workflow.alertFilter, 'all');
  assert.equal(tabOrders(rows, workflow.statusFilter, true).some(order => order.current_step === 'follower_create'), true);
  const completedStep = applyWorkflowStep('completed', workflow);
  assert.equal(completedStep.statusFilter, 'delivered');
  assert.equal(tabOrders(rows, completedStep.statusFilter, true).every(order => order.current_step === 'completed'), true);

  let statusFilter = 'follower_create';
  const follower = false;
  if (statusFilter === 'follower_create' && !follower) statusFilter = 'active';
  assert.equal(statusFilter, 'active');
  assert.equal(tabOrders(rows, statusFilter, false).some(order => order.current_step === 'production'), true);
  assert.equal(tabOrders(rows, 'follower_create', false).some(order => order.current_step === 'follower_create'), true);
});
