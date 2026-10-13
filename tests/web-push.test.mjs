import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createECDH, randomBytes } from 'node:crypto';
import { TencentDataStore } from '../server/tencent-data-core.mjs';
import { TicketService } from '../server/ticket-service.mjs';
import { WebPushService, sendWebPush } from '../server/web-push.mjs';

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

test('Web Push 使用 VAPID 和 aes128gcm 生成标准加密请求', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-pulse-push-crypto-'));
  const store = new TencentDataStore(join(dir, 'test.sqlite'));
  const push = new WebPushService(store);
  const client = createECDH('prime256v1');
  client.generateKeys();
  const sub = {
    endpoint: 'https://push.example.test/send/123',
    p256dh: client.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url')
  };
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return { ok: true, status: 201 }; };
  try {
    const result = await sendWebPush(sub, { title: 'TK-1 · 新回复', body: '测试' }, push.vapid);
    assert.equal(result.status, 201);
    assert.equal(request.url, sub.endpoint);
    assert.match(request.options.headers.Authorization, /^vapid t=.+, k=.+$/);
    assert.equal(request.options.headers['Content-Encoding'], 'aes128gcm');
    assert.ok(Buffer.from(request.options.body).length > 86);
  } finally {
    globalThis.fetch = originalFetch;
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
