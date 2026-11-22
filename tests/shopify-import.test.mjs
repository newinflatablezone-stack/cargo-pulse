import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TencentDataStore, shopifyLineSummary, shopifyShippingChoice, shopifyBlowerChoice, shopifyCustomerInfo, lookupCustomerTracking, SHOPIFY_IMPORT_START, SHOPIFY_EXPLICIT_ORDER_NUMBERS, shopifySyncEligible, normalizeBlowerChoice } from '../server/tencent-data-core.mjs';
import { overallDeadline } from '../workflow.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-shopify-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const other = store.upsertAccount({ email: 'sherry@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  const supervisor = store.upsertAccount({ email: '505863160@qq.com', role: 'follower' });
  store.put('orders', { id: 'private-order', order_no: 'PRIVATE-1', business_name: 'Demi', business_id: business.id, current_step: 'production' });
  return { store, business, other, follower, supervisor };
}

const placeFields = {
  order_no: '#9053', product_name: 'Arch', quantity: 2, business_name: 'Sherry',
  shipping_mode: 'domestic_express', blower: '气泵', customer_info: 'Ada\n1 Main St\nada@example.com\n+1 555',
  abnormal_note: '请加急', image_urls: 'https://cdn.shopify.com/a.jpg'
};

test('Shopify shipping, blower and customer text map onto existing order fields', () => {
  assert.equal(shopifyShippingChoice('Sea Freight'), 'domestic_sea');
  assert.equal(shopifyShippingChoice('DHL Express'), 'domestic_express');
  assert.equal(shopifyShippingChoice('Sea Express'), '');
  assert.equal(shopifyShippingChoice('Pickup'), '');
  assert.equal(shopifyBlowerChoice('Includes blower'), '包风机');
  assert.equal(shopifyBlowerChoice('Air Pump shipping'), '包气泵');
  assert.equal(shopifyBlowerChoice('blower and pump'), '');
  assert.equal(normalizeBlowerChoice('风机'), '包风机');
  assert.equal(normalizeBlowerChoice('气泵'), '包气泵');
  assert.equal(normalizeBlowerChoice('不包风机'), '不包风机');
  assert.equal(normalizeBlowerChoice('包含'), '');
  assert.equal(shopifyCustomerInfo({ name: 'Ada', address: '1 Main St', email: 'ada@example.com', phone: '' }), 'Ada\n1 Main St\nada@example.com');
  assert.deepEqual(shopifyLineSummary([{ name: 'Arch', quantity: 2 }, { name: 'Arch', quantity: 1 }]), { product_name: 'Arch', quantity: 3 });
  assert.equal(overallDeadline({ order_date: '2026-11-21', current_step: 'sales_supplement' }), null);
  assert.equal(overallDeadline({ order_date: '2026-11-21', current_step: 'follower_create' }), null);
});

test('the Shopify sync window stays Beijing 2026-11-21 00:00 and also includes order 9050 exactly', () => {
  const source = readFileSync(new URL('../server/tencent-data-server.mjs', import.meta.url), 'utf8');
  assert.equal(SHOPIFY_IMPORT_START, '2026-11-20T16:00:00Z');
  assert.deepEqual(SHOPIFY_EXPLICIT_ORDER_NUMBERS, ['9050']);
  assert.match(source, /shopifySyncEligible/);
  assert.match(source, /created_at:>='"\+SHOPIFY_IMPORT_START\+"'/);
  assert.equal(shopifySyncEligible({ name: '#9050', createdAt: '2026-11-20T15:55:03Z' }), true);
  assert.equal(shopifySyncEligible({ name: '9050', createdAt: '2026-11-20T15:55:03Z' }), true);
  assert.equal(shopifySyncEligible({ name: '#9049', createdAt: '2026-11-20T15:55:03Z' }), false);
  assert.equal(shopifySyncEligible({ name: '#9048', createdAt: '2026-11-20T15:59:59Z' }), false);
  assert.equal(shopifySyncEligible({ name: '#9051', createdAt: '2026-11-20T16:00:00Z' }), true);
  assert.equal(shopifySyncEligible({ name: '#9051', createdAt: '2026-11-20T15:59:59Z' }), false);
});

test('order 9050 imports once into 待业务员补充信息 and an existing later-stage order is left alone', t => {
  const { store } = fixture(t);
  store.put('orders', { id: 'kept-9054', order_no: '#9054', current_step: 'shipping_selection', product_name: 'Keep me' });
  const created = store.importShopifyOrder({
    id: 'gid://shopify/Order/9050', order_no: '#9050', order_date: '2026-11-20', product_name: 'Arch 9050', quantity: 1,
    image_urls: ['https://cdn.shopify.com/9050.jpg'], customer_info: 'Ada', shipping_mode: 'domestic_sea', blower: '风机'
  });
  assert.equal(created.current_step, 'sales_supplement');
  assert.equal(created.order_no, '#9050');
  assert.equal(created.shopify_order_id, 'gid://shopify/Order/9050');
  assert.equal(Boolean(created.shopify_source_refreshed_at), true);
  assert.equal(store.all('orders').filter(row => row.order_no === '#9050').length, 1);
  assert.equal(store.shopifyOrderNeedsRefresh('#9050', created.shopify_order_id), false);
  assert.equal(store.importShopifyOrder({ id: created.shopify_order_id, order_no: '9050', product_name: 'Again', quantity: 8 }), null);
  assert.equal(store.all('orders').find(row => row.id === created.id).product_name, 'Arch 9050');
  assert.equal(store.importShopifyOrder({ id: 'gid://shopify/Order/9054', order_no: '#9054', product_name: 'Rewrite', quantity: 2 }), null);
  assert.equal(store.all('orders').find(row => row.id === 'kept-9054').current_step, 'shipping_selection');
  assert.equal(store.all('orders').find(row => row.id === 'kept-9054').product_name, 'Keep me');
});

test('every in-window order missing from Cargo Pulse becomes 待业务员补充信息, including intake rows and new orders', t => {
  const { store, business, other, follower } = fixture(t);
  const intake = (id, order_no, extra = {}) => store.put('shopify_order_intake', {
    id, order_no, order_date: '2026-11-21', size: '', image_urls: ['https://cdn.shopify.com/' + order_no + '.jpg', 'http://insecure.example/x.jpg'],
    customer_info: 'Old address only', shipping_mode: 'domestic_sea', requirements: 'old note', blower: '包含', ...extra
  });
  intake('gid://shopify/Order/9051', '#9051');
  intake('gid://shopify/Order/9052', '#9052');
  assert.equal(store.shopifyOrderNeedsRefresh('#9053', 'gid://shopify/Order/9053'), true);

  const promoted = store.promoteOpenShopifyIntake();
  assert.deepEqual(promoted.converted.map(row => row.order_no).sort(), ['#9051', '#9052']);
  for (const number of ['#9051', '#9052']) {
    const order = store.all('orders').find(row => row.order_no === number);
    assert.equal(order.current_step, 'sales_supplement');
    assert.equal(order.shopify_shared, undefined);
    assert.equal(order.shopify_source_refreshed_at, undefined);
    assert.equal(order.blower, '');
    assert.equal(store.canReadOrder(other.id, order), true);
    assert.equal(store.canReadOrder(follower.id, order), true);
  }
  assert.deepEqual(store.promoteOpenShopifyIntake().converted, []);

  const third = store.importShopifyOrder({
    id: 'gid://shopify/Order/9053', order_no: '#9053', order_date: '2026-11-22', product_name: 'Castle', quantity: 4,
    size: '', image_urls: ['https://cdn.shopify.com/castle.jpg'], customer_info: 'Bea\n2 Road\nbea@example.com\n+86 1',
    abnormal_note: 'note', requirements: 'note', blower: '风机', shipping_mode: 'domestic_express', country: 'United States'
  });
  assert.equal(store.all('orders').filter(row => row.order_no === '#9053').length, 1);
  assert.equal(third.current_step, 'sales_supplement');
  assert.equal(third.destination_country, '美国');
  assert.equal(third.quantity, 4);
  assert.equal(store.shopifyOrderNeedsRefresh('#9053', third.shopify_order_id), false);
  assert.equal(store.importShopifyOrder({ id: third.shopify_order_id, order_no: '#9053', product_name: 'Other' }), null);
  assert.equal(store.all('orders').find(row => row.id === third.id).product_name, 'Castle');

  const refreshed = store.importShopifyOrder({
    id: 'gid://shopify/Order/9051', order_no: '#9051', product_name: 'Arch', quantity: 1, size: '3 x 2 m',
    customer_info: 'Ada\n1 Main\nada@example.com\n+1', abnormal_note: 'fresh', requirements: 'fresh',
    blower: '气泵', shipping_mode: 'domestic_express', image_urls: ['https://cdn.shopify.com/fresh.jpg']
  });
  assert.equal(store.all('orders').filter(row => row.shopify_order_id === 'gid://shopify/Order/9051').length, 1);
  assert.equal(refreshed.product_name, 'Arch');
  assert.equal(refreshed.size, '3 x 2 m');
  assert.equal(refreshed.customer_info.includes('ada@example.com'), true);
  assert.equal(refreshed.blower, '包气泵');
  assert.equal(Boolean(refreshed.shopify_source_refreshed_at), true);
  assert.equal(store.canReadOrder(other.id, store.all('orders').find(row => row.id === 'private-order')), false);
  assert.equal(lookupCustomerTracking(store, 'ada@example.com').found, false);
});

test('claimed but unsubmitted intake #9052 becomes 待业务员补充信息 and the first live refresh fills empty Shopify fields', t => {
  const { store, business } = fixture(t);
  store.put('orders', { id: 'earlier-9054', order_no: '#9054', current_step: 'shipping_selection', business_name: 'Demi', business_id: business.id, product_name: 'Keep me' });
  store.put('shopify_order_intake', {
    id: 'gid://shopify/Order/19025782341880', order_no: '#9052', order_date: '2026-11-22',
    claimed_by: business.id, submitted_at: '', promoted_order_id: '', product_name: '', quantity: null, image_urls: [], customer_info: 'Addr'
  });
  store.put('shopify_order_intake', { id: 'gid://shopify/Order/claimed-9054', order_no: '#9054', order_date: '2026-11-01', claimed_by: business.id });
  assert.equal(store.shopifyOrderNeedsRefresh('#9052', 'gid://shopify/Order/19025782341880'), true);
  const promoted = store.promoteOpenShopifyIntake();
  assert.deepEqual(promoted.converted.map(row => row.order_no), ['#9052']);
  assert.deepEqual(promoted.already_present.map(row => row.order_no), ['#9054']);
  const order = store.all('orders').find(row => row.order_no === '#9052');
  assert.equal(order.current_step, 'sales_supplement');
  assert.equal(order.product_name, '');
  assert.equal(order.quantity, null);
  assert.equal(order.shopify_order_id, 'gid://shopify/Order/19025782341880');
  assert.equal(order.shopify_source_refreshed_at, undefined);
  const intake = store.all('shopify_order_intake').find(row => row.id === 'gid://shopify/Order/19025782341880');
  assert.equal(Boolean(intake.submitted_at), true);
  assert.equal(intake.promoted_order_id, order.id);
  assert.equal(intake.claimed_by, business.id);
  const earlier = store.all('orders').find(row => row.id === 'earlier-9054');
  assert.equal(earlier.current_step, 'shipping_selection');
  assert.equal(earlier.product_name, 'Keep me');
  assert.equal(store.all('orders').filter(row => row.order_no === '#9054').length, 1);
  const refreshed = store.importShopifyOrder({
    id: 'gid://shopify/Order/19025782341880', order_no: '#9052', product_name: 'Inflatable arch', quantity: 3,
    image_urls: ['https://cdn.shopify.com/9052.jpg']
  });
  assert.equal(refreshed.id, order.id);
  assert.equal(refreshed.current_step, 'sales_supplement');
  assert.equal(refreshed.product_name, 'Inflatable arch');
  assert.equal(refreshed.quantity, 3);
  assert.equal(store.all('orders').filter(row => row.order_no === '#9052').length, 1);
  assert.equal(store.shopifyOrderNeedsRefresh('#9052', order.shopify_order_id), false);
  assert.equal(store.importShopifyOrder({ id: order.shopify_order_id, order_no: '#9052', product_name: 'Again', quantity: 9 }), null);
  assert.equal(store.all('orders').find(row => row.id === order.id).quantity, 3);
});

test('salesperson 下单 then merchandiser 创建订单 follows the normal order path', t => {
  const { store, business, other, follower, supervisor } = fixture(t);
  const imported = store.importShopifyOrder({
    id: 'gid://shopify/Order/9053', order_no: '#9053', order_date: '2026-11-22', product_name: 'Arch', quantity: 2,
    image_urls: ['https://cdn.shopify.com/a.jpg'], customer_info: 'Ada', shipping_mode: 'domestic_express', blower: '气泵'
  });
  assert.throws(() => store.shopifyHandoff(follower.id, { action: 'place', id: imported.id, ...placeFields }), error => error.status === 403);
  assert.throws(() => store.shopifyHandoff(business.id, { action: 'place', id: imported.id, ...placeFields, abnormal_note: '' }), error => error.status === 400);
  assert.equal(store.all('orders').find(row => row.id === imported.id).current_step, 'sales_supplement');
  store.shopifyHandoff(business.id, { action: 'place', id: imported.id, ...placeFields });
  const placed = store.all('orders').find(row => row.id === imported.id);
  assert.equal(placed.current_step, 'follower_create');
  assert.equal(placed.business_id, other.id);
  assert.equal(placed.requirements, '请加急');
  assert.equal(placed.blower, '包气泵');
  assert.equal(store.canReadOrder(other.id, placed), true);
  assert.equal(store.canReadOrder(business.id, placed), false);
  assert.equal(store.canReadOrder(follower.id, placed), true);
  assert.throws(() => store.shopifyHandoff(other.id, { action: 'create', id: imported.id }), error => error.status === 403);
  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: imported.id, order_no: '#9053', order_date: '2026-11-22', product_name: 'Arch',
    size: '3 x 2 m', quantity: 2, customer_info: placeFields.customer_info, business_name: 'Sherry',
    destination_country: '美国', inventory_mode: 'production', needs_rendering: false, shipping_mode: 'domestic_express',
    blower: '气泵', requirements: '请加急', factory_name: 'Factory A', factory_names: ['Factory A'],
    current_step: 'production', step_started_at: '2026-11-22T00:00:00.000Z', step_deadline: '2026-12-02T00:00:00.000Z'
  });
  const order = store.all('orders').find(row => row.id === created.id);
  assert.equal(order.current_step, 'production');
  assert.equal(order.business_id, other.id);
  assert.equal(order.factory_name, 'Factory A');
  assert.equal(order.shopify_order_id, 'gid://shopify/Order/9053');
  assert.equal(store.all('order_events').some(row => row.order_id === order.id && row.step_key === 'production' && !row.completed_at), true);
  assert.equal(store.all('order_factories').filter(row => row.order_id === order.id).length, 1);
  assert.equal(store.canReadOrder(business.id, order), false);
  assert.equal(store.importShopifyOrder({ id: order.shopify_order_id, order_no: '#9053', product_name: 'Duplicate' }), null);
  assert.equal(store.all('orders').find(row => row.id === order.id).product_name, 'Arch');
  assert.equal(lookupCustomerTracking(store, 'ada@example.com').found, true);
  assert.throws(() => store.shopifyHandoff(supervisor.id, { action: 'create', id: imported.id, current_step: 'production' }), error => error.status === 409);
  const hidden = store.importShopifyOrder({ id: 'gid://shopify/Order/deleted', order_no: '#9099', product_name: 'Hide' });
  store.put('orders', { ...hidden, deleted_at: '2026-11-22T00:00:00.000Z' });
  const deleted = store.all('orders').find(row => row.id === hidden.id);
  assert.equal(store.canReadOrder(other.id, deleted), false);
  assert.equal(store.canReadOrder(supervisor.id, deleted), true);
  store.setUserActive(other.id, false);
  assert.equal(store.visibleRows('orders', other.id).length, 0);
});

test('salesperson can add a product image without pasting a URL, and old blower words still submit', t => {
  const { store, business, follower } = fixture(t);
  const order = store.importShopifyOrder({ id: 'gid://shopify/Order/img', order_no: '#9088', product_name: 'Photo', quantity: 1, image_urls: [] });
  const path = order.id + '/product-image-photo.jpg';
  assert.equal(store.canUploadShopifyProductImage(business.id, path), true);
  assert.equal(store.canUploadShopifyProductImage(business.id, order.id + '/delivery-proof-photo.jpg'), false);
  assert.equal(store.canUploadShopifyProductImage(follower.id, path), false);
  const url = new URL('http://local/rest/v1/order_images');
  store.mutate('order_images', 'POST', url, { order_id: order.id, object_path: path, file_name: '产品图片' }, business.id);
  assert.throws(() => store.mutate('order_images', 'POST', url, { order_id: order.id, object_path: order.id + '/delivery-proof-photo.jpg', file_name: '签收证明' }, business.id), error => error.status === 403);
  const placed = store.shopifyHandoff(business.id, { action: 'place', id: order.id, order_no: '#9088', product_name: 'Photo', quantity: 1, business_name: 'Demi', shipping_mode: 'other', blower: '不包气泵', customer_info: 'Ada', abnormal_note: '备注' });
  assert.equal(store.all('orders').find(row => row.id === placed.id).blower, '不包气泵');
  const legacy = store.importShopifyOrder({ id: 'gid://shopify/Order/old', order_no: '#9089', product_name: 'Old', quantity: 1, image_urls: ['https://cdn.shopify.com/old.jpg'], blower: '风机' });
  assert.equal(legacy.blower, '包风机');
  store.shopifyHandoff(business.id, { action: 'place', id: legacy.id, order_no: '#9089', product_name: 'Old', quantity: 1, business_name: 'Demi', shipping_mode: 'domestic_sea', blower: '气泵', customer_info: 'Ada', abnormal_note: '备注', image_urls: 'https://cdn.shopify.com/old.jpg' });
  assert.equal(store.all('orders').find(row => row.id === legacy.id).blower, '包气泵');
});

test('salesperson card opens the supplement form directly and the form shows images instead of URL text', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  assert.match(app, /current_step==='sales_supplement'&&profile\?\.role==='business'\)\{openShopifyPlace\(o\);return\}/);
  assert.match(app, /包风机/);
  assert.match(app, /不包气泵/);
  assert.match(app, /type="file" accept="image\/\*"/);
  assert.equal(app.includes('name="image_urls"'), false);
});

test('ordinary orders cannot be made visible by posing as a Shopify handoff', t => {
  const { store, business, other, follower } = fixture(t);
  const url = path => new URL('http://local/rest/v1/orders' + path);
  assert.throws(() => store.mutate('orders', 'POST', url(''), {
    order_no: 'MANUAL-1', business_name: 'Demi', current_step: 'sales_supplement', shopify_order_id: 'gid://shopify/Order/manual'
  }, follower.id), error => error.status === 403);
  const created = store.mutate('orders', 'POST', url(''), {
    order_no: 'MANUAL-1', order_date: '2026-11-22', product_name: 'Manual', quantity: 1,
    business_name: 'Demi', shopify_shared: true, shopify_order_id: 'gid://shopify/Order/manual', current_step: 'production'
  }, follower.id)[0];
  assert.equal(created.shopify_shared, undefined);
  assert.equal(created.shopify_order_id, undefined);
  assert.equal(store.canReadOrder(other.id, created), false);
  assert.equal(store.canReadOrder(business.id, created), true);
  assert.throws(() => store.mutate('orders', 'PATCH', url('?id=eq.' + created.id), { current_step: 'sales_supplement', shopify_order_id: 'gid://shopify/Order/manual' }, follower.id), error => error.status === 403);
  const waiting = store.importShopifyOrder({ id: 'gid://shopify/Order/77', order_no: '#9077', product_name: 'Wait', quantity: 1 });
  assert.throws(() => store.mutate('orders', 'PATCH', url('?id=eq.' + waiting.id), { product_name: 'Edited' }, follower.id), error => error.status === 403);
  assert.equal(store.all('orders').find(row => row.id === waiting.id).product_name, 'Wait');
});
