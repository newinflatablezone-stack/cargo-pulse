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
  assert.match(app, /current_step==='follower_create'&&profile\?\.role==='business'&&isOrderSalesperson\(o\)\)\{openSalespersonSupplement\(o\);return\}/);
  assert.match(app, /current_step!=='sales_supplement'&&o\.current_step!=='follower_create'&&isOrderSalesperson\(o\)&&!isSupervisor\(\)\)\{openSalespersonSupplement\(o\);return\}let d=\$\('#detail'\);d\.innerHTML=detailHtml\(o\);d\.showModal\(\)/);
  assert.match(app, /o\.current_step==='follower_create'&&follower\?`<div class="actions"><button class="primary" id="shopifyCreate">创建订单<\/button><\/div>`/);
  assert.match(app, /#shopifyCreate'\)\?\.addEventListener\('click',\(\)=>openShopifyCreate\(o,d\)\)/);
  assert.match(app, /id="supplementOrder">修改\/补充信息<\/button>/);
  assert.match(app, /id="notificationBell"/);
  assert.match(app, /class="notify-badge"/);
  assert.match(app, /class="notify-empty">暂无通知<\/p>/);
  assert.match(app, /class="order-notify-dot"/);
  assert.match(app, /function openSalespersonSupplement/);
  const form = app.slice(app.indexOf('function openSalespersonSupplement'), app.indexOf('async function openSalespersonOrder'));
  assert.match(form, /issued=o\.current_step!=='follower_create',heading=issued\?'修改\/补充信息':'待业务员补充信息'/);
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
    openSalespersonSupplement(row) { opened.push('supplement:' + row.current_step + ':' + row.id); },
    markOrderNotificationsRead(id) { opened.push('read:' + id); }
  };
  runInNewContext(supervisor + follow + identity + 'function click(event, c){\n' + app.slice(start + marker.length, end) + '\nopened.push("detail:"+c.dataset.order);\n}\nclick(event, c);', ctx);
  return opened;
}

test('the order salesperson lands on the prefilled form from the card, before and after 创建订单', () => {
  const owner = { id: 'demi-1', role: 'business', email: 'demi@inflatable-zone.com', display_name: 'Demi' };
  const other = { id: 'ella-1', role: 'business', email: 'sales@inflatable-zone.com', display_name: 'Ella' };
  const follower = { id: 'follower-1', role: 'follower', email: 'follow@example.com' };
  const supervisor = { id: 'boss-1', role: 'follower', email: '505863160@qq.com' };
  const waiting = { id: 'wait-1', current_step: 'follower_create', deleted_at: null, business_id: 'demi-1', business_name: 'Demi', product_name: 'Castle' };
  const issued = { id: 'prod-1', current_step: 'production', deleted_at: null, business_id: 'demi-1', business_name: 'Demi', product_name: 'Castle' };
  const completed = { id: 'done-1', current_step: 'completed', deleted_at: null, business_id: 'demi-1', business_name: 'Demi', product_name: 'Castle' };
  const supplement = { id: 'sup-1', current_step: 'sales_supplement', deleted_at: null, business_id: 'demi-1', business_name: 'Demi' };
  const deleted = { id: 'del-1', current_step: 'production', deleted_at: '2026-11-01', business_id: 'demi-1', business_name: 'Demi' };

  assert.deepEqual(clickOrderCard(waiting, owner), ['read:wait-1', 'supplement:follower_create:wait-1']);
  assert.deepEqual(clickOrderCard(waiting, follower), ['read:wait-1', 'create:wait-1']);
  const supervisorWaiting = { id: 'wait-boss', current_step: 'follower_create', deleted_at: null, business_id: 'boss-1', business_name: 'Demi' };
  assert.deepEqual(clickOrderCard(supervisorWaiting, { ...supervisor, role: 'business', display_name: 'Demi' }), ['read:wait-boss', 'create:wait-boss']);
  assert.deepEqual(clickOrderCard(issued, owner), ['read:prod-1', 'supplement:production:prod-1']);
  assert.deepEqual(clickOrderCard(completed, owner), ['read:done-1', 'supplement:completed:done-1']);
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
  const createGate = click.indexOf("current_step==='follower_create'&&canFollowOrders()){openShopifyCreate(o);return}");
  const waitingGate = click.indexOf("current_step==='follower_create'&&profile?.role==='business'&&isOrderSalesperson(o)");
  const issuedGate = click.indexOf("current_step!=='sales_supplement'&&o.current_step!=='follower_create'&&isOrderSalesperson(o)&&!isSupervisor()");
  assert.ok(createGate > 0 && waitingGate > createGate && issuedGate > waitingGate);
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
  const elements = [];
  const listeners = [];
  const timers = [];
  const calls = [];
  const opened = [];
  let list = [];
  const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  function enhance(node) {
    node.attrs = {};
    node.dataset = {};
    node.hidden = false;
    node.htmlWrites = 0;
    node.className = '';
    node.onclick = null;
    node._html = '';
    node._buttons = [];
    node.setAttribute = (name, value) => { node.attrs[name] = value; };
    Object.defineProperty(node, 'innerHTML', {
      get() { return node._html; },
      set(html) {
        node.htmlWrites += 1;
        node._html = html;
        node._buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map(match => {
          const attrs = match[1];
          const read = name => {
            const found = new RegExp(`${name}="([^"]*)"`).exec(attrs);
            return found ? decode(found[1]) : '';
          };
          const dataset = {};
          if (attrs.includes('data-order-update=') && !attrs.includes('data-order-update-reopen')) dataset.orderUpdate = read('data-order-update');
          if (attrs.includes('data-order-id=')) dataset.orderId = read('data-order-id');
          return { dataset, className: /class="([^"]*)"/.exec(attrs)?.[1] || '', onclick: null };
        });
      }
    });
    node.querySelector = selector => {
      if (selector === '.order-update-popup-close') return node._buttons.find(button => button.className.includes('order-update-popup-close')) || null;
      if (selector === '[data-order-update-mark-all]') return node._buttons.find(button => button.className.includes('order-update-mark-all')) || null;
      return null;
    };
    node.querySelectorAll = selector => selector === '[data-order-update]' ? node._buttons.filter(button => button.dataset.orderUpdate) : [];
    return node;
  }
  const document = {
    hidden: false,
    body: { append(node) { elements.push(node); } },
    createElement() { return enhance({ id: '' }); },
    addEventListener(type, fn) { listeners.push([type, fn]); },
    querySelector(selector) { return selector.startsWith('#') ? elements.find(node => node.id === selector.slice(1)) || null : null; },
    querySelectorAll() { return []; }
  };
  const sandbox = {
    userNotifications: [],
    notificationFresh: false,
    notificationEpoch: 0,
    notificationMarkEpoch: 0,
    notificationMarksInFlight: 0,
    orderUpdatePopupOpen: false,
    notificationWatchUserId: '',
    suppressedOrderUpdateIds: new Set(),
    session: { user: { id: 'follower-1' } },
    document,
    window: { addEventListener(type, fn) { listeners.push([type, fn]); } },
    setInterval(fn) { timers.push(fn); return timers.length; },
    bindNotifications() {},
    isSupervisor() { return options.supervisor === true; },
    esc: value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])),
    $: selector => document.querySelector(selector),
    openNotifiedOrder(id) { opened.push(String(id)); },
    async api(_path, options) {
      const body = JSON.parse(options.body);
      calls.push(body);
      return body.action === 'list' ? { notifications: list } : { updated: 1 };
    },
    console
  };
  runInNewContext(`${app.slice(start, end)}\nglobalThis.__popup = { loadUserNotifications, showOrderUpdatePopup, dismissOrderUpdatePopup, notificationBellHtml, unreadOrderUpdates, markAllOrderUpdatesRead };`, sandbox);
  return { popup: sandbox.__popup, sandbox, document, listeners, timers, calls, opened, setList(next) { list = next; } };
}

function orderUpdate(id, orderId, orderNo) {
  return { id, kind: 'order_info_update', title: '订单信息更新', body: `订单 ${orderNo} 的补充信息已更新，请查看。`, unread: true, order_id: orderId };
}

test('an unread order update opens the popup without a manual refresh, and one click leaves the other orders unread', async () => {
  const runtime = popupRuntime();
  const { popup, document, listeners, timers, calls, opened, sandbox } = runtime;
  const weekly = { id: 'w1', kind: 'weekly_report_reminder', title: '周报提醒', body: '请填写本周周报', unread: true, order_id: null };
  runtime.setList([weekly]);
  await popup.loadUserNotifications(true);
  assert.equal(document.querySelector('#orderUpdatePopup'), null);

  runtime.setList([weekly, orderUpdate('n1', 'o1', '#1001'), orderUpdate('n2', 'o2', '#1002'), orderUpdate('n3', 'o3', '#1003')]);
  assert.equal(sandbox.notificationFresh, true);
  timers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  const shown = document.querySelector('#orderUpdatePopup');
  assert.equal(shown.hidden, false);
  assert.match(shown.innerHTML, /订单信息更新/);
  assert.match(shown.innerHTML, /#1001/);
  assert.match(shown.innerHTML, /#1002/);
  assert.match(shown.innerHTML, /#1003/);
  assert.equal(shown.innerHTML.includes('请填写本周周报'), false);
  assert.equal(shown.innerHTML.includes('ada@'), false);
  assert.equal(shown.innerHTML.includes('customer_info'), false);
  const [first, second, third] = shown.querySelectorAll('[data-order-update]');
  assert.equal(first.dataset.orderId, 'o1');
  assert.equal(second.dataset.orderId, 'o2');
  assert.equal(third.dataset.orderId, 'o3');
  assert.equal(shown.innerHTML.includes('全部标记已读'), false);
  assert.equal(shown.querySelector('[data-order-update-mark-all]'), null);
  const painted = shown.htmlWrites;
  timers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.hidden, false);
  assert.equal(shown.htmlWrites, painted);

  await first.onclick({ stopPropagation() {} });
  assert.deepEqual(opened, ['o1']);
  assert.deepEqual(calls.filter(call => call.action === 'mark_read'), [{ action: 'mark_read', order_id: 'o1' }]);
  assert.deepEqual(popup.unreadOrderUpdates().map(item => item.order_id), ['o2', 'o3']);
  assert.equal(sandbox.userNotifications.find(item => item.id === 'w1').unread, true);
  assert.equal(shown.hidden, false);
  assert.equal(shown.innerHTML.includes('#1001'), false);
  assert.match(shown.innerHTML, /#1002/);
  assert.match(shown.innerHTML, /#1003/);

  const marks = calls.length;
  shown.querySelector('.order-update-popup-close').onclick({ stopPropagation() {} });
  assert.equal(shown.hidden, true);
  assert.equal(calls.length, marks);
  assert.deepEqual(popup.unreadOrderUpdates().map(item => item.order_id), ['o2', 'o3']);
  const bell = popup.notificationBellHtml();
  assert.match(bell, /id="notificationBell"/);
  assert.match(bell, /class="notify-badge"/);
  assert.match(bell, /#1002/);
  assert.match(bell, /#1003/);
  assert.match(bell, /请填写本周周报/);
  assert.match(bell, /data-order-update-reopen="true"/);

  popup.showOrderUpdatePopup();
  assert.equal(shown.hidden, false);
  assert.match(shown.innerHTML, /#1002/);
  assert.match(shown.innerHTML, /#1003/);
  assert.equal(calls.length, marks);

  popup.dismissOrderUpdatePopup();
  runtime.setList([weekly, orderUpdate('n2', 'o2', '#1002'), orderUpdate('n3', 'o3', '#1003')]);
  const dismissedWrites = shown.htmlWrites;
  timers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.hidden, true);
  assert.equal(shown.htmlWrites, dismissedWrites);
  assert.deepEqual(popup.unreadOrderUpdates().map(item => item.order_id), ['o2', 'o3']);

  runtime.setList([weekly, orderUpdate('n2', 'o2', '#1002'), orderUpdate('n3', 'o3', '#1003'), orderUpdate('n4', 'o4', '#1004')]);
  listeners.find(([type]) => type === 'visibilitychange')[1]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.hidden, false);
  assert.match(shown.innerHTML, /#1002/);
  assert.match(shown.innerHTML, /#1003/);
  assert.match(shown.innerHTML, /#1004/);
  assert.equal(calls.filter(call => call.action === 'mark_read').length, 1);
});

test('reopening the page shows leftover unread order updates again, without repeating them on the refresh timer', async () => {
  const weekly = { id: 'w1', kind: 'weekly_report_reminder', title: '周报提醒', body: '请填写本周周报', unread: true, order_id: null };
  const runtime = popupRuntime();
  runtime.setList([weekly, orderUpdate('n2', 'o2', '#1002'), orderUpdate('n3', 'o3', '#1003')]);
  await runtime.popup.loadUserNotifications(true);
  const shown = runtime.document.querySelector('#orderUpdatePopup');
  assert.equal(shown.hidden, false);
  assert.match(shown.innerHTML, /#1002/);
  assert.match(shown.innerHTML, /#1003/);
  const painted = shown.htmlWrites;
  runtime.timers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(shown.hidden, false);
  assert.equal(shown.htmlWrites, painted);
});

test('only the supervisor can mark every unread order update read', async () => {
  const weekly = { id: 'w1', kind: 'weekly_report_reminder', title: '周报提醒', body: '请填写本周周报', unread: true, order_id: null };
  const follower = popupRuntime();
  follower.setList([weekly, orderUpdate('n1', 'o1', '#1001'), orderUpdate('n2', 'o2', '#1002')]);
  await follower.popup.loadUserNotifications(true);
  assert.equal(follower.document.querySelector('#orderUpdatePopup').innerHTML.includes('全部标记已读'), false);
  const before = follower.calls.length;
  await follower.popup.markAllOrderUpdatesRead();
  assert.equal(follower.calls.length, before);
  assert.deepEqual(follower.popup.unreadOrderUpdates().map(item => item.order_id), ['o1', 'o2']);

  const supervisor = popupRuntime({ supervisor: true });
  supervisor.setList([weekly, orderUpdate('n1', 'o1', '#1001'), orderUpdate('n2', 'o2', '#1002')]);
  await supervisor.popup.loadUserNotifications(true);
  const shown = supervisor.document.querySelector('#orderUpdatePopup');
  assert.match(shown.innerHTML, /全部标记已读/);
  const button = shown.querySelector('[data-order-update-mark-all]');
  assert.ok(button);
  await button.onclick({ stopPropagation() {} });
  assert.deepEqual(supervisor.calls.filter(call => call.action === 'mark_read'), [{ action: 'mark_read', ids: ['n1', 'n2'] }]);
  assert.equal(supervisor.popup.unreadOrderUpdates().length, 0);
  assert.equal(supervisor.sandbox.userNotifications.find(item => item.id === 'w1').unread, true);
  assert.equal(shown.hidden, true);
  assert.match(supervisor.popup.notificationBellHtml(), /请填写本周周报/);
  assert.equal(supervisor.popup.notificationBellHtml().includes('#1001'), false);
});

test('the order-update popup stays beside the bell and opens an order through the existing card path', () => {
  const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
  const popupHtml = app.slice(app.indexOf('function orderUpdatePopupHtml'), app.indexOf('function dismissOrderUpdatePopup'));
  const dismiss = app.slice(app.indexOf('function dismissOrderUpdatePopup'), app.indexOf('function showOrderUpdatePopup'));
  const activate = app.slice(app.indexOf('async function activateOrderUpdateNotice'), app.indexOf('function syncNotificationChrome'));
  const watch = app.slice(app.indexOf('function watchOrderUpdateNotifications'), app.indexOf('watchOrderUpdateNotifications();'));
  assert.match(popupHtml, /订单信息更新/);
  assert.match(popupHtml, /isSupervisor\(\)\?`<button type="button" class="order-update-mark-all" data-order-update-mark-all="true">全部标记已读<\/button>`/);
  assert.match(app, /async function markAllOrderUpdatesRead\(\)\{if\(!isSupervisor\(\)\)return;const ids=unreadOrderUpdates\(\)\.map\(item=>item\.id\)/);
  assert.equal(popupHtml.includes('customer_info'), false);
  assert.equal(popupHtml.includes('openShopifyCreate'), false);
  assert.equal(dismiss.includes('markNotificationsRead'), false);
  assert.match(activate, /markNotificationsRead\(orderUpdateReadRequest\(item\)\)/);
  assert.match(activate, /openNotifiedOrder\(item\.order_id\)/);
  assert.equal(activate.includes('openShopifyCreate'), false);
  assert.match(watch, /loadUserNotifications\(true\)/);
  assert.match(watch, /visibilitychange/);
  assert.match(app, /popup\.id='orderUpdatePopup'/);
  assert.match(app, /data-order-update-reopen/);
  assert.match(app, /showOrderUpdatePopup\(\)/);
  assert.match(app, /id="notificationBell"/);
  assert.match(app, /class="notify-badge"/);
  assert.match(app, /class="order-notify-dot"/);
  const clickStart = app.indexOf("document.querySelectorAll('[data-order]')");
  const click = app.slice(clickStart, app.indexOf("let d=$('#detail')", clickStart));
  assert.ok(click.indexOf("current_step==='follower_create'&&canFollowOrders()){openShopifyCreate(o);return}") > 0);
});
