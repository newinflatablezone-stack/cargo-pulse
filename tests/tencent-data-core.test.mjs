import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TencentDataStore } from '../server/tencent-data-core.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-pulse-data-'));
  const store = new TencentDataStore(join(dir, 'test.sqlite'));
  return { store, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('账号、密码和刷新会话保存在腾讯云本地数据库', () => {
  const { store, close } = fixture();
  try {
    const user = store.upsertAccount({ email: 'staff@example.com', password: 'correct-password', role: 'follower' });
    const session = store.login('staff@example.com', 'correct-password');
    assert.equal(session.user.id, user.id);
    assert.equal(store.session(session.access_token).id, user.id);
    const renewed = store.refresh(session.refresh_token);
    assert.equal(renewed.user.email, 'staff@example.com');
    assert.equal(store.refresh(session.refresh_token), null);
  } finally { close(); }
});

test('兼容首页使用的 PostgREST 筛选、排序和字段选择', () => {
  const { store, close } = fixture();
  try {
    store.put('orders', { id: '1', order_no: 'A', order_date: '2026-01-01', deleted_at: null });
    store.put('orders', { id: '2', order_no: 'B', order_date: '2026-02-01', deleted_at: null });
    const url = new URL('http://local/rest/v1/orders?deleted_at=is.null&select=id,order_no&order=order_date.desc');
    assert.deepEqual(store.query('orders', url), [{ id: '2', order_no: 'B' }, { id: '1', order_no: 'A' }]);
  } finally { close(); }
});

test('业务员只读、跟单可更新、主管账号权限固定', () => {
  const { store, close } = fixture();
  try {
    const business = store.upsertAccount({ email: 'sales@example.com', password: '12345678', role: 'business' });
    const follower = store.upsertAccount({ email: 'follow@example.com', password: '12345678', role: 'follower' });
    const supervisor = store.upsertAccount({ email: '505863160@qq.com', password: '12345678', role: 'business' });
    store.put('orders', { id: 'o1', order_no: 'X' });
    const url = new URL('http://local/rest/v1/orders?id=eq.o1');
    assert.throws(() => store.mutate('orders', 'PATCH', url, { product_name: '禁止' }, business.id), /没有修改权限/);
    assert.equal(store.mutate('orders', 'PATCH', url, { product_name: '允许' }, follower.id)[0].product_name, '允许');
    assert.equal(store.profile(supervisor.id).role, 'follower');
  } finally { close(); }
});

test('首页快照一次返回首屏资料并隐藏普通账号的回收站订单', () => {
  const { store, close } = fixture();
  try {
    const user = store.upsertAccount({ email: 'business@example.com', password: 'password123', role: 'business' });
    store.put('orders', { id: 'visible', order_no: 'A-1', deleted_at: null });
    store.put('orders', { id: 'deleted', order_no: 'A-2', deleted_at: '2026-10-01T00:00:00Z' });
    store.put('order_events', { id: 'active', order_id: 'visible', note: 'tracking:ABC', completed_at: null });
    store.put('order_images', { id: 'proof', order_id: 'visible', object_path: 'visible/delivery-proof-test.png' });
    const snapshot = store.homeSnapshot(user.id);
    assert.deepEqual(snapshot.orders.map(row => row.id), ['visible']);
    assert.equal(snapshot.active_events.length, 1);
    assert.equal(snapshot.tracking_events.length, 1);
    assert.equal(snapshot.images.length, 1);
  } finally { close(); }
});
