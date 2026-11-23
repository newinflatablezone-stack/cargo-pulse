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

test('the supervisor factory step uses the existing factory list and blocks the create form until it is saved', () => {
  const assign = app.slice(app.indexOf('function openFollowerFactoryAssign'), app.indexOf('function openShopifyPlace'));
  const gate = app.slice(app.indexOf('function openFollowerCreate'), app.indexOf('const factoryExportSelection'));
  const create = app.slice(app.indexOf('function openShopifyCreate'), app.indexOf('function detailHtml'));
  assert.match(assign, /partners\.filter\(p=>p\.kind==='factory'&&p\.active!==false\)/);
  assert.match(assign, /id="followerFactoryForm"/);
  assert.match(assign, /<h2>选择工厂<\/h2>/);
  assert.match(assign, /select name="factory_name"/);
  assert.match(assign, /保存工厂/);
  assert.match(assign, /action:'assign_factory',id:o\.id,factory_name/);
  assert.match(assign, /还没有可选工厂/);
  assert.match(gate, /alert\(FOLLOWER_FACTORY_REQUIRED\)/);
  assert.match(gate, /followerFactorySaved\(o\)\)\{openShopifyCreate\(o,detailDialog\);return true\}/);
  assert.match(create, /input\.readOnly=true/);
  assert.match(create, /工厂由主管选择并保存，跟单不能修改/);
  assert.match(create, /id='changeFollowerFactory'/);
  assert.match(create, /payload\.factory_name=String\(o\.factory_name\|\|''\)\.trim\(\)/);
  assert.match(create, /action:'create'/);
  assert.equal(create.includes('openShopifyPlace'), false);
  assert.equal(create.includes('bindProductNameRule'), false);

  const calls = [];
  const button = { disabled: false };
  const error = { textContent: '' };
  const form = {
    onsubmit: null,
    querySelector(selector) {
      if (selector === 'button.primary') return button;
      if (selector === '.error') return error;
      return null;
    }
  };
  const dialog = {
    innerHTML: '',
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    querySelector(selector) {
      if (selector === 'form') return form;
      if (selector === '.x') return {};
      return null;
    }
  };
  const orders = [{ id: 'wait-1', current_step: 'follower_create', factory_name: '' }];
  runInNewContext(assign + '\nopenFollowerFactoryAssign(order);', {
    order: orders[0],
    orders,
    partners: [
      { kind: 'factory', name: 'Factory A', active: true },
      { kind: 'factory', name: 'Factory B', active: false },
      { kind: 'forwarder', name: 'Forwarder A', active: true }
    ],
    esc: value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])),
    $: () => dialog,
    api: async (path, options) => {
      calls.push({ path, body: JSON.parse(options.body) });
      return { factory_name: 'Factory A' };
    },
    refresh: async () => { calls.push({ path: 'refresh' }); },
    FormData: class {
      get(name) { return name === 'factory_name' ? 'Factory A' : ''; }
    }
  });
  assert.equal(dialog.open, true);
  assert.match(dialog.innerHTML, /<option value="Factory A"/);
  assert.equal(dialog.innerHTML.includes('Factory B'), false);
  assert.equal(dialog.innerHTML.includes('Forwarder A'), false);
  assert.match(dialog.innerHTML, />保存工厂</);
  return form.onsubmit({ preventDefault() {} }).then(() => {
    assert.deepEqual(calls[0], {
      path: '/rest/v1/rpc/shopify_order_handoff',
      body: { action: 'assign_factory', id: 'wait-1', factory_name: 'Factory A' }
    });
    assert.equal(calls[1].path, 'refresh');
    assert.equal(dialog.open, false);
    assert.equal(orders[0].factory_name, 'Factory A');
  });
});
