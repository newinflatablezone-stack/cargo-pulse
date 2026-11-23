import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TencentDataStore, productNameReminder, PRODUCT_NAME_RULE } from '../server/tencent-data-core.mjs';
import { productNameReminder as browserReminder, PRODUCT_NAME_RULE as browserRule } from '../product-name.mjs';

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

test('产品名称 must be Chinese only, with the same message in the browser and the API', () => {
  assert.equal(browserRule, PRODUCT_NAME_RULE);
  assert.equal(PRODUCT_NAME_RULE, '产品名称必须为中文');
  const browser = readFileSync(new URL('../product-name.mjs', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../server/tencent-data-core.mjs', import.meta.url), 'utf8');
  const ruleText = source => {
    const start = source.indexOf('const PRODUCT_NAME_HAN_ONLY');
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  const normalize = source => ruleText(source).replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n');
  assert.equal(normalize(browser), normalize(core));
  const samples = [
    [IMPORTED, IMPORTED],
    [`  ${IMPORTED}  `, IMPORTED],
    [' \n\t ', IMPORTED],
    ['Another English Title', IMPORTED],
    ['气垫', IMPORTED],
    ['气垫 Air Floor', IMPORTED],
    ['气垫', '气垫'],
    ['气垫 Pro', '气垫'],
    ['气垫 城堡', '气垫'],
    ['Castle', ''],
    ['城堡', ''],
    ['', ''],
    ['12345', ''],
    ['气垫123', ''],
    ['气垫。', ''],
    ['气垫-城堡', ''],
    ['プラネタリウム', '']
  ];
  for (const [value, original] of samples) {
    assert.equal(browserReminder(value), productNameReminder(value));
    assert.equal(browserReminder(value, original), productNameReminder(value, original));
  }
  for (const value of [IMPORTED, '   ', '', 'Another English Title', '气垫 Air Floor', '气垫Pro', '气垫123', '12气垫', '气垫。', '气垫-城堡', '气垫，城堡', '12345']) {
    assert.equal(productNameReminder(value), PRODUCT_NAME_RULE);
  }
  assert.equal(productNameReminder(IMPORTED, IMPORTED), PRODUCT_NAME_RULE);
  assert.equal(productNameReminder('气垫'), '');
  assert.equal(productNameReminder('气垫', '气垫'), '');
  assert.equal(productNameReminder('  气垫 城堡  ', '气垫'), '');
  assert.equal(productNameReminder('气垫　城堡'), '');
});

test('下单 blocks anything that is not Chinese only, and accepts Chinese even when it matches the Shopify title', t => {
  const { store, business, follower } = fixture(t);
  const imported = importOrder(store);
  assert.equal(imported.shopify_product_name, IMPORTED);
  assert.equal(imported.product_name, IMPORTED);
  const reject = product_name => assert.throws(
    () => store.shopifyHandoff(business.id, placeBody(imported.id, product_name)),
    error => error.status === 400 && error.message === PRODUCT_NAME_RULE
  );
  reject(IMPORTED);
  reject(`  ${IMPORTED}  `);
  reject('   ');
  reject('Another English Title');
  reject('气垫 Air Floor');
  reject('气垫123');
  reject('气垫。');
  reject('气垫-城堡');
  assert.equal(store.all('orders').find(row => row.id === imported.id).current_step, 'sales_supplement');
  assert.equal(store.all('orders').find(row => row.id === imported.id).product_name, IMPORTED);
  assert.throws(
    () => store.shopifyHandoff(business.id, placeBody(imported.id, IMPORTED, { shopify_product_name: '气垫' })),
    error => error.status === 400 && error.message === PRODUCT_NAME_RULE
  );
  assert.throws(
    () => store.shopifyHandoff(business.id, placeBody(imported.id, IMPORTED, { customer_info: 'Ada\nada@example.com\n+1 5551234567' })),
    error => error.status === 400 && error.message === '客户信息还缺少：地址'
  );
  for (const product_name of ['气垫', '充气城堡', '气垫 城堡']) {
    const fresh = importOrder(store, IMPORTED, { id: 'gid://shopify/Order/' + product_name, order_no: '#' + product_name.length });
    const placed = store.shopifyHandoff(business.id, placeBody(fresh.id, product_name, { order_no: fresh.order_no }));
    const order = store.all('orders').find(row => row.id === placed.id);
    assert.equal(order.current_step, 'follower_create');
    assert.equal(order.product_name, product_name.trim());
    assert.equal(order.shopify_product_name, IMPORTED);
  }
  const chineseImport = importOrder(store, '气垫', { id: 'gid://shopify/Order/chinese', order_no: '#9062' });
  const kept = store.shopifyHandoff(business.id, placeBody(chineseImport.id, '  气垫  ', { order_no: '#9062' }));
  assert.equal(kept.current_step, 'follower_create');
  assert.equal(store.all('orders').find(row => row.id === kept.id).product_name, '气垫');
  assert.equal(store.all('orders').find(row => row.id === kept.id).shopify_product_name, '气垫');
  saveFactory(store, kept.id);
  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: kept.id, order_no: '#9062', product_name: IMPORTED, size: '6m', quantity: 1,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, current_step: 'production'
  });
  assert.equal(created.current_step, 'production');
  assert.equal(store.all('orders').find(row => row.id === created.id).product_name, IMPORTED);
  assert.equal(store.all('orders').find(row => row.id === created.id).shopify_product_name, '气垫');
});

test('保存 blocks a name that is not Chinese only, including non-Shopify orders and 新建下单', t => {
  const { store, business, follower } = fixture(t);
  const imported = importOrder(store);
  const placed = store.shopifyHandoff(business.id, placeBody(imported.id, '气垫'));
  const reject = product_name => assert.throws(
    () => store.updateSalespersonSupplement(business.id, supplementBody(placed.id, product_name)),
    error => error.status === 400 && error.message === PRODUCT_NAME_RULE
  );
  reject(IMPORTED);
  reject(` ${IMPORTED} `);
  reject('   ');
  reject('Castle XL');
  reject('气垫 XL');
  reject('气垫123');
  reject('气垫。');
  const revised = store.updateSalespersonSupplement(business.id, supplementBody(placed.id, '大气垫', { shopify_product_name: 'Castle' }));
  assert.equal(store.all('orders').find(row => row.id === revised.id).product_name, '大气垫');
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
    error => error.status === 400 && error.message === PRODUCT_NAME_RULE
  );
  assert.throws(
    () => store.updateSalespersonSupplement(business.id, supplementBody(created.id, 'Floor Pro')),
    error => error.status === 400 && error.message === PRODUCT_NAME_RULE
  );
  assert.throws(
    () => store.updateSalespersonSupplement(business.id, supplementBody(created.id, '气垫 Floor Pro')),
    error => error.status === 400 && error.message === PRODUCT_NAME_RULE
  );
  const saved = store.updateSalespersonSupplement(business.id, supplementBody(created.id, '气垫地板'));
  assert.equal(store.all('orders').find(row => row.id === saved.id).product_name, '气垫地板');
  assert.equal(store.all('orders').find(row => row.id === saved.id).current_step, 'production');
  const draft = store.salespersonOrder(business.id, { action: 'draft' });
  store.put('order_images', { order_id: draft.id, object_path: `${draft.id}/product-image-photo.jpg`, file_name: '产品图片' });
  const placeCustom = product_name => store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...supplementBody(draft.id, product_name, { order_no: 'IZ-200' }) });
  assert.throws(() => placeCustom('Castle'), error => error.status === 400 && error.message === PRODUCT_NAME_RULE);
  assert.throws(() => placeCustom('   '), error => error.status === 400 && error.message === PRODUCT_NAME_RULE);
  assert.throws(() => placeCustom('气垫 Castle'), error => error.status === 400 && error.message === PRODUCT_NAME_RULE);
  assert.throws(() => placeCustom('气垫2'), error => error.status === 400 && error.message === PRODUCT_NAME_RULE);
  assert.throws(() => placeCustom('气垫！'), error => error.status === 400 && error.message === PRODUCT_NAME_RULE);
  assert.throws(
    () => store.salespersonOrder(business.id, { action: 'place', id: draft.id, ...supplementBody(draft.id, 'Castle', { order_no: 'IZ-200', customer_info: 'Ada\nada@example.com\n+1 5551234567' }) }),
    error => error.status === 400 && error.message === '客户信息还缺少：地址'
  );
  assert.equal(store.all('orders').find(row => row.id === draft.id).current_step, 'salesperson_draft');
  const custom = placeCustom('充气城堡');
  assert.equal(store.all('orders').find(row => row.id === custom.id).current_step, 'follower_create');
  assert.equal(store.all('orders').find(row => row.id === custom.id).product_name, '充气城堡');
  assert.throws(
    () => store.updateSalespersonSupplement(business.id, supplementBody(custom.id, 'Castle XL', { order_no: 'IZ-201' })),
    error => error.status === 400 && error.message === PRODUCT_NAME_RULE
  );
  const renamed = store.updateSalespersonSupplement(business.id, supplementBody(custom.id, '加大气垫', { order_no: 'IZ-201' }));
  assert.equal(store.all('orders').find(row => row.id === renamed.id).product_name, '加大气垫');
  assert.equal(store.all('orders').find(row => row.id === renamed.id).order_no, 'IZ-201');
});

test('the salesperson forms show one Chinese-only error and 创建订单 does not', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../server/tencent-data-core.mjs', import.meta.url), 'utf8');
  const place = app.slice(app.indexOf('function openShopifyPlace'), app.indexOf('function openShopifyCreate'));
  const supplement = app.slice(app.indexOf('function openSalespersonSupplement'), app.indexOf('async function openSalespersonOrder'));
  const create = app.slice(app.indexOf('function openShopifyCreate'), app.indexOf('function detailHtml'));
  const salesOrder = app.slice(app.indexOf('async function openSalespersonOrder'), app.indexOf('function followerFactoryChoices'));
  const factory = app.slice(app.indexOf('function followerFactoryChoices'), app.indexOf('function openShopifyPlace'));
  const reminderMarkup = /<span class="product-name-reminder" hidden><\/span><\/label>/;
  const blocked = /const nameGap=refreshProductName\(\);if\(nameGap\)throw Error\(nameGap\)/;
  const field = source => {
    const at = source.indexOf('产品名称 *');
    return source.slice(at, source.indexOf('</label>', at) + '</label>'.length);
  };
  assert.match(place, /<h2>待业务员认领下单<\/h2>/);
  assert.match(place, /name="product_name" required value="\$\{esc\(o\.product_name\|\|''\)\}"/);
  assert.match(field(place), reminderMarkup);
  assert.equal(field(place).includes('product-name-hint'), false);
  assert.equal((field(place).match(/<(?:small|span)\b/g) || []).length, 1);
  assert.match(place, /bindProductNameRule\(form\)/);
  assert.match(place, blocked);
  assert.match(place, /action:'place'/);
  assert.match(supplement, /name="product_name" required value="\$\{esc\(o\.product_name\|\|''\)\}"/);
  assert.match(field(supplement), reminderMarkup);
  assert.equal(field(supplement).includes('product-name-hint'), false);
  assert.equal((field(supplement).match(/<(?:small|span)\b/g) || []).length, 1);
  assert.match(supplement, /bindProductNameRule\(form\)/);
  assert.match(supplement, blocked);
  assert.equal(supplement.includes('if(o.shopify_order_id){const nameGap'), false);
  assert.match(salesOrder, /<h2>新建下单<\/h2>/);
  assert.match(field(salesOrder), reminderMarkup);
  assert.equal(field(salesOrder).includes('product-name-hint'), false);
  assert.equal((field(salesOrder).match(/<(?:small|span)\b/g) || []).length, 1);
  assert.match(salesOrder, /bindProductNameRule\(form\)/);
  assert.match(salesOrder, blocked);
  assert.match(salesOrder, /action:'place'/);
  assert.equal(create.includes('productNameReminder'), false);
  assert.equal(create.includes('product-name-hint'), false);
  assert.equal(create.includes('product-name-reminder'), false);
  assert.equal(create.includes('bindProductNameRule'), false);
  assert.equal(create.includes('PRODUCT_NAME_RULE'), false);
  assert.equal(factory.includes('product-name-hint'), false);
  assert.equal(factory.includes('product-name-reminder'), false);
  assert.equal(factory.includes('bindProductNameRule'), false);
  assert.match(app, /if\(openFollowerCreate\(o\)\)return/);
  assert.match(app, /followerFactorySaved\(o\)\)\{openShopifyCreate\(o,detailDialog\);return true\}/);
  assert.equal(app.includes('须改为中文或中英混合'), false);
  assert.equal(app.includes('不能直接提交 Shopify 导入的名称'), false);
  assert.equal(app.includes('英文可以写在中文旁边'), false);
  assert.equal(app.includes('product-name-hint'), false);
  assert.equal(/import\s[^;]*product-name\.mjs/.test(core), false);
  assert.match(core, /Browser copy lives in product-name\.mjs/);
  assert.match(core, /export const PRODUCT_NAME_RULE = '产品名称必须为中文'/);
  assert.equal(core.includes('英文可以写在中文旁边'), false);
  assert.match(page, /product-name-rule\.css/);
  const ruleCss = readFileSync(new URL('../product-name-rule.css', import.meta.url), 'utf8');
  assert.match(ruleCss, /\.product-name-reminder\{/);
  assert.equal(ruleCss.includes('product-name-hint'), false);
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
  const refresh = bindProductNameRule(form);
  assert.equal(refresh(), PRODUCT_NAME_RULE);
  assert.equal(reminder.hidden, false);
  assert.equal(reminder.textContent, PRODUCT_NAME_RULE);
  input.value = '   ';
  assert.equal(listeners.input(), PRODUCT_NAME_RULE);
  input.value = '  ' + IMPORTED + '  ';
  assert.equal(listeners.input(), PRODUCT_NAME_RULE);
  input.value = 'Another English Title';
  assert.equal(listeners.input(), PRODUCT_NAME_RULE);
  input.value = '气垫';
  assert.equal(listeners.input(), '');
  assert.equal(reminder.hidden, true);
  assert.equal(reminder.textContent, '');
  input.value = '气垫 Air Floor';
  assert.equal(listeners.input(), PRODUCT_NAME_RULE);
  assert.equal(reminder.hidden, false);
  input.value = '气垫123';
  assert.equal(listeners.input(), PRODUCT_NAME_RULE);
  input.value = '气垫。';
  assert.equal(listeners.input(), PRODUCT_NAME_RULE);
  input.value = '  气垫 城堡  ';
  assert.equal(listeners.input(), '');
  assert.equal(reminder.hidden, true);
});
