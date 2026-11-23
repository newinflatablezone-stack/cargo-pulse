import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TencentDataStore } from '../server/tencent-data-core.mjs';

const CUSTOMER = 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567';
const BLOCKED = '主管须先选择工厂并保存后，跟单才能创建订单。';
const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-factory-gate-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  const supervisor = store.upsertAccount({ email: '505863160@qq.com', role: 'business' });
  store.put('partners', { id: 'factory-a', kind: 'factory', name: 'Factory A', active: true });
  store.put('partners', { id: 'factory-b', kind: 'factory', name: 'Factory B', active: false });
  store.put('partners', { id: 'forwarder-a', kind: 'forwarder', name: 'Forwarder A', active: true });
  const order = store.put('orders', {
    id: 'wait-1', order_no: '#9053', current_step: 'follower_create', product_name: 'Arch', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', business_id: business.id
  });
  return { store, business, follower, supervisor, order };
}

function createPayload(extra = {}) {
  return {
    action: 'create', id: 'wait-1', order_no: '#9053', product_name: 'Arch', size: '3 x 2 m', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, shipping_mode: 'domestic_express', current_step: 'production', ...extra
  };
}

test('a merchandiser cannot create 待跟单创建订单 until the supervisor saves a catalog factory', t => {
  const { store, follower, supervisor, business } = fixture(t);
  assert.equal(supervisor.role, 'follower');
  assert.throws(
    () => store.shopifyHandoff(follower.id, createPayload({ factory_name: 'Factory A', factory_names: ['Factory A'] })),
    error => error.status === 400 && error.message === BLOCKED
  );
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').current_step, 'follower_create');
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').factory_name, undefined);
  assert.throws(
    () => store.shopifyHandoff(follower.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }),
    error => error.status === 403 && error.message === '仅主管可以选择并保存工厂'
  );
  assert.throws(
    () => store.shopifyHandoff(business.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }),
    error => error.status === 403
  );
  assert.throws(
    () => store.mutate('orders', 'PATCH', new URL('http://local/rest/v1/orders?id=eq.wait-1'), { factory_name: 'Factory A' }, follower.id),
    error => error.status === 403
  );
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory B' }),
    error => error.status === 400 && error.message === '请选择已有工厂'
  );
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Forwarder A' }),
    error => error.status === 400 && error.message === '请选择已有工厂'
  );
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: '   ' }),
    error => error.status === 400 && error.message === '请选择工厂'
  );
  store.put('orders', { ...store.all('orders').find(row => row.id === 'wait-1'), factory_name: '   ' });
  assert.throws(
    () => store.shopifyHandoff(follower.id, createPayload()),
    error => error.status === 400 && error.message === BLOCKED
  );

  const saved = store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: ' Factory A ' });
  assert.equal(saved.factory_name, 'Factory A');
  assert.equal(saved.current_step, 'follower_create');
  const waiting = store.all('orders').find(row => row.id === 'wait-1');
  assert.equal(waiting.factory_name, 'Factory A');
  assert.equal(waiting.current_step, 'follower_create');
  assert.equal(waiting.order_no, '#9053');
  assert.throws(
    () => store.shopifyHandoff(follower.id, createPayload({ factory_name: 'Factory B' })),
    error => error.status === 400 && error.message === '工厂已由主管保存，不能在创建订单时修改'
  );
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').current_step, 'follower_create');
  assert.equal(store.all('orders').find(row => row.id === 'wait-1').factory_name, 'Factory A');

  const replaced = store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' });
  assert.equal(replaced.factory_name, 'Factory A');
  const created = store.shopifyHandoff(follower.id, createPayload({ factory_names: ['Factory A', 'Extra Shop'] }));
  assert.equal(created.current_step, 'production');
  const order = store.all('orders').find(row => row.id === 'wait-1');
  assert.equal(order.factory_name, 'Factory A');
  assert.deepEqual(store.all('order_factories').filter(row => row.order_id === order.id).map(row => row.factory_name), ['Factory A', 'Extra Shop']);
  assert.throws(
    () => store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }),
    error => error.status === 409
  );
});

function line(name) {
  const found = app.split('\n').find(item => item.startsWith('function ' + name + '('));
  assert.ok(found, name);
  return found;
}

test('a supervisor opens the full order and saves a catalog factory at the bottom', () => {
  const catalog = app.slice(app.indexOf('function followerFactoryChoices'), app.indexOf('function openShopifyPlace'));
  const gate = app.slice(app.indexOf('function openFollowerCreate'), app.indexOf('const factoryExportSelection'));
  const create = app.slice(app.indexOf('function openShopifyCreate'), app.indexOf('function detailHtml'));
  assert.match(catalog, /partners\.filter\(p=>p\.kind==='factory'&&p\.active!==false\)/);
  assert.match(catalog, /id="followerFactoryForm"/);
  assert.match(catalog, /<h3>选择工厂<\/h3>/);
  assert.match(catalog, /select name="factory_name"/);
  assert.match(catalog, /保存工厂/);
  assert.match(catalog, /action:'assign_factory',id:o\.id,factory_name/);
  assert.match(catalog, /还没有可选工厂/);
  assert.match(gate, /if\(isSupervisor\(\)\)return false/);
  assert.equal(gate.includes('openFollowerFactoryAssign'), false);
  assert.match(gate, /alert\(FOLLOWER_FACTORY_REQUIRED\)/);
  assert.match(gate, /followerFactorySaved\(o\)\)\{openShopifyCreate\(o,detailDialog\);return true\}/);
  assert.match(app, /d\.innerHTML=detailHtml\(o\);d\.showModal\(\);bindFollowerFactoryAssign\(d\.querySelector\('#followerFactoryForm'\),o,d\)/);
  assert.match(app, /supervisor&&!followerFactorySaved\(o\)\?followerFactoryAssignHtml\(o\)/);
  assert.equal(create.includes('openFollowerFactoryAssign(o,detailDialog);return'), false);
  assert.match(create, /input\.readOnly=true/);
  assert.match(create, /工厂由主管选择并保存，跟单不能修改/);
  assert.match(create, /id='changeFollowerFactory'/);
  assert.match(create, /payload\.factory_name=String\(o\.factory_name\|\|''\)\.trim\(\)/);
  assert.match(create, /action:'create'/);
  assert.equal(create.includes('openShopifyPlace'), false);
  assert.equal(create.includes('bindProductNameRule'), false);

  const partners = [
    { kind: 'factory', name: 'Factory A', active: true },
    { kind: 'factory', name: 'Factory B', active: false },
    { kind: 'forwarder', name: 'Forwarder A', active: true }
  ];
  const order = {
    id: 'wait-1', order_no: '#9053', product_name: 'Arch', quantity: 2, size: '3 x 2 m',
    customer_info: CUSTOMER, abnormal_note: '请加急', requirements: '请加急', business_name: 'Demi',
    current_step: 'follower_create', factory_name: '', forwarder_name: ''
  };
  const sandbox = {
    partners,
    profile: { role: 'business', email: '505863160@qq.com' },
    STEP_LABELS: { follower_create: '待跟单创建订单' },
    flowFor: () => ['production', 'completed'],
    stableStepKey: step => step,
    esc: value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])),
    orderQuantityLabel: row => row.quantity ?? '',
    returningCustomerHtml: () => '',
    badge: () => '<span class="alert normal">正常</span>',
    factoryProductionHtml: () => '',
    batchShippingHtml: () => '',
    overallDeadline: () => null,
    factoryDisplay: () => '-',
    trackingEntries: () => [],
    proofApplies: () => false,
    needsDeliveryProof: () => false,
    proofRecord: () => null,
    isOrderSalesperson: () => false,
    allFactoriesCompleted: () => true,
    trackingForStep: () => ''
  };
  const source = [
    line('followerFactorySaved'),
    line('followerFactoryChoices'),
    line('followerFactoryFields'),
    line('followerFactoryAssignHtml'),
    line('detailHtml'),
    line('bindFollowerFactoryAssign'),
    line('orderMatchesStatusTab'),
    line('displayStepLabel')
  ].join('\n');
  const view = runInNewContext(source + '\n({html:detailHtml(order),label:displayStepLabel(order),tab:orderMatchesStatusTab(order,"follower_create"),active:orderMatchesStatusTab(order,"active")})', { ...sandbox, order, displayStepKey: row => row.current_step });
  const customerAt = view.html.indexOf('Ada');
  const productAt = view.html.indexOf('<h2>Arch');
  const stepAt = view.html.indexOf('当前步骤');
  const formAt = view.html.indexOf('id="followerFactoryForm"');
  const saveAt = view.html.indexOf('保存工厂');
  assert.ok(productAt >= 0 && stepAt > productAt && customerAt > stepAt && formAt > customerAt && saveAt > formAt);
  assert.match(view.html, /<h2>Arch × 2<\/h2>/);
  assert.match(view.html, /3 x 2 m/);
  assert.match(view.html, /请加急/);
  assert.match(view.html, /<h3>选择工厂<\/h3>/);
  assert.equal(view.html.includes('<h2>选择工厂</h2>'), false);
  assert.equal(view.html.includes('id="shopifyCreate"'), false);
  assert.match(view.html, /<option value="Factory A"/);
  assert.equal(view.html.includes('Factory B'), false);
  assert.equal(view.html.includes('Forwarder A'), false);
  assert.equal(view.label, '待主管选择工厂');
  assert.equal(view.tab, false);
  assert.equal(view.active, true);
  const shown = view.html.replace(/(<dt>当前步骤<\/dt><dd>).*?(<\/dd>)/, '$1' + view.label + '$2');
  assert.ok(shown.indexOf('待主管选择工厂') > stepAt);
  assert.match(app, /label=esc\(displayStepLabel\(o\)\)/);

  sandbox.profile = { role: 'follower', email: 'follow@example.com' };
  const merchandiser = runInNewContext(source + '\ndetailHtml(order)', { ...sandbox, order });
  assert.equal(merchandiser.includes('followerFactoryForm'), false);
  assert.match(merchandiser, /id="shopifyCreate">创建订单/);

  const savedOrder = { ...order, factory_name: 'Factory A' };
  sandbox.profile = { role: 'follower', email: '505863160@qq.com' };
  const ready = runInNewContext(source + '\n({html:detailHtml(order),tab:orderMatchesStatusTab(order,"follower_create"),label:displayStepLabel(order)})', { ...sandbox, order: savedOrder, displayStepKey: row => row.current_step });
  assert.equal(ready.html.includes('followerFactoryForm'), false);
  assert.match(ready.html, /id="shopifyCreate">创建订单/);
  assert.equal(ready.tab, true);
  assert.equal(ready.label, '待跟单创建订单');

  const calls = [];
  const button = { disabled: false };
  const error = { textContent: '' };
  const dialog = { open: true, close() { this.open = false; } };
  const form = {
    onsubmit: null,
    closest() { return dialog; },
    querySelector(selector) {
      if (selector === 'button.primary') return button;
      if (selector === '.error') return error;
      return null;
    }
  };
  const orders = [order];
  runInNewContext(line('bindFollowerFactoryAssign') + '\nbindFollowerFactoryAssign(form, order, dialog);', {
    form,
    order,
    dialog,
    orders,
    api: async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      return { factory_name: 'Factory A', current_step: 'follower_create' };
    },
    refresh: async () => { calls.push({ path: 'refresh' }); },
    FormData: class {
      get(name) { return name === 'factory_name' ? 'Factory A' : ''; }
    }
  });
  return form.onsubmit({ preventDefault() {} }).then(() => {
    assert.deepEqual(calls[0], {
      path: '/rest/v1/rpc/shopify_order_handoff',
      body: { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }
    });
    assert.equal(calls[1].path, 'refresh');
    assert.equal(dialog.open, false);
    assert.equal(order.factory_name, 'Factory A');
    assert.equal(order.current_step, 'follower_create');
    const after = runInNewContext(line('followerFactorySaved') + '\n' + line('orderMatchesStatusTab') + '\n' + line('displayStepLabel') + '\n({tab:orderMatchesStatusTab(order,"follower_create"),label:displayStepLabel(order)})', {
      order,
      STEP_LABELS: { follower_create: '待跟单创建订单' },
      displayStepKey: row => row.current_step
    });
    assert.equal(after.tab, true);
    assert.equal(after.label, '待跟单创建订单');
  });
});
