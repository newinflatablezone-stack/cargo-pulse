import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TencentDataStore, shopifyLineSummary } from '../server/tencent-data-core.mjs';

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

function inProgress(order) {
  return Boolean(order && !order.deleted_at && order.current_step !== 'completed');
}

test('line item names and quantities become the order title and count', () => {
  assert.deepEqual(shopifyLineSummary([
    { name: ' Arch ', quantity: 2 },
    { name: 'Arch', quantity: 1 },
    { name: 'Blower', quantity: 0 },
    { name: '', quantity: 4 }
  ]), { product_name: 'Arch / Blower', quantity: 7 });
  assert.deepEqual(shopifyLineSummary([{ name: 'Arch', quantity: 1.5 }]), { product_name: 'Arch', quantity: null });
});

test('auto-import creates one shared in-progress order visible to every active user', t => {
  const { store, business, other, follower } = fixture(t);
  const imported = {
    id: 'gid://shopify/Order/9053', order_no: ' #9053 ', order_date: '2026-11-22',
    product_name: 'Arch / Blower', quantity: 3, size: '3 x 2 m',
    customer_info: '1 Main St', requirements: 'rush', blower: '包含', shipping_mode: 'domestic_express',
    image_urls: ['https://cdn.shopify.com/a.jpg', 'http://insecure.example/a.jpg', 'https://cdn.shopify.com/a.jpg']
  };
  const order = store.importShopifyOrder(imported);
  assert.equal(store.importShopifyOrder({ ...imported, id: 'gid://shopify/Order/9053', order_no: '9053' }), null);
  assert.equal(store.importShopifyOrder({ ...imported, id: 'gid://shopify/Order/other', order_no: '#9053' }), null);
  assert.equal(store.all('shopify_order_intake').length, 0);
  assert.equal(store.all('orders').filter(row => row.order_no === '#9053').length, 1);
  assert.equal(order.order_no, '#9053');
  assert.equal(order.current_step, 'business_placed');
  assert.equal(order.product_name, 'Arch / Blower');
  assert.equal(order.quantity, 3);
  assert.equal(order.shipping_mode, 'domestic_express');
  assert.deepEqual(order.shopify_image_urls, ['https://cdn.shopify.com/a.jpg']);
  assert.equal(order.shopify_order_id, imported.id);
  assert.equal(order.shopify_shared, true);
  assert.equal(order.business_id, null);
  assert.equal(order.business_name, '');
  assert.equal(order.created_by, null);
  assert.equal(order.step_deadline, null);
  assert.equal(order.inventory_mode, 'production');
  assert.equal(inProgress(order), true);
  assert.equal(store.all('order_events').find(row => row.order_id === order.id).step_key, 'business_placed');
  for (const user of [business, other, follower]) {
    assert.equal(store.canReadOrder(user.id, order), true);
    assert.equal(store.homeCoreSnapshot(user.id).orders.some(row => row.id === order.id), true);
    assert.equal(store.visibleRows('order_events', user.id).some(row => row.order_id === order.id), true);
  }
  assert.equal(store.canReadOrder(other.id, store.all('orders').find(row => row.id === 'private-order')), false);
  assert.equal(store.homeCoreSnapshot(other.id).orders.some(row => row.id === 'private-order'), false);
  store.put('orders', { ...order, order_no: 'INTERNAL-9053' });
  assert.equal(store.importShopifyOrder({ ...imported, order_no: '#9053' }), null);
  assert.equal(store.all('orders').filter(row => row.shopify_order_id === imported.id).length, 1);
});

test('open unclaimed intake rows become shared in-progress orders without a second copy', t => {
  const { store, business, other, follower, supervisor } = fixture(t);
  const intake = (id, order_no, extra = {}) => store.put('shopify_order_intake', {
    id, order_no, order_date: order_no.endsWith('9052') ? '2026-11-22' : '2026-11-21',
    size: '2 x 3 m', image_urls: ['https://cdn.shopify.com/' + id + '.jpg'],
    customer_info: 'Delivery address', shipping_mode: 'domestic_sea', requirements: '', blower: '', ...extra
  });
  intake('gid://shopify/Order/9051', '#9051');
  intake('gid://shopify/Order/9052', '#9052');
  intake('gid://shopify/Order/claimed', '#9054', { claimed_by: business.id });
  intake('gid://shopify/Order/submitted', '#9050', { submitted_at: '2026-11-21T00:00:00.000Z' });
  intake('gid://shopify/Order/blank', '  ');
  store.put('orders', { id: 'existing-9000', order_no: '#9000', business_id: business.id, business_name: 'Demi', current_step: 'production' });
  intake('gid://shopify/Order/9000', '#9000');

  const first = store.promoteOpenShopifyIntake();
  assert.deepEqual(first.converted.map(row => row.order_no).sort(), ['#9051', '#9052']);
  assert.deepEqual(first.already_present.map(row => row.order_no), ['#9000']);
  assert.deepEqual(first.skipped.map(row => row.reason), ['missing_order_no']);
  const again = store.promoteOpenShopifyIntake();
  assert.deepEqual(again, { converted: [], already_present: [], skipped: [{ id: 'gid://shopify/Order/blank', reason: 'missing_order_no' }] });

  for (const number of ['#9051', '#9052']) {
    const order = store.all('orders').find(row => row.order_no === number);
    assert.equal(order.shopify_shared, true);
    assert.equal(order.current_step, 'business_placed');
    assert.equal(order.business_id, null);
    assert.equal(order.quantity, null);
    assert.equal(order.shipping_mode, 'domestic_sea');
    assert.equal(inProgress(order), true);
    assert.equal(store.canReadOrder(other.id, order), true);
    assert.equal(store.canReadOrder(follower.id, order), true);
    assert.equal(store.importShopifyOrder({ id: order.shopify_order_id, order_no: number }), null);
    const source = store.all('shopify_order_intake').find(row => row.order_no === number);
    assert.equal(Boolean(source.submitted_at), true);
    assert.equal(source.promoted_order_id, order.id);
    assert.equal(store.shopifyIntake(business.id, { action: 'list' }).orders.some(row => row.order_no === number), false);
  }
  const existing = store.all('orders').find(row => row.id === 'existing-9000');
  assert.equal(existing.shopify_shared, undefined);
  assert.equal(store.canReadOrder(other.id, existing), false);
  assert.equal(store.all('orders').filter(row => row.order_no === '#9000').length, 1);
  const claimed = store.all('shopify_order_intake').find(row => row.order_no === '#9054');
  assert.equal(claimed.submitted_at, undefined);
  assert.equal(store.shopifyIntake(business.id, { action: 'list' }).orders.some(row => row.id === claimed.id), true);
  assert.equal(store.all('orders').some(row => row.order_no === '#9054'), false);
  assert.equal(store.all('shopify_order_intake').find(row => row.order_no === '#9050').submitted_at, '2026-11-21T00:00:00.000Z');

  const shared = store.all('orders').find(row => row.order_no === '#9051');
  store.put('orders', { ...shared, deleted_at: '2026-11-22T00:00:00.000Z' });
  const deleted = store.all('orders').find(row => row.order_no === '#9051');
  assert.equal(store.canReadOrder(other.id, deleted), false);
  assert.equal(store.canReadOrder(supervisor.id, deleted), true);
  store.setUserActive(other.id, false);
  assert.equal(store.visibleRows('orders', other.id).length, 0);
});

test('manual order writes cannot grant or remove Shopify-wide visibility', t => {
  const { store, business, other, follower } = fixture(t);
  const url = path => new URL('http://local/rest/v1/orders' + path);
  const created = store.mutate('orders', 'POST', url(''), {
    order_no: 'MANUAL-1', order_date: '2026-11-22', product_name: 'Manual', quantity: 1,
    business_name: 'Demi', shopify_shared: true, shopify_order_id: 'gid://shopify/Order/manual'
  }, follower.id)[0];
  assert.equal(created.shopify_shared, undefined);
  assert.equal(created.shopify_order_id, undefined);
  assert.equal(created.business_id, business.id);
  assert.equal(store.canReadOrder(other.id, created), false);
  const blocked = store.mutate('orders', 'PATCH', url('?id=eq.' + created.id), { shopify_shared: true, shopify_order_id: 'gid://shopify/Order/manual' }, follower.id)[0];
  assert.equal(blocked.shopify_shared, undefined);
  assert.equal(store.canReadOrder(other.id, blocked), false);

  const shared = store.importShopifyOrder({ id: 'gid://shopify/Order/77', order_no: '#9077', order_date: '2026-11-22', product_name: 'Shared', quantity: 1 });
  const assigned = store.mutate('orders', 'PATCH', url('?id=eq.' + shared.id), {
    shopify_shared: false, shopify_order_id: 'gid://shopify/Order/replaced', business_name: 'Demi', product_name: 'Shared arch'
  }, follower.id)[0];
  assert.equal(assigned.shopify_shared, true);
  assert.equal(assigned.shopify_order_id, 'gid://shopify/Order/77');
  assert.equal(assigned.business_id, business.id);
  assert.equal(assigned.product_name, 'Shared arch');
  assert.equal(store.canReadOrder(other.id, assigned), true);
  assert.equal(store.canReadOrder(business.id, assigned), true);
});
