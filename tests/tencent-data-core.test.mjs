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

test('尚无本地密码的迁移账号返回未匹配而不是抛出异常', () => {
  const { store, close } = fixture();
  try {
    store.upsertAccount({ email: 'migrated@example.com', role: 'business' });
    assert.equal(store.accountByEmail('migrated@example.com').password_hash, null);
    assert.equal(store.login('migrated@example.com', 'legacy-password'), null);
  } finally { close(); }
});

test('主管停用账号后立即撤销会话并禁止再次登录', () => {
  const { store, close } = fixture();
  try {
    const user = store.upsertAccount({ email: 'untrusted@example.com', password: 'password123', role: 'business' });
    const session = store.login(user.email, 'password123');
    assert.ok(store.session(session.access_token));
    store.setUserActive(user.id, false);
    assert.equal(store.session(session.access_token), null);
    assert.equal(store.login(user.email, 'password123'), null);
    store.setUserActive(user.id, true);
    assert.ok(store.login(user.email, 'password123'));
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
    store.put('orders', { id: 'visible', order_no: 'A-1', business_id: user.id, deleted_at: null });
    store.put('orders', { id: 'deleted', order_no: 'A-2', deleted_at: '2026-10-01T00:00:00Z' });
    store.put('order_events', { id: 'active', order_id: 'visible', note: 'tracking:ABC', completed_at: null });
    store.put('order_images', { id: 'proof', order_id: 'visible', object_path: 'visible/delivery-proof-test.png' });
    const core = store.homeCoreSnapshot(user.id);
    const relations = store.homeRelationsSnapshot(user.id);
    assert.deepEqual(core.orders.map(row => row.id), ['visible']);
    assert.equal(Object.prototype.hasOwnProperty.call(core, 'active_events'), false);
    assert.equal(relations.active_events.length, 1);
    const snapshot = store.homeSnapshot(user.id);
    assert.deepEqual(snapshot.orders.map(row => row.id), ['visible']);
    assert.equal(snapshot.active_events.length, 1);
    assert.equal(snapshot.tracking_events.length, 1);
    assert.equal(snapshot.images.length, 1);
    assert.deepEqual(snapshot.profiles.map(row => row.id), [user.id]);
  } finally { close(); }
});

for (const table of ['orders', 'order_events', 'order_shipments', 'order_shipment_events', 'partners', 'order_factories', 'order_images', 'app_settings', 'internal_resource_tables']) {
  test(`${table} 更新只修改筛选命中的记录，保留身份和其余字段`, () => {
    const { store, close } = fixture();
    try {
      const user = store.upsertAccount({ email: 'follower@example.com', password: 'password123', role: 'follower' });
      const key = table === 'app_settings' ? 'key' : table === 'internal_resource_tables' ? 'resource_key' : 'id';
      store.put(table, { [key]: 'first', note: 'keep-first', current_step: 'last_mile_tracking', custom: 'first-value' });
      store.put(table, { [key]: 'target', note: 'keep-target', current_step: 'last_mile_tracking', custom: 'target-value' });
      const url = new URL(`http://local/rest/v1/${table}?${key}=eq.target&current_step=eq.last_mile_tracking&select=note,current_step`);
      const result = store.mutate(table, 'PATCH', url, { note: 'tracking:S182908058731', current_step: 'last_mile' }, user.id);
      assert.deepEqual(result, [{ note: 'tracking:S182908058731', current_step: 'last_mile' }]);
      const rows = store.all(table);
      assert.equal(rows.length, 2);
      assert.equal(rows.find(row => row[key] === 'first').note, 'keep-first');
      const target = rows.find(row => row[key] === 'target');
      assert.equal(target.note, 'tracking:S182908058731');
      assert.equal(target.custom, 'target-value');
      assert.equal(target.current_step, 'last_mile');
      assert.deepEqual(store.mutate(table, 'PATCH', url, { note: 'stale-write' }, user.id), []);
    } finally { close(); }
  });
}

test('批量更新和带投影删除不会混淆主键', () => {
  const { store, close } = fixture();
  try {
    const user = store.upsertAccount({ email: 'follower@example.com', password: 'password123', role: 'follower' });
    for (const id of ['first', 'second', 'third']) store.put('order_events', { id, order_id: id === 'first' ? 'other' : 'target', note: id });
    const url = new URL('http://local/rest/v1/order_events?order_id=eq.target&select=note');
    assert.equal(store.mutate('order_events', 'PATCH', url, { note: 'tracking:TRUCK123' }, user.id).length, 2);
    assert.equal(store.all('order_events').find(row => row.id === 'first').note, 'first');
    assert.equal(store.mutate('order_events', 'DELETE', url, {}, user.id).length, 2);
    assert.deepEqual(store.all('order_events').map(row => row.id), ['first']);
  } finally { close(); }
});

test('物流参数和库存使用独立编辑权限，跟单和主管能保存，业务员只读', () => {
  const {store,close}=fixture();
  try {
    const follower=store.upsertAccount({email:'follower-resource@example.com',password:'password123',role:'follower'});
    const business=store.upsertAccount({email:'sales-resource@example.com',password:'password123',role:'business'});
    const supervisor=store.upsertAccount({email:'505863160@qq.com',password:'password123',role:'business'});
    for(const key of ['logistics','inventory']) {
      store.put('internal_resource_tables',{resource_key:key,headers:['名称'],rows:[['原始数据']],updated_at:'2026-10-17'});
      const url=new URL('http://local/rest/v1/internal_resource_tables?resource_key=eq.'+key);
      for(const user of [follower,supervisor]) {
        assert.equal(store.internalResourcePermissions(user.id).can_edit,true);
        const result=store.mutate('internal_resource_tables','PATCH',url,{rows:[['跟单修改']],updated_by:user.id},user.id);
        assert.deepEqual(result[0].rows,[['跟单修改']]);
      }
      assert.equal(store.internalResourcePermissions(business.id).can_edit,false);
      assert.throws(()=>store.mutate('internal_resource_tables','PATCH',url,{rows:[]},business.id),{status:403});
      assert.equal(store.mutate('internal_resource_tables','GET',url,{},business.id).length,1);
    }
  }finally{close();}
});
