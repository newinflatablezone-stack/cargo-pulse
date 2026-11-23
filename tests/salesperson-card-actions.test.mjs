import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style-v2.css', import.meta.url), 'utf8');
const sales = app.slice(app.indexOf('function salespersonChoice('), app.indexOf('function orderHasUnreadNotification('));
const supervisor = app.slice(app.indexOf('const SUPERVISOR_EMAIL='), app.indexOf('function storedSupervisorSession('));
const follow = app.slice(app.indexOf('function canFollowOrders('), app.indexOf('const factoryExportSelection'));
const LEGACY = '<i>查看详情 →</i>';

function run(code, sandbox) {
  runInNewContext(code, sandbox);
  return sandbox;
}

function cardHtml(order, person) {
  const sandbox = {
    profile: { ...person },
    session: { user: { email: person.email, id: person.id } },
    order
  };
  run(supervisor + '\n' + sales + '\nhtml=salespersonCardActions(order);', sandbox);
  return sandbox.html;
}

function buttonLabels(html) {
  return [...html.matchAll(/>([^<]+)<\/button>/g)].map(match => match[1]);
}

function clickCard(order, person, view) {
  const marker = "document.querySelectorAll('[data-order]').forEach(c=>c.onclick=event=>{";
  const start = app.indexOf(marker);
  const end = app.indexOf("let d=$('#detail')", start);
  assert.ok(start > 0 && end > start);
  const opened = [];
  const stopped = [];
  const sandbox = {
    profile: { ...person },
    session: { user: { email: person.email, id: person.id } },
    orders: [order],
    opened,
    stopped,
    event: {
      stopPropagation() { stopped.push('stop'); },
      target: {
        closest(selector) {
          if (selector === '.factory-export-check') return null;
          if (view && selector === '[data-order-view]') return { dataset: { orderView: view } };
          return null;
        }
      }
    },
    c: { dataset: { order: order.id } },
    openShopifyPlace(row) { opened.push('place:' + row.id); },
    openShopifyCreate(row) { opened.push('create:' + row.id); },
    openSalespersonSupplement(row) { opened.push('supplement:' + row.current_step + ':' + row.id); },
    markOrderNotificationsRead(id) { opened.push('read:' + id); },
    alert(message) { opened.push('alert:' + message); }
  };
  const body = app.slice(start + marker.length, end);
  run(supervisor + follow + sales + 'function click(event, c){\n' + body + '\nopened.push("detail:"+c.dataset.order);\n}\nclick(event, c);', sandbox);
  return { opened, stopped };
}

const owner = { id: 'demi-1', role: 'business', email: 'demi@inflatable-zone.com', display_name: 'Demi' };
const other = { id: 'ella-1', role: 'business', email: 'sales@inflatable-zone.com', display_name: 'Ella' };
const follower = { id: 'follower-1', role: 'follower', email: 'follow@example.com' };
const supervisorUser = { id: 'boss-1', role: 'business', email: '505863160@qq.com', display_name: 'Demi' };

function order(extra) {
  return {
    id: 'order-1',
    current_step: 'production',
    deleted_at: null,
    business_id: 'demi-1',
    business_name: 'Demi',
    product_name: '机械牛',
    order_date: '2026-11-23',
    ...extra
  };
}

test('order_date uses the Beijing calendar day, with a fixed 2026-11-23 cutoff', () => {
  const sandbox = run(sales + '\ncutoff=SALESPERSON_DETAIL_CUTOFF;day=orderCardDate;', {});
  assert.equal(sandbox.cutoff, '2026-11-23');
  assert.equal(sandbox.day({ order_date: '2026-11-23' }), '2026-11-23');
  assert.equal(sandbox.day({ order_date: '2026-11-22' }), '2026-11-22');
  assert.equal(sandbox.day({ order_date: '  2026-11-24  ' }), '2026-11-24');
  assert.equal(sandbox.day({ order_date: '2026-11-22T16:00:00.000Z' }), '2026-11-23');
  assert.equal(sandbox.day({ order_date: '2026-11-22T15:59:59.000Z' }), '2026-11-22');
  assert.equal(sandbox.day({ order_date: '2026-11-23T00:00:00+08:00' }), '2026-11-23');
  assert.equal(sandbox.day({}), '');
  assert.equal(sandbox.day({ order_date: null }), '');
});

test('salesperson cards on or after 2026-11-23 show 查看详情 and 下单详情 in the existing action slot', () => {
  const html = cardHtml(order(), owner);
  assert.deepEqual(buttonLabels(html), ['查看详情', '下单详情']);
  assert.match(html, /data-order-view="detail">查看详情<\/button><button type="button" data-order-view="place">下单详情<\/button>/);
  assert.equal(html.includes('订单详情'), false);
  assert.equal(html.includes(LEGACY), false);
  assert.match(app, /\$\{esc\(o\.forwarder_name\|\|'未选择'\)\}<\/span>\$\{salespersonCardActions\(o\)\}<\/footer>/);
  assert.equal(app.split(LEGACY).length, 2);
});

test('salesperson cards before 2026-11-23 show only 查看详情', () => {
  for (const order_date of ['2026-11-22', '2026-11-22T15:59:59.000Z', '', undefined]) {
    const html = cardHtml(order({ order_date }), owner);
    assert.deepEqual(buttonLabels(html), ['查看详情'], order_date || '(blank)');
    assert.equal(html.includes('下单详情'), false, order_date || '(blank)');
    assert.equal(html.includes('订单详情'), false, order_date || '(blank)');
    assert.match(html, /data-order-view="detail">查看详情<\/button>/);
    assert.equal(html.includes('data-order-view="place"'), false);
  }
  const beijingStart = cardHtml(order({ order_date: '2026-11-22T16:00:00.000Z' }), owner);
  assert.deepEqual(buttonLabels(beijingStart), ['查看详情', '下单详情']);
});

test('pending orders open the place form directly; other cards keep their existing actions', () => {
  const current = order();
  const earlier = order({ id: 'old-1', order_date: '2026-11-22' });
  const supplement = order({ id: 'sup-1', current_step: 'sales_supplement' });
  const waiting = order({ id: 'wait-1', current_step: 'follower_create' });

  const card = clickCard(current, owner);
  assert.deepEqual(card.opened, ['read:order-1', 'detail:order-1']);
  assert.deepEqual(card.stopped, []);

  const view = clickCard(current, owner, 'detail');
  assert.deepEqual(view.opened, ['read:order-1', 'detail:order-1']);
  assert.deepEqual(view.stopped, ['stop']);
  assert.equal(view.opened.some(item => item.startsWith('place:') || item.startsWith('supplement:')), false);

  const place = clickCard(current, owner, 'place');
  assert.deepEqual(place.opened, ['read:order-1', 'supplement:production:order-1']);
  assert.deepEqual(place.stopped, ['stop']);
  assert.equal(place.opened.includes('detail:order-1'), false);

  const legacyCard = clickCard(earlier, owner);
  const legacyButton = clickCard(earlier, owner, 'detail');
  const legacyForcedPlace = clickCard(earlier, owner, 'place');
  assert.deepEqual(legacyCard.opened, ['read:old-1', 'detail:old-1']);
  assert.deepEqual(legacyButton.opened, ['read:old-1', 'detail:old-1']);
  assert.deepEqual(legacyForcedPlace.opened, ['read:old-1', 'detail:old-1']);
  for (const result of [legacyCard, legacyButton, legacyForcedPlace]) {
    assert.equal(result.opened.some(item => item.startsWith('place:') || item.startsWith('supplement:')), false);
  }

  assert.deepEqual(clickCard(supplement, owner).opened, ['read:sup-1', 'place:sup-1']);
  assert.deepEqual(clickCard(supplement, owner, 'detail').opened, ['read:sup-1', 'place:sup-1']);
  assert.deepEqual(clickCard(supplement, owner, 'place').opened, ['read:sup-1', 'place:sup-1']);
  for (const order_date of ['', '2026-11-22', '2026-11-23']) {
    const pending = {...supplement,order_date};
    assert.deepEqual(buttonLabels(cardHtml(pending,owner)), ['认领下单']);
    assert.deepEqual(clickCard(pending,owner).opened, ['read:sup-1','place:sup-1']);
    assert.deepEqual(clickCard(pending,follower).opened, ['read:sup-1','detail:sup-1']);
  }
  assert.deepEqual(clickCard(waiting, owner).opened, ['read:wait-1', 'detail:wait-1']);
  assert.deepEqual(clickCard(waiting, owner, 'place').opened, ['read:wait-1', 'supplement:follower_create:wait-1']);
  assert.deepEqual(clickCard(order({ id: 'done-1', current_step: 'completed' }), owner, 'place').opened, ['read:done-1', 'supplement:completed:done-1']);
});

test('merchandiser and supervisor cards keep 查看详情 and their existing click paths', () => {
  const current = order();
  const waiting = order({ id: 'wait-1', current_step: 'follower_create', factory_name: '' });
  const ready = { ...waiting, id: 'wait-ready', factory_name: 'Factory A' };
  const blocked = 'alert:主管须先选择工厂并保存后，跟单才能创建订单。';

  assert.equal(cardHtml(current, follower), LEGACY);
  assert.equal(cardHtml(waiting, follower), LEGACY);
  assert.equal(cardHtml(current, supervisorUser), LEGACY);
  assert.equal(cardHtml(waiting, supervisorUser), LEGACY);
  assert.equal(cardHtml(current, other), LEGACY);
  assert.equal(cardHtml(order({ deleted_at: '2026-11-23' }), owner), LEGACY);

  assert.deepEqual(clickCard(waiting, follower).opened, ['read:wait-1', blocked]);
  assert.deepEqual(clickCard(ready, follower).opened, ['read:wait-ready', 'create:wait-ready']);
  assert.deepEqual(clickCard(current, follower).opened, ['read:order-1', 'detail:order-1']);
  assert.deepEqual(clickCard(waiting, supervisorUser).opened, ['read:wait-1', 'detail:wait-1']);
  assert.equal(clickCard(waiting, supervisorUser).opened.includes('create:wait-1'), false);
  assert.deepEqual(clickCard(ready, supervisorUser).opened, ['read:wait-ready', 'create:wait-ready']);
  assert.deepEqual(clickCard(current, supervisorUser).opened, ['read:order-1', 'detail:order-1']);
  assert.deepEqual(clickCard(current, other).opened, ['read:order-1', 'detail:order-1']);

  const sharedSupplement = order({ id: 'shared-1', current_step: 'sales_supplement', business_id: 'demi-1' });
  assert.deepEqual(buttonLabels(cardHtml(sharedSupplement, other)), ['认领下单']);
  assert.deepEqual(clickCard(sharedSupplement, other).opened, ['read:shared-1', 'place:shared-1']);
  assert.deepEqual(clickCard(sharedSupplement, other, 'place').opened, ['read:shared-1', 'place:shared-1']);

  assert.match(app, /function openFollowerCreate\(o,detailDialog\)\{if\(!o\|\|o\.deleted_at\|\|o\.current_step!=='follower_create'\|\|!canFollowOrders\(\)\)return false;if\(followerFactorySaved\(o\)\)\{openShopifyCreate\(o,detailDialog\);return true\}if\(isSupervisor\(\)\)return false;alert\(FOLLOWER_FACTORY_REQUIRED\);return true\}/);
  assert.match(app, /if\(supervisorAwaitingFactoryDetail\(o\)\)return supervisorSalesReviewHtml\(o\)/);
});

test('the two salesperson actions stay visible and tappable in the card footer', () => {
  assert.match(css, /\.order-card footer \.card-order-actions\{display:flex/);
  assert.match(css, /\.order-card footer \.card-order-actions button\{[^}]*padding:6px 8px/);
  assert.match(css, /@media\(max-width:800px\)\{\.order-card footer \.card-order-actions\{[^}]*flex-direction:row[^}]*\}\.order-card footer \.card-order-actions button\{min-height:36px/);
  assert.equal(css.includes('.card-order-actions{display:none'), false);
  assert.equal(css.includes('.card-order-actions button{display:none'), false);
});
