import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TencentDataStore, productNameReminder, PRODUCT_NAME_UNCHANGED_RULE, PRODUCT_NAME_CHINESE_RULE } from '../server/tencent-data-core.mjs';
import { productNameReminder as browserReminder, PRODUCT_NAME_UNCHANGED_RULE as browserUnchanged, PRODUCT_NAME_CHINESE_RULE as browserChinese } from '../product-name.mjs';

const IMPORTED = 'Air Gymnastics Track Mat Us Tumble Trak Air Floor Pro - 20ft x';
const CUSTOMER = 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-product-name-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  return { store, business, follower };
}

function importOrder(store, product_name = IMPORTED, extra = {}) {
  return store.importShopifyOrder({
    id: 'gid://shopify/Order/9052', order_no: '#9052', order_date: '2026-11-22', product_name, quantity: 1,
    image_urls: ['https://cdn.shopify.com/9052.jpg'], customer_info: 'Ada', ...extra
  });
}

function placeBody(id, product_name, extra = {}) {
  return {
    action: 'place', id, order_no: '#9052', product_name, quantity: 1, business_name: 'Demi',
    shipping_mode: 'domestic_sea', blower: '包风机', customer_info: CUSTOMER, abnormal_note: '备注', ...extra
  };
}

function supplementBody(id, product_name, extra = {}) {
  return {
    id, order_no: '#9052', product_name, quantity: 1, business_name: 'Demi',
    shipping_mode: 'domestic_sea', blower: '包风机', customer_info: CUSTOMER, abnormal_note: '备注', ...extra
  };
}

function saveFactory(store, orderId) {
  const supervisor = store.upsertAccount({ email: '505863160@qq.com', role: 'follower' });
  store.put('partners', { id: 'factory-a', kind: 'factory', name: 'Factory A', active: true });
  store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: orderId, factory_name: 'Factory A' });
}

test('product name must change the Shopify title and include Chinese', () => {
  assert.equal(browserUnchanged, PRODUCT_NAME_UNCHANGED_RULE);
  assert.equal(browserChinese, PRODUCT_NAME_CHINESE_RULE);
  const samples = [
    [IMPORTED, IMPORTED],
    [`  ${IMPORTED}  `, IMPORTED],
    [' \n\t ', IMPORTED],
    ['Another English Title', IMPORTED],
    ['气垫', IMPORTED],
    ['气垫 Air Floor', IMPORTED],
    ['气垫', '气垫'],
    ['气垫 Pro', '气垫'],
    ['Castle', ''],
    ['城堡', ''],
    ['', '']
  ];
  for (const [value, original] of samples) {
    assert.equal(browserReminder(value, original), productNameReminder(value, original));
  }
  assert.equal(productNameReminder(IMPORTED, IMPORTED), PRODUCT_NAME_UNCHANGED_RULE);
  assert.equal(productNameReminder(`  ${IMPORTED}  `, IMPORTED), PRODUCT_NAME_UNCHANGED_RULE);
  assert.equal(productNameReminder('   ', IMPORTED), PRODUCT_NAME_UNCHANGED_RULE);
  assert.equal(productNameReminder('Another English Title', IMPORTED), PRODUCT_NAME_CHINESE_RULE);
  assert.equal(productNameReminder('气垫', IMPORTED), '');
  assert.equal(productNameReminder('气垫 Air Floor', IMPORTED), '');
  assert.equal(productNameReminder('气垫', '气垫'), PRODUCT_NAME_UNCHANGED_RULE);
  assert.equal(productNameReminder('气垫 Pro', '气垫'), '');
});

test('下单 blocks an unchanged Shopify title, English-only, and whitespace, and keeps the import', t => {
  const { store, business, follower } = fixture(t);
  const imported = importOrder(store);
  assert.equal(imported.shopify_product_name, IMPORTED);
  assert.equal(imported.product_name, IMPORTED);
  const reject = product_name => assert.throws(
    () => store.shopifyHandoff(business.id, placeBody(imported.id, product_name)),
    error => error.status === 400 && error.message === productNameReminder(product_name, IMPORTED)
  );
  reject(IMPORTED);
  reject(`  ${IMPORTED}  `);
  reject('   ');
  reject('Another English Title');
  assert.equal(store.all('orders').find(row => row.id === imported.id).current_step, 'sales_supplement');
  assert.equal(store.all('orders').find(row => row.id === imported.id).product_name, IMPORTED);
  assert.throws(
    () => store.shopifyHandoff(business.id, placeBody(imported.id, IMPORTED, { shopify_product_name: '别的名称' })),
    error => error.status === 400 && error.message === PRODUCT_NAME_UNCHANGED_RULE
  );
  assert.throws(
    () => store.shopifyHandoff(business.id, placeBody(imported.id, IMPORTED, { customer_info: 'Ada\nada@example.com\n+1 5551234567' })),
    error => error.status === 400 && error.message === '客户信息还缺少：地址'
  );
  for (const product_name of ['气垫', '气垫 Air Floor']) {
    const fresh = importOrder(store, IMPORTED, { id: 'gid://shopify/Order/' + product_name, order_no: '#' + product_name.length });
    const placed = store.shopifyHandoff(business.id, placeBody(fresh.id, product_name, { order_no: fresh.order_no }));
    const order = store.all('orders').find(row => row.id === placed.id);
    assert.equal(order.current_step, 'follower_create');
    assert.equal(order.product_name, product_name);
    assert.equal(order.shopify_product_name, IMPORTED);
  }
  const chineseImport = importOrder(store, '气垫', { id: 'gid://shopify/Order/chinese', order_no: '#9062' });
  assert.throws(
    () => store.shopifyHandoff(business.id, placeBody(chineseImport.id, '  气垫  ', { order_no: '#9062' })),
    error => error.status === 400 && error.message === PRODUCT_NAME_UNCHANGED_RULE
  );
  const createdReady = store.shopifyHandoff(business.id, placeBody(chineseImport.id, '气垫 Pro', { order_no: '#9062' }));
  saveFactory(store, createdReady.id);
  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: createdReady.id, order_no: '#9062', product_name: '气垫', size: '6m', quantity: 1,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, current_step: 'production'
  });
  assert.equal(created.current_step, 'production');
  assert.equal(store.all('orders').find(row => row.id === created.id).product_name, '气垫');
  assert.equal(store.all('orders').find(row => row.id === created.id).shopify_product_name, '气垫');
});

test('补充信息 blocks English-only and a return to the Shopify import, including after 创建订单', t => {
  const { store, business, follower } = fixture(t);
  const imported = importOrder(store);
  const placed = store.shopifyHandoff(business.id, placeBody(imported.id, '气垫'));
  const reject = product_name => assert.throws(
    () => store.updateSalespersonSupplement(business.id, supplementBody(placed.id, product_name)),
    error => error.status === 400 && error.message === productNameReminder(product_name, IMPORTED)
  );
  reject(IMPORTED);
  reject(` ${IMPORTED} `);
  reject('   ');
  reject('Castle XL');
  const revised = store.updateSalespersonSupplement(business.id, supplementBody(placed.id, '气垫 XL', { shopify_product_name: 'Castle' }));
  assert.equal(store.all('orders').find(row => row.id === revised.id).product_name, '气垫 XL');
  assert.equal(store.all('orders').find(row => row.id === revised.id).shopify_product_name, IMPORTED);
  saveFactory(store, placed.id);
  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: placed.id, order_no: '#9052', product_name: IMPORTED, size: '6m', quantity: 1,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, current_step: 'production'
  });
  assert.equal(store.all('orders').find(row => row.id === created.id).product_name, IMPORTED);
  assert.equal(store.all('orders').find(row => row.id === created.id).shopify_product_name, IMPORTED);
  assert.throws(
    () => store.updateSalespersonSupplement(business.id, supplementBody(created.id, IMPORTED)),
    error => error.status === 400 && error.message === PRODUCT_NAME_UNCHANGED_RULE
  );
  assert.throws(
    () => store.updateSalespersonSupplement(business.id, supplementBody(created.id, 'Floor Pro')),
    error => error.status === 400 && error.message === PRODUCT_NAME_CHINESE_RULE
  );
  const saved = store.updateSalespersonSupplement(business.id, supplementBody(created.id, '气垫 Floor Pro'));
  assert.equal(store.all('orders').find(row => row.id === saved.id).product_name, '气垫 Floor Pro');
  assert.equal(store.all('orders').find(row => row.id === saved.id).current_step, 'production');
  const draft = store.salespersonOrder(business.id, { action: 'draft' });
  store.put('order_images', { order_id: draft.id, object_path: `${draft.id}/product-image-photo.jpg`, file_name: '产品图片' });
  const custom = store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...supplementBody(draft.id, 'Castle', { order_no: 'IZ-200' }) });
  const renamed = store.updateSalespersonSupplement(business.id, supplementBody(custom.id, 'Castle XL', { order_no: 'IZ-201' }));
  assert.equal(store.all('orders').find(row => row.id === renamed.id).product_name, 'Castle XL');
});

test('the salesperson forms enforce the rule and 创建订单 does not', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const place = app.slice(app.indexOf('function openShopifyPlace'), app.indexOf('function openShopifyCreate'));
  const supplement = app.slice(app.indexOf('function openSalespersonSupplement'), app.indexOf('async function openSalespersonOrder'));
  const create = app.slice(app.indexOf('function openShopifyCreate'), app.indexOf('function detailHtml'));
  const salesOrder = app.slice(app.indexOf('async function openSalespersonOrder'), app.indexOf('function openShopifyPlace'));
  assert.match(place, /<h2>待业务员补充信息<\/h2>/);
  assert.match(place, /name="product_name" required value="\$\{esc\(o\.product_name\|\|''\)\}"/);
  assert.match(place, /product-name-hint">须改为中文或中英混合，不能保持 Shopify 导入的名称/);
  assert.match(place, /productNameReminder\(form\.elements\.product_name\.value,importedProductName\)/);
  assert.match(place, /bindProductNameRule\(form,importedProductName\)/);
  assert.match(place, /action:'place'/);
  assert.match(supplement, /name="product_name" required value="\$\{esc\(o\.product_name\|\|''\)\}"/);
  assert.match(supplement, /o\.shopify_order_id\?'<small class="product-name-hint">须改为中文或中英混合，不能保持 Shopify 导入的名称<\/small>/);
  assert.match(supplement, /if\(o\.shopify_order_id\)\{const nameGap=productNameReminder\(form\.elements\.product_name\.value,importedProductName\)/);
  assert.equal(create.includes('productNameReminder'), false);
  assert.equal(create.includes('product-name-hint'), false);
  assert.equal(create.includes('bindProductNameRule'), false);
  assert.equal(salesOrder.includes('product-name-hint'), false);
  assert.match(app, /if\(openFollowerCreate\(o\)\)return/);
  assert.match(app, /followerFactorySaved\(o\)\)\{openShopifyCreate\(o,detailDialog\);return true\}/);
  assert.match(page, /product-name-rule\.css/);
  assert.equal(readFileSync(new URL('../style-v2.css', import.meta.url), 'utf8').includes('product-name-hint'), false);
  const line = app.split('\n').find(item => item.startsWith('function bindProductNameRule'));
  const bindProductNameRule = runInNewContext(`${line}\nbindProductNameRule`, { productNameReminder: browserReminder });
  const listeners = {};
  const input = { value: IMPORTED, addEventListener(type, fn) { listeners[type] = fn; }, setAttribute() {} };
  const reminder = { hidden: true, textContent: '' };
  const form = {
    elements: { product_name: input },
    querySelector(selector) { return selector === '.product-name-reminder' ? reminder : null; }
  };
  const refresh = bindProductNameRule(form, IMPORTED);
  assert.equal(refresh(), PRODUCT_NAME_UNCHANGED_RULE);
  assert.equal(reminder.hidden, false);
  input.value = '   ';
  assert.equal(listeners.input(), PRODUCT_NAME_UNCHANGED_RULE);
  input.value = '  ' + IMPORTED + '  ';
  assert.equal(listeners.input(), PRODUCT_NAME_UNCHANGED_RULE);
  input.value = 'Another English Title';
  assert.equal(listeners.input(), PRODUCT_NAME_CHINESE_RULE);
  input.value = '气垫';
  assert.equal(listeners.input(), '');
  assert.equal(reminder.hidden, true);
  input.value = '气垫 Air Floor';
  assert.equal(listeners.input(), '');
});
