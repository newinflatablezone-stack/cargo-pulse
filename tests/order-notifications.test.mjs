import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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
    product_name: '城堡', quantity: 2, size: '3 x 2 m', business_name: 'Demi',
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
  let reopened;
  t.after(() => {
    reopened?.db.close();
    if (!reopened && store.db.isOpen) store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const business = store.upsertAccount({ email: 'demi@inflatable-zone.com', role: 'business' });
  store.createNotifications({ user_id: business.id, title: '周报提醒', body: '请填写本周周报', kind: 'weekly_report_reminder' });
  store.db.close();
  reopened = new TencentDataStore(file);

  const listed = reopened.userNotifications(business.id, { action: 'list' });
  assert.equal(listed.unread_count, 1);
  assert.equal(listed.notifications[0].title, '周报提醒');
  assert.equal(listed.notifications[0].kind, 'weekly_report_reminder');
});

test('the order salesperson can revise a placed order with the saved fields, then merchandisers are notified', t => {
  const { store, business, other, ella, follower, second, disabled, supervisor } = fixture(t);
  const placed = placeShopify(store, business);
  assert.equal(placed.current_step, 'follower_create');
  assert.equal(placed.product_name, '城堡');
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
    ...supplementFields({ product_name: '加大城堡', quantity: 3, abnormal_note: '改成加急包装', customer_info: CUSTOMER })
  });
  const order = store.all('orders').find(row => row.id === saved.id);
  assert.equal(order.current_step, 'follower_create');
  assert.equal(order.product_name, '加大城堡');
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
  const { store, business, follower, other, supervisor } = fixture(t);
  const placed = placeShopify(store, business);
  store.put('partners', { id: 'factory-a', kind: 'factory', name: 'Factory A', active: true });
  store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: placed.id, factory_name: 'Factory A' });
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
    ...supplementFields({ product_name: '修订城堡', shipping_mode: 'air_freight', abnormal_note: '补充尺寸说明' })
  });
  const order = store.all('orders').find(row => row.id === updated.id);
  assert.equal(order.current_step, 'production');
  assert.equal(order.product_name, '修订城堡');
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
  const renamed = store.updateSalespersonSupplement(business.id, { id: salespersonPlaced.id, ...supplementFields({ order_no: 'IZ-201', product_name: '手动加大' }) });
  assert.equal(store.all('orders').find(row => row.id === renamed.id).order_no, 'IZ-201');
  assert.equal(store.all('orders').find(row => row.id === renamed.id).current_step, 'follower_create');
  assert.equal(store.userNotifications(supervisor.id, { action: 'list' }).notifications.some(row => String(row.body).includes('IZ-201')), false);
});

test('a follower order-number update does not notify the supervisor', t => {
  const { store, business, follower, second, disabled, supervisor } = fixture(t);
  const placed = placeShopify(store, business);
  store.put('partners', { id: 'factory-a', kind: 'factory', name: 'Factory A', active: true });
  store.shopifyHandoff(supervisor.id, { action: 'assign_factory', id: placed.id, factory_name: 'Factory A' });
  const created = store.shopifyHandoff(follower.id, {
    action: 'create', id: placed.id, order_no: '#9053A', product_name: '城堡', size: '3 x 2 m', quantity: 2,
    customer_info: CUSTOMER, business_name: 'Demi', destination_country: '美国', inventory_mode: 'production',
    needs_rendering: false, shipping_mode: 'domestic_sea', blower: '包风机', requirements: '跟单要求',
    factory_name: 'Factory A', factory_names: ['Factory A'], current_step: 'production'
  });
  assert.equal(store.all('orders').find(row => row.id === created.id).order_no, '#9053A');
  assert.equal(store.userNotifications(supervisor.id, { action: 'list' }).unread_count, 0);
  assert.equal(store.all('user_notifications').some(row => row.user_id === supervisor.id), false);

  const [edited] = store.mutate('orders', 'PATCH', new URL('http://local/rest/v1/orders?id=eq.' + created.id), { order_no: '#9053B' }, follower.id);
  assert.equal(edited.order_no, '#9053B');
  assert.equal(store.userNotifications(supervisor.id, { action: 'list' }).unread_count, 0);
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 0);
  assert.equal(store.userNotifications(second.id, { action: 'list' }).unread_count, 0);
  assert.equal(store.all('user_notifications').some(row => row.user_id === supervisor.id || row.user_id === disabled.id), false);

  store.updateSalespersonSupplement(business.id, { id: created.id, ...supplementFields({ order_no: '#9053C' }) });
  for (const user of [follower, second]) {
    const list = store.userNotifications(user.id, { action: 'list' });
    assert.equal(list.unread_count, 1);
    assert.equal(list.notifications[0].kind, 'order_info_update');
    assert.equal(list.notifications[0].order_id, created.id);
    assert.match(list.notifications[0].body, /#9053C/);
    assert.equal(list.notifications[0].body.includes('555'), false);
    assert.equal(list.notifications[0].body.includes('ada@'), false);
  }
  assert.equal(store.userNotifications(supervisor.id, { action: 'list' }).unread_count, 0);
  assert.equal(store.all('user_notifications').some(row => row.user_id === supervisor.id), false);
  assert.equal(store.all('user_notifications').some(row => row.user_id === disabled.id), false);

  store.updateSalespersonSupplement(business.id, { id: created.id, ...supplementFields({ order_no: '#9053C', product_name: '加大城堡' }) });
  const supervisorList = store.userNotifications(supervisor.id, { action: 'list' });
  assert.equal(supervisorList.unread_count, 1);
  assert.equal(supervisorList.notifications[0].kind, 'order_info_update');
  assert.match(supervisorList.notifications[0].body, /#9053C/);
  assert.equal(store.userNotifications(follower.id, { action: 'list' }).unread_count, 2);

  store.createNotifications({ user_id: supervisor.id, title: '周报提醒', body: '请填写本周周报', kind: 'weekly_report_reminder' });
  const mixed = store.userNotifications(supervisor.id, { action: 'list' });
  assert.equal(mixed.unread_count, 2);
  assert.equal(mixed.notifications.some(row => row.kind === 'weekly_report_reminder'), true);
});

test('the bell, supplement entry, and reusable write API stay in the existing pages', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server/tencent-data-server.mjs', import.meta.url), 'utf8');
  const core = readFileSync(new URL('../server/tencent-data-core.mjs', import.meta.url), 'utf8');
  assert.match(app, /if\(o&&!o\.deleted_at&&o\.current_step==='sales_supplement'&&profile\?\.role==='business'&&!isSupervisor\(\)\)\{openShopifyPlace\(o\);return\}/);
  assert.match(app, /current_step==='follower_create'&&profile\?\.role==='business'&&isOrderSalesperson\(o\)\)\{openSalespersonSupplement\(o\);return\}/);
  assert.match(app, /current_step!=='sales_supplement'&&o\.current_step!=='follower_create'&&isOrderSalesperson\(o\)&&!isSupervisor\(\)\)\{openSalespersonSupplement\(o\);return\}return\}if\(openFollowerCreate\(o\)\)return;let d=\$\('#detail'\);d\.innerHTML=detailHtml\(o\);d\.showModal\(\)/);
  assert.match(app, /o\.current_step==='follower_create'&&follower\?`<div class="actions"><button class="primary" id="shopifyCreate">创建订单<\/button><\/div>`/);
  assert.match(app, /#shopifyCreate'\)\?\.addEventListener\('click',\(\)=>openFollowerCreate\(o,d\)\)/);
  assert.match(app, /id="supplementOrder">修改\/补充信息<\/button>/);
  assert.match(app, /id="notificationBell"/);
  assert.match(app, /class="notify-badge"/);
  assert.match(app, /class="notify-empty">暂无通知<\/p>/);
  assert.match(app, /class="order-notify-dot"/);
  assert.match(app, /function openSalespersonSupplement/);
  const form = app.slice(app.indexOf('function openSalespersonSupplement'), app.indexOf('async function openSalespersonOrder'));
  assert.match(form, /issued=o\.current_step!=='follower_create',heading=issued\?'修改\/补充信息':'待业务员认领下单'/);
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
  assert.match(core, /const visible = this\.all\(WEEKLY_REPORTS\)\.filter\(row => row\?\.week_start && \(access === 'view' \|\| row\.user_id === userId\)\);/);
  assert.equal(core.includes("user_notifications'") && core.includes("TABLES = ["), true);
  const tables = core.slice(core.indexOf('export const TABLES'), core.indexOf('];', core.indexOf('export const TABLES')));
  assert.equal(tables.includes('user_notifications'), false);
});

function clickOrderCard(order, person) {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const marker = "document.querySelectorAll('[data-order]').forEach(c=>c.onclick=event=>{";
  const start = app.indexOf(marker);
  const end = app.indexOf("let d=$('#detail')", start);
  assert.ok(start > 0 && end > start);
  const identity = app.slice(app.indexOf('function salespersonChoice('), app.indexOf('function orderHasUnreadNotification('));
  const supervisor = app.slice(app.indexOf('const SUPERVISOR_EMAIL='), app.indexOf('function storedSupervisorSession('));
  const follow = app.slice(app.indexOf('function canFollowOrders('), app.indexOf('const factoryExportSelection'));
  const opened = [];
  const ctx = {
    profile: { ...person },
    session: { user: { email: person.email, id: person.id } },
    orders: [order],
    event: { target: { closest() { return null; } } },
    c: { dataset: { order: order.id } },
    opened,
    openShopifyPlace(row) { opened.push('place:' + row.id); },
    openShopifyCreate(row) { opened.push('create:' + row.id); },
    openFollowerFactoryAssign(row) { opened.push('factory:' + row.id); },
    openSalespersonSupplement(row) { opened.push('supplement:' + row.current_step + ':' + row.id); },
    markOrderNotificationsRead(id) { opened.push('read:' + id); },
    alert(message) { opened.push('alert:' + message); }
  };
  runInNewContext(supervisor + follow + identity + 'function click(event, c){\n' + app.slice(start + marker.length, end) + '\nopened.push("detail:"+c.dataset.order);\n}\nclick(event, c);', ctx);
  return opened;
}

test('the order salesperson card opens the order detail popup, while follower and supervisor paths stay', () => {
  const owner = { id: 'demi-1', role: 'business', email: 'demi@inflatable-zone.com', display_name: 'Demi' };
  const other = { id: 'ella-1', role: 'business', email: 'sales@inflatable-zone.com', display_name: 'Ella' };
  const follower = { id: 'follower-1', role: 'follower', email: 'follow@example.com' };
  const supervisor = { id: 'boss-1', role: 'follower', email: '505863160@qq.com' };
  const waiting = { id: 'wait-1', current_step: 'follower_create', deleted_at: null, business_id: 'demi-1', business_name: 'Demi', product_name: 'Castle' };
  const issued = { id: 'prod-1', current_step: 'production', deleted_at: null, business_id: 'demi-1', business_name: 'Demi', product_name: 'Castle' };
  const completed = { id: 'done-1', current_step: 'completed', deleted_at: null, business_id: 'demi-1', business_name: 'Demi', product_name: 'Castle' };
  const supplement = { id: 'sup-1', current_step: 'sales_supplement', deleted_at: null, business_id: 'demi-1', business_name: 'Demi' };
  const deleted = { id: 'del-1', current_step: 'production', deleted_at: '2026-11-01', business_id: 'demi-1', business_name: 'Demi' };

  assert.deepEqual(clickOrderCard(waiting, owner), ['read:wait-1', 'detail:wait-1']);
  assert.deepEqual(clickOrderCard(waiting, follower), ['read:wait-1', 'alert:主管须先选择工厂并保存后，跟单才能创建订单。']);
  assert.deepEqual(clickOrderCard({ ...waiting, factory_name: 'Factory A' }, follower), ['read:wait-1', 'create:wait-1']);
  const supervisorWaiting = { id: 'wait-boss', current_step: 'follower_create', deleted_at: null, business_id: 'boss-1', business_name: 'Demi' };
  assert.deepEqual(clickOrderCard(supervisorWaiting, { ...supervisor, role: 'business', display_name: 'Demi' }), ['read:wait-boss', 'detail:wait-boss']);
  assert.deepEqual(clickOrderCard({ ...supervisorWaiting, factory_name: 'Factory A' }, { ...supervisor, role: 'business', display_name: 'Demi' }), ['read:wait-boss', 'create:wait-boss']);
  assert.deepEqual(clickOrderCard(issued, owner), ['read:prod-1', 'detail:prod-1']);
  assert.deepEqual(clickOrderCard(completed, owner), ['read:done-1', 'detail:done-1']);
  assert.deepEqual(clickOrderCard(issued, other), ['read:prod-1', 'detail:prod-1']);
  assert.deepEqual(clickOrderCard(waiting, other), ['read:wait-1', 'detail:wait-1']);
  assert.deepEqual(clickOrderCard(issued, follower), ['read:prod-1', 'detail:prod-1']);
  assert.deepEqual(clickOrderCard(issued, supervisor), ['read:prod-1', 'detail:prod-1']);
  const supervisorOwned = { id: 'boss-order', current_step: 'production', deleted_at: null, business_id: 'boss-1', business_name: 'Demi', product_name: 'Castle' };
  assert.deepEqual(clickOrderCard(supervisorOwned, { ...supervisor, role: 'business', display_name: 'Demi' }), ['read:boss-order', 'detail:boss-order']);
  assert.deepEqual(clickOrderCard(supplement, owner), ['read:sup-1', 'place:sup-1']);
  assert.deepEqual(clickOrderCard(deleted, owner), ['read:del-1', 'detail:del-1']);

  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const clickStart = app.indexOf("document.querySelectorAll('[data-order]')");
  const click = app.slice(clickStart, app.indexOf("let d=$('#detail')", clickStart));
  const placeGate = click.indexOf("orderView==='place'");
  const createGate = click.indexOf("if(openFollowerCreate(o))return");
  const waitingGate = click.indexOf("current_step==='follower_create'&&profile?.role==='business'&&isOrderSalesperson(o)");
  const issuedGate = click.indexOf("current_step!=='sales_supplement'&&o.current_step!=='follower_create'&&isOrderSalesperson(o)&&!isSupervisor()");
  assert.ok(placeGate > 0 && waitingGate > placeGate && issuedGate > waitingGate && createGate > issuedGate);
});

test('mark_read for one order update leaves the other orders unread', t => {
  const { store, follower, second } = fixture(t);
  for (const [id, orderNo] of [['o1', '#1001'], ['o2', '#1002'], ['o3', '#1003']]) {
    store.createNotifications({
      user_ids: [follower.id, second.id],
      title: '订单信息更新',
      body: `订单 ${orderNo} 的补充信息已更新，请查看。`,
      kind: 'order_info_update',
      order_id: id
    });
  }
  const before = store.userNotifications(follower.id, { action: 'list' });
  assert.equal(before.unread_count, 3);
  assert.equal(before.notifications.every(row => row.body.includes('555') || row.body.includes('@') || row.body.includes('Main St')), false);
  const marked = store.userNotifications(follower.id, { action: 'mark_read', order_id: 'o2' });
  assert.equal(marked.updated, 1);
  assert.equal(marked.unread_count, 2);
  const after = store.userNotifications(follower.id, { action: 'list' });
  assert.deepEqual(after.notifications.filter(row => row.unread !== false).map(row => row.order_id).sort(), ['o1', 'o3']);
  assert.equal(after.notifications.find(row => row.order_id === 'o2').unread, false);
  assert.equal(store.userNotifications(second.id, { action: 'list' }).unread_count, 3);
});

function popupRuntime(options = {}) {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const start = app.indexOf('function orderHasUnreadNotification');
  const end = app.indexOf('function bindNotifications');
  assert.ok(start > 0 && end > start);
  const listeners = [];
  const timers = [];
  const calls = [];
  const opened = [];
  let list = [];
  const document = {
    hidden: false,
    body: { append() { throw new Error('reminders must not append a page overlay'); } },
    createElement() { throw new Error('reminders must not create a popup element'); },
    addEventListener(type, fn) { listeners.push([type, fn]); },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const sandbox = {
    userNotifications: [],
    notificationFresh: false,
    notificationEpoch: 0,
    notificationMarkEpoch: 0,
    notificationMarksInFlight: 0,
    notificationWatchUserId: '',
    session: { user: { id: 'follower-1' } },
    document,
    window: { addEventListener(type, fn) { listeners.push([type, fn]); } },
    setInterval(fn) { timers.push(fn); return timers.length; },
    bindNotifications() {},
    isSupervisor() { return options.supervisor === true; },
    esc: value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])),
    $: () => null,
    openNotifiedOrder(id) { opened.push(String(id)); },
    async api(_path, options) {
      const body = JSON.parse(options.body);
      calls.push(body);
      return body.action === 'list' ? { notifications: list } : { updated: 1 };
    },
    console
  };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.__popup = { loadUserNotifications, notificationBellHtml, unreadOrderUpdates, markAllOrderUpdatesRead, openBellNotification };`, sandbox);
  return { popup: sandbox.__popup, sandbox, document, listeners, timers, calls, opened, setList(next) { list = next; } };
}

function orderUpdate(id, orderId, orderNo) {
  return { id, kind: 'order_info_update', title: '订单信息更新', body: `订单 ${orderNo} 的补充信息已更新，请查看。`, unread: true, order_id: orderId };
}

test('unread reminders stay in the top-right bell and one click leaves the other orders unread', async () => {
  const runtime = popupRuntime();
  const { popup, listeners, timers, calls, opened, sandbox } = runtime;
  const weekly = { id: 'w1', kind: 'weekly_report_reminder', title: '周报提醒', body: '请填写本周周报', unread: true, order_id: null };
  runtime.setList([weekly, orderUpdate('n1', 'o1', '#1001'), orderUpdate('n2', 'o2', '#1002'), orderUpdate('n3', 'o3', '#1003')]);
  await popup.loadUserNotifications(true);
  const bell = popup.notificationBellHtml();
  assert.match(bell, /id="notificationBell"/);
  assert.match(bell, /id="notificationPanel" class="notify-panel" hidden role="menu"/);
  assert.match(bell, /class="notify-badge"/);
  assert.match(bell, /#1001/);
  assert.match(bell, /#1002/);
  assert.match(bell, /#1003/);
  assert.match(bell, /请填写本周周报/);
  assert.equal(bell.includes('order-update-popup'), false);
  assert.equal(bell.includes('data-order-update-reopen'), false);
  assert.equal(bell.includes('aria-modal'), false);
  assert.equal(bell.includes('全部标记已读'), false);
  assert.equal(bell.includes('ada@'), false);
  const painted = bell;
  timers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(popup.notificationBellHtml(), painted);

  await popup.openBellNotification('n1', 'o1');
  assert.deepEqual(opened, ['o1']);
  assert.deepEqual(calls.filter(call => call.action === 'mark_read'), [{ action: 'mark_read', ids: ['n1'] }]);
  assert.deepEqual(popup.unreadOrderUpdates().map(item => item.order_id), ['o2', 'o3']);
  assert.equal(sandbox.userNotifications.find(item => item.id === 'w1').unread, true);
  const after = popup.notificationBellHtml();
  assert.match(after, /id="notificationPanel" class="notify-panel" hidden/);
  assert.equal(after.includes('#1001'), false);
  assert.match(after, /#1002/);
  assert.match(after, /#1003/);
  assert.match(after, /请填写本周周报/);

  listeners.find(([type]) => type === 'visibilitychange')[1]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(popup.notificationBellHtml().includes('order-update-popup'), false);
  assert.equal(calls.filter(call => call.action === 'mark_read').length, 1);
});

test('reopening the page lists leftover reminders in the bell and does not auto-open them', async () => {
  const weekly = { id: 'w1', kind: 'weekly_report_reminder', title: '周报提醒', body: '请填写本周周报', unread: true, order_id: null };
  const runtime = popupRuntime();
  runtime.setList([weekly, orderUpdate('n2', 'o2', '#1002'), orderUpdate('n3', 'o3', '#1003')]);
  await runtime.popup.loadUserNotifications(true);
  const bell = runtime.popup.notificationBellHtml();
  assert.match(bell, /hidden role="menu"/);
  assert.match(bell, /#1002/);
  assert.match(bell, /#1003/);
  assert.match(bell, /请填写本周周报/);
  assert.equal(bell.includes('order-update-popup'), false);
  runtime.timers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runtime.popup.notificationBellHtml(), bell);
});

test('only the supervisor can mark every unread order update read from the bell panel', async () => {
  const weekly = { id: 'w1', kind: 'weekly_report_reminder', title: '周报提醒', body: '请填写本周周报', unread: true, order_id: null };
  const follower = popupRuntime();
  follower.setList([weekly, orderUpdate('n1', 'o1', '#1001'), orderUpdate('n2', 'o2', '#1002')]);
  await follower.popup.loadUserNotifications(true);
  assert.equal(follower.popup.notificationBellHtml().includes('全部标记已读'), false);
  const before = follower.calls.length;
  await follower.popup.markAllOrderUpdatesRead();
  assert.equal(follower.calls.length, before);
  assert.deepEqual(follower.popup.unreadOrderUpdates().map(item => item.order_id), ['o1', 'o2']);

  const supervisor = popupRuntime({ supervisor: true });
  supervisor.setList([weekly, orderUpdate('n1', 'o1', '#1001'), orderUpdate('n2', 'o2', '#1002')]);
  await supervisor.popup.loadUserNotifications(true);
  const html = supervisor.popup.notificationBellHtml();
  assert.match(html, /id="notificationPanel" class="notify-panel" hidden/);
  assert.match(html, /data-order-update-mark-all="true">全部标记已读/);
  assert.match(html, /#1001/);
  assert.match(html, /请填写本周周报/);
  assert.equal(html.includes('order-update-popup'), false);
  assert.equal(html.indexOf('全部标记已读') < html.indexOf('#1001'), true);
  await supervisor.popup.markAllOrderUpdatesRead();
  assert.deepEqual(supervisor.calls.filter(call => call.action === 'mark_read'), [{ action: 'mark_read', ids: ['n1', 'n2'] }]);
  assert.equal(supervisor.popup.unreadOrderUpdates().length, 0);
  assert.equal(supervisor.sandbox.userNotifications.find(item => item.id === 'w1').unread, true);
  const left = supervisor.popup.notificationBellHtml();
  assert.match(left, /请填写本周周报/);
  assert.equal(left.includes('#1001'), false);
  assert.equal(left.includes('全部标记已读'), false);
  assert.match(left, /hidden role="menu"/);
});

test('reminders render only as the top-right bell panel, not an auto-popup of every unread item', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../notifications.css', import.meta.url), 'utf8');
  const bell = app.slice(app.indexOf('function notificationBellHtml'), app.indexOf('async function markAllOrderUpdatesRead'));
  const bind = app.slice(app.indexOf('function bindNotifications'), app.indexOf('function openNotifiedOrder'));
  const watch = app.slice(app.indexOf('function watchOrderUpdateNotifications'), app.indexOf('watchOrderUpdateNotifications();'));
  assert.match(bell, /id="notificationBell"/);
  assert.match(bell, /id="notificationPanel" class="notify-panel" hidden/);
  assert.match(bell, /isSupervisor\(\)&&unreadOrderUpdates\(\)\.length\?`<button type="button" class="order-update-mark-all" data-order-update-mark-all="true">全部标记已读<\/button>`/);
  assert.equal(bell.includes('data-order-update-reopen'), false);
  assert.equal(bell.includes('order-update-popup'), false);
  assert.match(app, /async function markAllOrderUpdatesRead\(\)\{if\(!isSupervisor\(\)\)return;const ids=unreadOrderUpdates\(\)\.map\(item=>item\.id\)/);
  assert.match(app, /async function openBellNotification\(id,orderId\)/);
  assert.match(app, /markNotificationsRead\(\{ids:\[id\]\}\)/);
  assert.match(app, /openNotifiedOrder\(orderId\)/);
  assert.match(bind, /panel\.hidden=!willOpen/);
  assert.match(bind, /openBellNotification\(button\.dataset\.notification,button\.dataset\.orderId\)/);
  assert.match(bind, /data-order-update-mark-all/);
  assert.equal(bind.includes('showOrderUpdatePopup'), false);
  assert.match(watch, /loadUserNotifications\(true\)/);
  assert.match(watch, /visibilitychange/);
  assert.equal(watch.includes('orderUpdatePopup'), false);
  assert.equal(app.includes('orderUpdatePopup'), false);
  assert.equal(app.includes('showOrderUpdatePopup'), false);
  assert.equal(app.includes('aria-modal'), false);
  assert.equal(css.includes('order-update-popup'), false);
  assert.equal(css.includes('position:fixed'), false);
  assert.match(css, /\.notify-bell\{position:relative/);
  assert.match(css, /\.notify-panel\{position:absolute;top:calc\(100% \+ 8px\);right:0/);
  assert.match(css, /\.order-update-mark-all\{/);
  const clickStart = app.indexOf("document.querySelectorAll('[data-order]')");
  const click = app.slice(clickStart, app.indexOf("let d=$('#detail')", clickStart));
  assert.ok(click.indexOf("if(openFollowerCreate(o))return") > 0);
  assert.equal(click.includes('openShopifyCreate(o);return'), false);
});
