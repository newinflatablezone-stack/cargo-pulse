import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TencentDataStore, beijingOrderDate } from '../server/tencent-data-core.mjs';

const CUSTOMER = 'Ada\n1 Main St, Austin, TX 78701\nada@example.com\n+1 5551234567';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-notify-'));
  const store = new TencentDataStore(join(dir, 'db.sqlite'));
  t.after(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  const other = store.upsertAccount({ email: 'sherry@inflatable-zone.com', role: 'business' });
  const ella = store.upsertAccount({ email: 'sales@inflatable-zone.com', role: 'business' });
  const follower = store.upsertAccount({ email: 'follow@example.com', role: 'follower' });
  const second = store.upsertAccount({ email: 'follow2@example.com', role: 'follower' });
  const disabled = store.upsertAccount({ email: 'follow-off@example.com', role: 'follower' });
  store.setUserActive(disabled.id, false);
  const supervisor = store.upsertAccount({ email: '505863160@qq.com', role: 'follower' });
  return { store, business, other, ella, follower, second, disabled, supervisor };
}

function supplementFields(extra = {}) {
  return {
    product_name: 'Castle', quantity: 2, size: '3 x 2 m', business_name: 'Demi',
    shipping_mode: 'domestic_sea', blower: '包风机', customer_info: CUSTOMER, abnormal_note: '请加急',
    ...extra
  };
}

function placeShopify(store, business) {
  const imported = store.importShopifyOrder({
    id: 'gid://shopify/Order/9053', order_no: '#9053', order_date: '2026-11-22', product_name: 'Arch', quantity: 2,
    image_urls: ['https://cdn.shopify.com/a.jpg'], customer_info: 'Ada', shipping_mode: 'domestic_express', blower: '气泵'
  });
  store.shopifyHandoff(business.id, { action: 'place', id: imported.id, order_no: '#9053', ...supplementFields() });
  return store.all('orders').find(row => row.id === imported.id);
}

test('createNotifications writes one unread row per user and keeps order-less notices', t => {
  const { store, business, follower, other } = fixture(t);
  assert.throws(() => store.createNotifications({ title: '提醒', body: '请填写周报' }), error => error.status === 400);
  assert.throws(() => store.createNotifications({ user_ids: [business.id], title: '提醒', body: '' }), error => error.status === 400);
  assert.throws(() => store.createNotifications({ user_ids: ['missing'], title: '提醒', body: '请填写周报' }), error => error.status === 404);
  const created = store.createNotifications({
    user_ids: [business.id, follower.id, business.id],
    title: '周报提醒',
    content: '请填写本周周报',
    type: 'weekly_report_reminder'
  });
  assert.equal(created.notifications.length, 2);
  assert.equal(created.notifications.every(row => row.unread === true && row.order_id == null && row.kind === 'weekly_report_reminder'), true);
  const read = store.createNotifications({ user_id: other.id, title: '已读示例', body: '这条一开始就是已读', read: true, kind: 'weekly_report_reminder' });
  assert.equal(read.notifications[0].unread, false);
  const listed = store.userNotifications(business.id, { action: 'list' });
  assert.equal(listed.unread_count, 1);
  assert.equal(listed.notifications.length, 1);
  assert.equal(listed.notifications[0].body, '请填写本周周报');
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).notifications.some(row => row.user_id === business.id), false);
  assert.throws(() => store.userNotifications(business.id, { action: 'create', user_ids: [follower.id], title: '周报提醒', body: '请填写本周周报' }), error => error.status === 403);
});

test('notifications survive a new store on the same database file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-notify-persist-'));
  const file = join(dir, 'db.sqlite');
  const store = new TencentDataStore(file);
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  store.createNotifications({ user_id: business.id, title: '周报提醒', body: '请填写本周周报', kind: 'weekly_report_reminder' });
  store.db.close();
  const again = new TencentDataStore(file);
  t.after(() => again.db.close());
  const listed = again.userNotifications(business.id, { action: 'list' });
  assert.equal(listed.unread_count, 1);
  assert.equal(listed.notifications[0].title, '周报提醒');
  assert.equal(listed.notifications[0].kind, 'weekly_report_reminder');
});

test('the order salesperson can revise a placed order with the saved fields, then merchandisers are notified', t => {
  const { store, business, other, ella, follower, second, disabled, supervisor } = fixture(t);
  const placed = placeShopify(store, business);
  assert.equal(placed.current_step, 'follower_create');
  assert.equal(placed.product_name, 'Castle');
  assert.equal(placed.customer_info, CUSTOMER);
  assert.equal(placed.abnormal_note, '请加急');
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 0);
  assert.throws(() => store.updateSalespersonSupplement(other.id, { id: placed.id, ...supplementFields({ product_name: 'Nope' }) }), error => error.status === 403);
  assert.throws(() => store.updateSalespersonSupplement(follower.id, { id: placed.id, ...supplementFields() }), error => error.status === 403);
  assert.throws(() => store.updateSalespersonSupplement(supervisor.id, { id: placed.id, ...supplementFields() }), error => error.status === 403);
  assert.throws(() => store.updateSalespersonSupplement(ella.id, { id: placed.id, ...supplementFields({ business_name: 'Ella' }) }), error => error.status === 403);
  const waiting = store.importShopifyOrder({ id: 'gid://shopify/Order/9054', order_no: '#9054', product_name: 'Wait', quantity: 1, image_urls: ['https://cdn.shopify.com/b.jpg'] });
  assert.throws(() => store.updateSalespersonSupplement(business.id, { id: waiting.id, ...supplementFields({ order_no: '#9054' }) }), error => error.status === 409);
  const saved = store.updateSalespersonSupplement(business.id, {
    id: placed.id,
    ...supplementFields({ product_name: 'Castle XL', quantity: 3, abnormal_note: '改成加急包装', customer_info: CUSTOMER })
  });
  const order = store.all('orders').find(row => row.id === saved.id);
  assert.equal(order.current_step, 'follower_create');
  assert.equal(order.product_name, 'Castle XL');
  assert.equal(order.quantity, 3);
  assert.equal(order.abnormal_note, '改成加急包装');
  assert.equal(order.requirements, '改成加急包装');
  assert.equal(order.customer_info, CUSTOMER);
  assert.equal(order.order_date, '2026-11-22');
  assert.equal(order.shopify_order_id, 'gid://shopify/Order/9053');
  assert.equal(store.canUploadShopifyProductImage(business.id, `${order.id}/product-image-extra.jpg`), true);
  assert.equal(store.canUploadShopifyProductImage(other.id, `${order.id}/product-image-extra.jpg`), false);
  for (const user of [follower, second, supervisor]) {
    const list = store.userNotifications(user.id, { action: 'list' });
    assert.equal(list.unread_count, 1);
    assert.equal(list.notifications[0].title, '订单信息更新');
    assert.equal(list.notifications[0].kind, 'order_info_update');
    assert.equal(list.notifications[0].order_id, order.id);
    assert.equal(list.notifications[0].body.includes('555'), false);
    assert.equal(list.notifications[0].body.includes('ada@'), false);
    assert.equal(list.notifications[0].body.includes('Main St'), false);
    assert.match(list.notifications[0].body, /#9053/);
  }
  assert.equal(store.userNotifications(business.id, { action: 'list' }).unread_count, 0);
  assert.equal(store.all('user_notifications').some(row => row.user_id === disabled.id), false);
  assert.throws(() => store.userNotifications(disabled.id, { action: 'list' }), error => error.status === 401);
  const marked = store.userNotifications(follower.id, { action: 'mark_read', order_id: order.id });
  assert.equal(marked.updated, 1);
  assert.equal(marked.unread_count, 0);
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).notifications[0].unread, false);
  assert.equal(store.userNotifications(second.id, { action: 'list' }).unread_count, 1);
  const byId = store.userNotifications(supervisor.id, { action: 'mark_read', ids: [store.userNotifications(supervisor.id, { action: 'list' }).notifications[0].id] });
  assert.equal(byId.updated, 1);
  assert.equal(store.userNotifications(supervisor.id, { action: 'list' }).unread_count, 0);
});

test('after 创建订单 the same salesperson can supplement without resetting the issued order', t => {
  const { store, business, follower, other } = fixture(t);
  const placed = placeShopify(store, business);
  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: placed.id, order_no: '#9053', product_name: 'Castle', size: '3 x 2 m', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, shipping_mode: 'domestic_sea', blower: '包风机', requirements: '跟单单独要求',
    factory_name: 'Factory A', factory_names: ['Factory A'], current_step: 'production'
  });
  store.put('orders', { ...store.all('orders').find(row => row.id === created.id), shipping_mode: 'air_freight', requirements: '跟单单独要求' });
  const before = store.all('orders').find(row => row.id === created.id);
  const updated = store.updateSalespersonSupplement(business.id, {
    id: before.id,
    ...supplementFields({ product_name: 'Castle revised', shipping_mode: 'air_freight', abnormal_note: '补充尺寸说明' })
  });
  const order = store.all('orders').find(row => row.id === updated.id);
  assert.equal(order.current_step, 'production');
  assert.equal(order.product_name, 'Castle revised');
  assert.equal(order.shipping_mode, 'air_freight');
  assert.equal(order.requirements, '跟单单独要求');
  assert.equal(order.abnormal_note, '补充尺寸说明');
  assert.equal(order.order_date, beijingOrderDate());
  assert.equal(order.factory_name, 'Factory A');
  assert.equal(store.canReadOrder(other.id, order), false);
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 1);
  const manual = store.salespersonOrder(business.id, { action: 'draft' });
  store.put('order_images', { order_id: manual.id, object_path: `${manual.id}/product-image-photo.jpg`, file_name: '产品图片' });
  const salespersonPlaced = store.salespersonOrder(business.id, { action: 'place', id: manual.id, ...supplementFields({ order_no: 'IZ-200' }) });
  assert.throws(() => store.updateSalespersonSupplement(business.id, { id: salespersonPlaced.id, ...supplementFields({ order_no: '#9052' }) }), error => error.status === 400 && /纯数字/.test(error.message));
  const renamed = store.updateSalespersonSupplement(business.id, { id: salespersonPlaced.id, ...supplementFields({ order_no: 'IZ-201', product_name: 'Manual XL' }) });
  assert.equal(store.all('orders').find(row => row.id === renamed.id).order_no, 'IZ-201');
  assert.equal(store.all('orders').find(row => row.id === renamed.id).current_step, 'follower_create');
});

test('the bell, supplement entry, and reusable write API stay in the existing pages', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server/tencent-data-server.mjs', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../server/tencent-data-core.mjs', import.meta.url), 'utf8');
  assert.match(app, /current_step==='sales_supplement'&&profile\?\.role==='business'\)\{openShopifyPlace\(o\);return\}/);
  assert.match(app, /current_step==='follower_create'&&profile\?\.role==='business'&&isOrderSalesperson\(o\)\)\{openSalespersonSupplement\(o\);return\}let d=\$\('#detail'\);d\.innerHTML=detailHtml\(o\);d\.showModal\(\)/);
  assert.match(app, /o\.current_step==='follower_create'&&follower\?`<div class="actions"><button class="primary" id="shopifyCreate">创建订单<\/button><\/div>`/);
  assert.match(app, /#shopifyCreate'\)\?\.addEventListener\('click',\(\)=>openShopifyCreate\(o,d\)\)/);
  assert.match(app, /id="supplementOrder">修改\/补充信息<\/button>/);
  assert.match(app, /id="notificationBell"/);
  assert.match(app, /class="notify-badge"/);
  assert.match(app, /class="notify-empty">暂无通知<\/p>/);
  assert.match(app, /class="order-notify-dot"/);
  assert.match(app, /function openSalespersonSupplement/);
  const form = app.slice(app.indexOf('function openSalespersonSupplement'), app.indexOf('async function openSalespersonOrder'));
  assert.match(form, /textarea name="customer_info" required>\$\{esc\(o\.customer_info\|\|''\)\}/);
  assert.match(form, /name="product_name" required value="\$\{esc\(o\.product_name\|\|''\)\}"/);
  assert.match(form, /name="abnormal_note" required>\$\{esc\(o\.abnormal_note\|\|o\.requirements\|\|''\)\}/);
  assert.equal(form.includes('<textarea name="customer_info" required></textarea>'), false);
  assert.match(form, /Ella<\/option>.*Sherry<\/option>.*Demi<\/option>.*Rayna<\/option>/);
  assert.match(page, /notifications\.css/);
  assert.equal(readFileSync(new URL('../style-v2.css', import.meta.url), 'utf8').includes('notify-bell'), false);
  assert.match(server, /name === 'user_notifications'/);
  assert.match(server, /name === 'salesperson_supplement'/);
  assert.match(core, /createNotifications\(input = \{\}\)/);
  assert.match(core, /viewer_id: userId/);
  assert.match(core, /const visible = this\.all\(WEEKLY_REPORTS\)\.filter\(row => row\?\.week_start\);/);
  assert.equal(core.includes("user_notifications'") && core.includes("TABLES = ["), true);
  const tables = core.slice(core.indexOf('export const TABLES'), core.indexOf('];', core.indexOf('export const TABLES')));
  assert.equal(tables.includes('user_notifications'), false);
});
