import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { lookupCustomerTracking } from '../server/tencent-data-core.mjs';

function fixture() {
  const tables = {
    orders: [
      { id: 'old', customer_info: 'Alice alice@example.com', order_date: '2026-01-01' },
      { id: 'latest', order_no: 'ORDER-2', customer_info: 'Alice ALICE@example.com +1 (626) 342-7272', order_date: '2026-02-01', current_step: 'ocean_transit', internal_secret: 'private' },
      { id: 'deleted', customer_info: 'alice@example.com', order_date: '2026-03-01', deleted_at: '2026-03-02' }
    ],
    order_events: [
      { id: 'e2', order_id: 'latest', step_key: 'ocean_transit', started_at: '2026-02-02', note: 'tracking:ABC123' },
      { id: 'e1', order_id: 'latest', step_key: 'production', started_at: '2026-02-01', note: 'private staff note' },
      { id: 'other', order_id: 'old', step_key: 'rendering' }
    ],
    order_shipments: [{ id: 's1', order_id: 'latest', batch_name: 'Batch 1', current_step: 'delivery' }],
    order_shipment_events: [{ id: 'se1', shipment_id: 's1', step_key: 'delivery', note: 'tracking:LAST123' }]
  };
  return { all: name => tables[name] || [] };
}

test('客户查询返回页面所需的订单、物流节点及分批运输，且只公开允许字段', () => {
  const result = lookupCustomerTracking(fixture(), '  Alice@Example.COM  ');
  assert.equal(result.found, true);
  assert.equal(result.order.order_no, 'ORDER-2');
  assert.equal(result.order.current_step, 'ocean_transit');
  assert.equal('internal_secret' in result.order, false);
  assert.equal('id' in result.order, false);
  assert.ok(!result.order.customer_info.includes('342-7272'));
  assert.deepEqual(result.events.map(event => event.step_key), ['production', 'ocean_transit']);
  assert.equal(result.events[0].tracking_no, null);
  assert.equal('note' in result.events[0], false);
  assert.equal(result.events[1].tracking_no, 'ABC123');
  assert.equal(result.shipments[0].events[0].tracking_no, 'LAST123');
});

test('客户邮箱必须完整匹配，空值、子串及已删除订单不会泄露订单', () => {
  for (const email of ['', null, 'alice', 'ice@example.com', 'alice@example.co', 'nobody@example.com']) {
    assert.deepEqual(lookupCustomerTracking(fixture(), email), { found: false });
  }
  const store = { all: name => name === 'orders' ? [{ customer_info: 'alice@example.com', deleted_at: '2026-01-01' }] : [] };
  assert.deepEqual(lookupCustomerTracking(store, 'alice@example.com'), { found: false });
});

test('查询页支持 same-origin 配置及外部 Supabase 地址', async () => {
  for (const url of ['same-origin', 'https://project.supabase.co/']) {
    const nodes = Object.fromEntries(['#track-form', '#email', '#submit-button', '#form-message', '#result'].map(id => [id, { replaceChildren() {}, validity: { valid: true }, value: 'alice@example.com' }]));
    let submit;
    nodes['#track-form'].addEventListener = (_, handler) => { submit = handler; };
    const calls = [];
    runInNewContext(readFileSync(new URL('../public/track/app.js', import.meta.url), 'utf8'), {
      document: { querySelector: id => nodes[id] },
      location: { origin: 'https://track.example.com' },
      fetch: async (target, options) => {
        calls.push({ target, options });
        return { ok: true, json: async () => target === '/api/config' ? { url, key: 'local' } : { found: false } };
      }
    });
    await submit({ preventDefault() {} });
    assert.equal(calls[1].target, `${url === 'same-origin' ? 'https://track.example.com' : 'https://project.supabase.co'}/rest/v1/rpc/lookup_customer_tracking`);
    assert.deepEqual(JSON.parse(calls[1].options.body), { p_email: 'alice@example.com' });
    assert.equal(nodes['#form-message'].textContent, 'No matching shipment was found. Please check your email address.');
    assert.equal(nodes['#submit-button'].disabled, false);
  }
});
