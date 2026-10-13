import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TencentDataStore } from '../server/tencent-data-core.mjs';
import { TicketService } from '../server/ticket-service.mjs';
import { WebPushService } from '../server/web-push.mjs';

function fixture(sender) {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-pulse-push-'));
  const store = new TencentDataStore(join(dir, 'test.sqlite'));
  const sales = store.upsertAccount({ email: 'sales@example.com', password: '12345678', role: 'business' });
  const icey = store.upsertAccount({ email: '2548462886@qq.com', password: '12345678', role: 'business' });
  const qinzhi = store.upsertAccount({ email: '1544264271@qq.com', password: '12345678', role: 'business' });
  const tickets = new TicketService(store);
  const push = new WebPushService(store, {
    sender,
    keys: { publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), privateKey: Buffer.alloc(32, 2).toString('base64url') }
  });
  const close = () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { store, sales, icey, qinzhi, tickets, push, close };
}

const subscription = endpoint => ({
  endpoint,
  keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 5).toString('base64url') }
});

test('Web Push 按用户保存订阅、校验工单权限并对同一事件去重', async () => {
  let sends = 0;
  const { sales, icey, qinzhi, tickets, push, close } = fixture(async () => { sends += 1; return { ok: true, status: 201 }; });
  try {
    push.subscribe(icey.id, subscription('https://push.example.test/icey'));
    const ticket = tickets.create({ description: '客户询问生产进度', priority: 'normal', assignee_id: icey.id }, sales.id);
    const notification = { id: 'notification-1', user_id: icey.id, ticket_id: ticket.id, type: 'assigned' };
    assert.equal((await push.sendTicketNotification(notification, tickets)).sent, 1);
    assert.equal((await push.sendTicketNotification(notification, tickets)).sent, 0);
    assert.equal(sends, 1);
    assert.equal((await push.sendTicketNotification({ ...notification, id: 'notification-2', user_id: qinzhi.id }, tickets)).sent, 0);
    assert.equal(sends, 1);
  } finally { close(); }
});

test('Web Push 自动清理推送服务判定失效的浏览器订阅', async () => {
  const { icey, push, close } = fixture(async () => ({ ok: false, status: 410 }));
  try {
    push.subscribe(icey.id, subscription('https://push.example.test/expired'));
    assert.equal(push.status(icey.id).subscriptions, 1);
    const result = await push.test(icey.id);
    assert.equal(result.removed, 1);
    assert.equal(push.status(icey.id).subscriptions, 0);
  } finally { close(); }
});

test('Web Push 记录投递失败并在下一次成功后恢复健康状态', async () => {
  let fail = true;
  const { icey, push, close } = fixture(async () => {
    if (fail) throw Object.assign(Error('push gateway rejected request'), { statusCode: 503 });
    return { ok: true, status: 201 };
  });
  try {
    push.subscribe(icey.id, subscription('https://push.example.test/retry'));
    await push.test(icey.id);
    assert.equal(push.status(icey.id).healthy_subscriptions, 0);
    fail = false;
    await push.test(icey.id);
    assert.equal(push.status(icey.id).healthy_subscriptions, 1);
  } finally { close(); }
});
