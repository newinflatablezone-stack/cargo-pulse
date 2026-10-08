import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { TencentDataStore } from '../server/tencent-data-core.mjs';

const source = readFileSync(new URL('../app-v2.js', import.meta.url), 'utf8');
const functions = ['stableStepKey', 'trackingNumberFromNote', 'trackingNoteWithMetadata', 'saveVirtualTrackingStage'].map(name => {
  const line = source.split('\n').find(line => line.startsWith(`function ${name}(`) || line.startsWith(`async function ${name}(`));
  assert.ok(line, `Missing ${name}`);
  return line;
}).join('\n');

for (const step of ['last_mile_tracking', 'last_mile', 'ocean_tracking', 'ocean_transit']) {
  test(`实际单号保存流程：${step} 在多订单中正确保存并通过回读校验`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cargo-stage-'));
    const store = new TencentDataStore(join(dir, 'test.sqlite'));
    try {
      const user = store.upsertAccount({ email: 'follower@example.com', password: 'password123', role: 'follower' });
      for (const id of ['first', '8731', '8838']) {
        store.put('orders', { id, order_no: '#'+id, current_step: step, product_name: 'Product '+id });
        store.put('order_events', { id: 'event-'+id, order_id: id, step_key: step, completed_at: null, note: '[rollback-count:1]' });
      }
      const context = {
        api: async (path, options = {}) => {
          const url = new URL(path, 'http://local');
          const table = url.pathname.split('/').at(-1);
          return store.mutate(table, options.method || 'GET', url, options.body ? JSON.parse(options.body) : {}, user.id);
        },
        oceanTransitDays: () => 16,
        deadline: (days, date) => new Date(date.getTime()+days*86400000).toISOString(),
        refresh: async () => {}
      };
      runInNewContext(`let stageTransitionBusy=false; const TRACKING_NOTE_PREFIX='tracking:'; ${functions}`, context);
      for (const id of ['8731', '8838']) {
        const at = '2026-10-01T00:00:00.000Z';
        await context.saveVirtualTrackingStage(store.all('orders').find(row => row.id === id), 'TRUCK-'+id, at);
        const order = store.all('orders').find(row => row.id === id);
        const event = store.all('order_events').find(row => row.order_id === id);
        assert.equal(order.current_step, step.startsWith('ocean') ? 'ocean_transit' : 'last_mile');
        assert.equal(order.step_started_at, at);
        assert.equal(order.product_name, 'Product '+id);
        assert.equal(event.note, 'tracking:TRUCK-'+id+' [rollback-count:1]');
        assert.equal(event.deadline_at, order.step_deadline);
      }
      assert.equal(store.all('orders').find(row => row.id === 'first').step_started_at, undefined);
      assert.equal(store.all('order_events').find(row => row.order_id === 'first').note, '[rollback-count:1]');
    } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
