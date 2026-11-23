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

const orderMatchesStatusTab = runInNewContext(lineFunction('followerFactorySaved') + '\n' + lineFunction('orderMatchesStatusTab') + '\norderMatchesStatusTab');
const displayStepLabel = runInNewContext(
  lineFunction('followerFactorySaved') + '\n' + lineFunction('displayStepLabel') + '\ndisplayStepLabel',
  { STEP_LABELS, displayStepKey(order) { return order.current_step; } }
);

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
    lineFunction('followerFactorySaved') + '\n' + lineFunction('orderMatchesStatusTab') + '\n' +
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
  for (let index = 0; index < 60; index++) rows.push({ id: 'wait-' + index, order_no: 'W-' + index, current_step: 'follower_create', deleted_at: null, factory_name: 'Factory A' });
  rows.push(
    { id: 'await-factory', order_no: 'AF-1', current_step: 'follower_create', deleted_at: null, factory_name: '' },
    { id: 'await-blank', order_no: 'AF-2', current_step: 'follower_create', deleted_at: null, factory_name: '   ' },
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
  assert.match(app, /function orderMatchesStatusTab\(order,status\)\{if\(status==='trash'\)return true;if\(status==='delivered'\)return order\.current_step==='completed';if\(status==='follower_create'\)return order\.current_step==='follower_create'&&followerFactorySaved\(order\);return order\.current_step!=='completed'\}/);
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
    { current_step: 'follower_create', factory_name: 'Factory A' },
    { current_step: 'follower_create', factory_name: 'Factory B' },
    { current_step: 'follower_create' },
    { current_step: 'follower_create', factory_name: '   ' },
    { current_step: 'production' },
    { current_step: 'completed' }
  ];
  const deletedOrders = [{ current_step: 'follower_create', deleted_at: '2026-11-01' }];
  const html = statusTabs('active', true, activeOrders, deletedOrders);
  const pending = button(html, 'follower_create');
  assert.ok(pending);
  assert.equal(pending.text, TAB_LABEL + ' 2');
  assert.equal(pending.className, '');
  assert.equal(button(html, 'active').text, '进行中 5');
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
  assert.equal(waiting.some(order => order.id === 'await-factory'), false);
  assert.equal(waiting.some(order => order.id === 'await-blank'), false);
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
  assert.equal(inProgress.some(order => order.id === 'await-factory'), true);
  assert.equal(inProgress.some(order => order.id === 'await-blank'), true);
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

test('orders without a saved factory stay in 进行中 as 待主管选择工厂, then join 待跟单创建订单 after the factory is saved', () => {
  const waiting = { id: 'await-1', current_step: 'follower_create', deleted_at: null, factory_name: '' };
  const blank = { id: 'await-2', current_step: 'follower_create', deleted_at: null, factory_name: '   ' };
  const ready = { id: 'ready-1', current_step: 'follower_create', deleted_at: null, factory_name: 'Factory A' };
  const production = { id: 'prod-1', current_step: 'production', deleted_at: null, factory_name: 'Factory A' };
  assert.equal(displayStepLabel(waiting), '待主管选择工厂');
  assert.equal(displayStepLabel(blank), '待主管选择工厂');
  assert.equal(displayStepLabel(ready), TAB_LABEL);
  assert.equal(displayStepLabel(production), '生产');
  assert.equal(orderMatchesStatusTab(waiting, 'follower_create'), false);
  assert.equal(orderMatchesStatusTab(blank, 'follower_create'), false);
  assert.equal(orderMatchesStatusTab(waiting, 'active'), true);
  assert.equal(orderMatchesStatusTab(blank, 'active'), true);
  assert.equal(orderMatchesStatusTab(ready, 'follower_create'), true);
  assert.equal(orderMatchesStatusTab(ready, 'active'), true);
  assert.equal(orderMatchesStatusTab(production, 'follower_create'), false);
  waiting.factory_name = 'Factory A';
  assert.equal(orderMatchesStatusTab(waiting, 'follower_create'), true);
  assert.equal(displayStepLabel(waiting), TAB_LABEL);
  assert.match(app, /function displayStepLabel\(o\)\{if\(o\?\.current_step==='follower_create'&&!followerFactorySaved\(o\)\)return '待主管选择工厂'/);
  assert.match(app, /activeOrders\.filter\(o=>orderMatchesStatusTab\(o,'follower_create'\)\)\.length/);
});

function clickOrder(order, person, target) {
  const marker = "document.querySelectorAll('[data-order]').forEach(c=>c.onclick=event=>{";
  const start = app.indexOf(marker);
  const end = app.indexOf("let d=$('#detail')", start);
  assert.ok(start > 0 && end > start);
  const body = app.slice(start + marker.length, end);
  const helperStart = app.indexOf('const SUPERVISOR_EMAIL=');
  const helperEnd = app.indexOf('const factoryExportSelection');
  const salesStart = app.indexOf('function salespersonChoice(');
  const salesEnd = app.indexOf('\nfunction ', app.indexOf('function isOrderSalesperson('));
  const ctx = {
    profile: { ...person },
    session: { user: { email: person.email, id: person.id || 'user' } },
    orders: [order],
    event: { target: target || { closest() { return null; } } },
    c: { dataset: { order: order.id } },
    opened: [],
    openShopifyPlace(row) { ctx.opened.push('place:' + row.id); },
    openShopifyCreate(row) { ctx.opened.push('create:' + row.id); },
    openFollowerFactoryAssign(row) { ctx.opened.push('factory:' + row.id); },
    openSalespersonSupplement(row) { ctx.opened.push('supplement:' + row.id); },
    markOrderNotificationsRead(id) { ctx.opened.push('read:' + id); },
    alert(message) { ctx.opened.push('alert:' + message); }
  };
  runInNewContext(app.slice(helperStart, helperEnd) + '\n' + app.slice(salesStart, salesEnd) + '\nfunction click(event, c){\n' + body + '\nthis.opened.push("detail:"+c.dataset.order);\n}\nclick(event, c);', ctx);
  return ctx.opened;
}

test('a merchandiser click on 待跟单创建订单 opens the create-order form only after a factory is saved', () => {
  const follower = { id: 'follower-1', role: 'follower', email: 'follow@example.com' };
  const supervisor = { id: 'supervisor-1', role: 'business', email: '505863160@qq.com' };
  const owner = { id: 'demi-1', role: 'business', email: 'demi@inflatable-zone.com', display_name: 'Demi' };
  const otherSales = { id: 'ella-1', role: 'business', email: 'ella@inflatable-zone.com', display_name: 'Ella' };
  const waiting = { id: 'wait-1', current_step: 'follower_create', deleted_at: null, business_id: 'demi-1', business_name: 'Demi' };
  const assigned = { ...waiting, id: 'wait-ready', factory_name: 'Factory A' };
  const blankFactory = { ...waiting, factory_name: '   ' };
  const deleted = { id: 'wait-del', current_step: 'follower_create', deleted_at: '2026-11-01', business_id: 'demi-1', factory_name: 'Factory A' };
  const supplement = { id: 'sup-1', current_step: 'sales_supplement', deleted_at: null, business_id: 'demi-1' };
  const production = { id: 'prod-1', current_step: 'production', deleted_at: null, business_id: 'demi-1' };
  const done = { id: 'done-1', current_step: 'completed', deleted_at: null, business_id: 'demi-1' };
  const ownedBySupervisor = { id: 'wait-boss', current_step: 'follower_create', deleted_at: null, business_id: 'supervisor-1', business_name: 'Demi' };
  const blocked = 'alert:主管须先选择工厂并保存后，跟单才能创建订单。';

  assert.deepEqual(clickOrder(waiting, follower), ['read:wait-1', blocked]);
  assert.deepEqual(clickOrder(blankFactory, follower), ['read:wait-1', blocked]);
  assert.equal(clickOrder(waiting, follower).includes('create:wait-1'), false);
  assert.deepEqual(clickOrder(assigned, follower), ['read:wait-ready', 'create:wait-ready']);
  assert.deepEqual(clickOrder(waiting, { ...supervisor, role: 'follower' }), ['read:wait-1', 'detail:wait-1']);
  assert.deepEqual(clickOrder(waiting, supervisor), ['read:wait-1', 'detail:wait-1']);
  assert.equal(clickOrder(waiting, supervisor).includes('factory:wait-1'), false);
  assert.deepEqual(clickOrder(assigned, supervisor), ['read:wait-ready', 'create:wait-ready']);
  assert.deepEqual(clickOrder(assigned, { ...supervisor, role: 'follower' }), ['read:wait-ready', 'create:wait-ready']);
  assert.deepEqual(clickOrder(ownedBySupervisor, supervisor), ['read:wait-boss', 'detail:wait-boss']);
  assert.deepEqual(clickOrder({ ...ownedBySupervisor, factory_name: 'Factory A' }, supervisor), ['read:wait-boss', 'create:wait-boss']);
  assert.deepEqual(clickOrder(waiting, owner), ['read:wait-1', 'detail:wait-1']);
  assert.deepEqual(clickOrder(waiting, otherSales), ['read:wait-1', 'detail:wait-1']);
  assert.deepEqual(clickOrder(deleted, follower), ['read:wait-del', 'detail:wait-del']);
  assert.deepEqual(clickOrder(deleted, supervisor), ['read:wait-del', 'detail:wait-del']);
  assert.deepEqual(clickOrder(deleted, owner), ['read:wait-del', 'detail:wait-del']);
  assert.deepEqual(clickOrder(production, follower), ['read:prod-1', 'detail:prod-1']);
  assert.deepEqual(clickOrder(production, owner), ['read:prod-1', 'detail:prod-1']);
  assert.deepEqual(clickOrder(done, follower), ['read:done-1', 'detail:done-1']);
  assert.deepEqual(clickOrder(supplement, follower), ['read:sup-1', 'detail:sup-1']);
  assert.deepEqual(clickOrder(supplement, owner), ['read:sup-1', 'detail:sup-1']);
  assert.deepEqual(clickOrder(waiting, follower, { closest(selector) { return selector === '.factory-export-check' ? {} : null; } }), []);

  assert.match(app, /if\(o\)void markOrderNotificationsRead\(o\.id\);if\(orderAction\?\.dataset\.orderView==='place'&&orderCardDate\(o\)>=SALESPERSON_DETAIL_CUTOFF\)\{if\(o&&!o\.deleted_at&&o\.current_step==='sales_supplement'&&profile\?\.role==='business'\)\{openShopifyPlace\(o\);return\}if\(o&&!o\.deleted_at&&o\.current_step==='follower_create'&&profile\?\.role==='business'&&isOrderSalesperson\(o\)\)\{openSalespersonSupplement\(o\);return\}/);
  assert.match(app, /openSalespersonSupplement\(o\);return\}return\}if\(openFollowerCreate\(o\)\)return;/);
  assert.match(app, /function openFollowerCreate\(o,detailDialog\)\{if\(!o\|\|o\.deleted_at\|\|o\.current_step!=='follower_create'\|\|!canFollowOrders\(\)\)return false;if\(followerFactorySaved\(o\)\)\{openShopifyCreate\(o,detailDialog\);return true\}if\(isSupervisor\(\)\)return false;alert\(FOLLOWER_FACTORY_REQUIRED\);return true\}/);
  assert.equal(app.slice(app.indexOf('function openFollowerCreate'), app.indexOf('const factoryExportSelection')).includes('openFollowerFactoryAssign'), false);
  assert.match(app, /class="step-name">\$\{esc\(displayStepLabel\(o\)\)\}/);
  assert.match(app, /if\(supervisorAwaitingFactoryDetail\(o\)\)return supervisorSalesReviewHtml\(o\)/);
  assert.match(app, /function supervisorSalesReviewHtml\(o\)\{const note=o\.abnormal_note\|\|o\.requirements\|\|'';return `<div class="detail supervisor-sales-review">/);
  const create = app.slice(app.indexOf('function openShopifyCreate'), app.indexOf('function detailHtml'));
  assert.match(create, /d\.innerHTML=orderForm\(true,true\)/);
  assert.match(create, /textContent='创建订单'/);
  assert.match(create, /bindCustomerInfoRule\(form\)/);
  assert.match(create, /customerInfoReminder\(payload\.customer_info\)/);
  assert.match(create, /action:'create'/);
  assert.match(create, /detailDialog\?\.close\(\)/);
  assert.equal(create.includes('detailDialog.close()'), false);
  assert.match(app, /id="shopifyCreate">创建订单/);
});

test('按当前流程 adds the early statuses without a new tab, and 待主管选择工厂 does not count as 待跟单创建订单', () => {
  const tabs = app.slice(app.indexOf('<div class="status-tabs">'), app.indexOf('</div><div class="result-count">'));
  assert.equal(tabs.includes('待主管选择工厂'), false);
  assert.equal(tabs.includes('awaiting_factory'), false);
  assert.equal(app.includes('按当前流程<select id="workflowStepFilter">'), true);

  const steps = JSON.parse(app.match(/const WORKFLOW_FILTER_STEPS=(\[[^\]]+\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(steps, ['sales_supplement', 'awaiting_factory', 'follower_create']);

  const source = [
    lineFunction('followerFactorySaved'),
    lineFunction('stableStepKey'),
    lineFunction('normalizedWorkflowStep'),
    lineFunction('displayStepKey'),
    lineFunction('displayStepLabel'),
    lineFunction('workflowFilterLabel'),
    lineFunction('workflowStepMatches'),
    'const WORKFLOW_FILTER_STEPS=' + JSON.stringify(steps),
    lineFunction('renderWorkflowStepFilter'),
    'function trackingForStep(){return ""}',
    'function shipmentCurrentNumber(){return ""}',
    'function shipmentRowsForOrder(){return []}'
  ].join('\n');
  const rows = [
    { id: 'sup', current_step: 'sales_supplement', deleted_at: null },
    { id: 'wait', current_step: 'follower_create', factory_name: '', deleted_at: null },
    { id: 'blank', current_step: 'follower_create', factory_name: '   ', deleted_at: null },
    { id: 'ready', current_step: 'follower_create', factory_name: 'Factory A', deleted_at: null },
    { id: 'placed', current_step: 'business_placed', deleted_at: null },
    { id: 'prod', current_step: 'production', deleted_at: null },
    { id: 'handoff', current_step: 'production_shipping', deleted_at: null },
    { id: 'ship', current_step: 'shipping_selection', deleted_at: null },
    { id: 'legacy', current_step: 'ready_to_ship', deleted_at: null },
    { id: 'ocean', current_step: 'ocean_transit', deleted_at: null },
    { id: 'done', current_step: 'completed', deleted_at: null },
    { id: 'gone', current_step: 'follower_create', factory_name: '', deleted_at: '2026-11-01' }
  ];
  let select;
  const filters = { children: [], append(node) { this.children.push(node); } };
  const ctx = {
    session: { user: { id: 'boss' } },
    monthFilter: '',
    redDelayCauseFilter: 'all',
    workflowStepFilter: 'all',
    alertFilter: 'red',
    statusFilter: 'follower_create',
    forwarderPaidFilter: 'paid',
    currentPage: 4,
    rows,
    STEP_LABELS,
    rendered: false,
    render() { ctx.rendered = true; },
    document: {
      createElement() {
        select = { onchange: null };
        return { className: '', innerHTML: '', querySelector() { return select; } };
      },
      querySelector(selector) { return selector === '.index-filters' ? filters : null; },
      querySelectorAll() { return []; }
    }
  };
  runInNewContext(source + '\nrenderWorkflowStepFilter(rows);\nthis.matches=workflowStepMatches;\nthis.label=workflowFilterLabel;', ctx);
  assert.equal(filters.children.length, 1);
  assert.equal(filters.children[0].className, 'workflow-step-filter');
  const html = filters.children[0].innerHTML;
  assert.match(html, /^按当前流程<select id="workflowStepFilter">/);
  assert.equal(html.split('id="workflowStepFilter"').length, 2);
  const options = [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(match => ({ value: match[1], text: match[2] }));
  assert.deepEqual(options.map(option => option.value), ['all', ...steps]);
  assert.equal(options[0].text, '全部流程');
  assert.equal(options[1].text, '待业务员补充信息 (1)');
  assert.equal(options[2].text, '待主管选择工厂 (2)');
  assert.equal(options[3].text, TAB_LABEL + ' (1)');
  assert.equal(options.length, 4);
  assert.equal(html.includes('生产'), false);
  assert.equal(html.includes('选择发货方式'), false);
  assert.equal(html.includes('业务员已下单'), false);
  assert.equal(html.includes('完成生产并发货'), false);
  assert.equal(options.filter(option => option.text.startsWith('待主管选择工厂')).length, 1);
  assert.equal(options.filter(option => option.text.startsWith(TAB_LABEL)).length, 1);

  const waiting = rows[1];
  const blank = rows[2];
  const ready = rows[3];
  assert.equal(ctx.label('awaiting_factory'), displayStepLabel(waiting));
  assert.equal(ctx.label('follower_create'), displayStepLabel(ready));
  assert.equal(ctx.label('sales_supplement'), displayStepLabel(rows[0]));
  assert.equal(ctx.matches(waiting, 'awaiting_factory'), true);
  assert.equal(ctx.matches(blank, 'awaiting_factory'), true);
  assert.equal(ctx.matches(waiting, 'follower_create'), false);
  assert.equal(ctx.matches(blank, 'follower_create'), false);
  assert.equal(ctx.matches(ready, 'follower_create'), true);
  assert.equal(ctx.matches(ready, 'awaiting_factory'), false);
  assert.equal(ctx.matches(rows[0], 'sales_supplement'), true);
  assert.equal(ctx.matches(rows[0], 'awaiting_factory'), false);
  assert.equal(ctx.matches(rows[0], 'follower_create'), false);
  const production = rows.find(row => row.id === 'prod');
  assert.equal(displayStepLabel(production), '生产');
  assert.equal(displayStepLabel(rows.find(row => row.id === 'legacy')), '选择发货方式');
  assert.equal(ctx.matches(production, 'awaiting_factory'), false);
  assert.equal(ctx.matches(production, 'follower_create'), false);
  assert.equal(ctx.matches(production, 'sales_supplement'), false);
  assert.equal(ctx.matches(rows.find(row => row.id === 'gone'), 'awaiting_factory'), true);
  assert.equal(ctx.matches({ current_step: 'production', factory_name: '' }, 'awaiting_factory'), false);
  assert.equal(ctx.matches({ current_step: 'production', factory_name: 'Factory A' }, 'follower_create'), false);

  select.onchange({ target: { value: 'awaiting_factory' } });
  assert.equal(ctx.rendered, true);
  assert.equal(ctx.workflowStepFilter, 'awaiting_factory');
  assert.equal(ctx.statusFilter, 'active');
  assert.equal(ctx.alertFilter, 'all');
  assert.equal(ctx.forwarderPaidFilter, 'all');
  assert.equal(ctx.currentPage, 1);
  select.onchange({ target: { value: 'completed' } });
  assert.equal(ctx.statusFilter, 'delivered');
  assert.equal(ctx.workflowStepFilter, 'completed');
});
