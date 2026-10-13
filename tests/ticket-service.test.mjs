import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TencentDataStore } from '../server/tencent-data-core.mjs';
import { TicketService } from '../server/ticket-service.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'cargo-pulse-tickets-'));
  const store = new TencentDataStore(join(dir, 'test.sqlite'));
  const users = {
    sales: store.upsertAccount({ email: 'sales@example.com', password: '12345678', role: 'business' }),
    otherSales: store.upsertAccount({ email: 'other@example.com', password: '12345678', role: 'business' }),
    icey: store.upsertAccount({ email: '2548462886@qq.com', password: '12345678', role: 'business' }),
    qinzhi: store.upsertAccount({ email: '1544264271@qq.com', password: '12345678', role: 'business' }),
    supervisor: store.upsertAccount({ email: '505863160@qq.com', password: '12345678', role: 'business' })
  };
  const service = new TicketService(store);
  return { store, service, users, close: () => { store.db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const future = hours => new Date(Date.now() + hours * 3600000).toISOString();
function createForIcey(service, users) {
  return service.create({
    title: '货物状态异常', description: '客户反馈交付时间有变化', order_no: '#9001',
    category: 'delivery', priority: 'important', assignee_id: users.icey.id
  }, users.sales.id);
}

test('ICEY 与秦枝的工单在服务端严格隔离，主管可查看全部', () => {
  const { store, service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    assert.equal(service.actor(users.icey.id).role, 'follower');
    assert.equal(service.bootstrap(users.icey.id).tickets.length, 1);
    assert.equal(service.bootstrap(users.icey.id).notifications[0].type, 'assigned');
    assert.equal(service.homeReminder(users.icey.id).count, 1);
    assert.equal(service.bootstrap(users.qinzhi.id).tickets.length, 0);
    assert.equal(service.homeReminder(users.qinzhi.id).count, 0);
    assert.equal(service.bootstrap(users.otherSales.id).tickets.length, 0);
    assert.equal(service.bootstrap(users.supervisor.id).tickets.length, 1);
    assert.throws(() => service.detail(ticket.id, users.qinzhi.id), /没有查看/);
    assert.throws(() => service.detail(ticket.id, users.otherSales.id), /没有查看/);
    assert.throws(() => service.accept(ticket.id, users.qinzhi.id), /没有查看/);
    assert.equal(service.accept(ticket.id, users.icey.id).status, 'in_progress');
    assert.throws(() => store.mutate('tickets', 'GET', new URL('http://local/rest/v1/tickets'), {}, users.qinzhi.id), /专用接口/);
  } finally { close(); }
});

test('进展、解决、确认与退回遵守四状态流程', () => {
  const { service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    service.accept(ticket.id, users.icey.id);
    assert.equal(service.badge(users.icey.id), 0);
    service.reply({ ticket_id: ticket.id, kind: 'message', text: '已向货代查询' }, users.icey.id);
    service.reply({ ticket_id: ticket.id, kind: 'progress', text: '已有进展' }, users.icey.id);
    service.reply({ ticket_id: ticket.id, kind: 'resolution', text: '已经解决' }, users.icey.id);
    assert.equal(service.ticket(ticket.id).status, 'waiting_confirmation');
    assert.equal(service.badge(users.sales.id), 1);
    assert.throws(() => service.decide({ ticket_id: ticket.id, action: 'close' }, users.icey.id), /只有提交人/);
    service.decide({ ticket_id: ticket.id, action: 'reopen', reason: '仍有问题' }, users.sales.id);
    assert.equal(service.ticket(ticket.id).status, 'in_progress');
    service.reply({ ticket_id: ticket.id, kind: 'resolution', text: '再次解决' }, users.icey.id);
    assert.equal(service.decide({ ticket_id: ticket.id, action: 'close' }, users.sales.id).status, 'closed');
    assert.equal(service.badge(users.sales.id), 0);
  } finally { close(); }
});

test('主管转交后原负责人立即失去权限，新负责人获得权限', () => {
  const { service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    service.adminUpdate({ ticket_id: ticket.id, assignee_id: users.qinzhi.id }, users.supervisor.id);
    assert.equal(service.bootstrap(users.icey.id).tickets.length, 0);
    assert.equal(service.bootstrap(users.qinzhi.id).tickets.length, 1);
    assert.throws(() => service.detail(ticket.id, users.icey.id), /没有查看/);
    assert.equal(service.detail(ticket.id, users.qinzhi.id).ticket.assignee_name, '秦枝');
  } finally { close(); }
});

test('未解决工单每 24 小时提醒一次，处理后红点消失', () => {
  const { store, service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    const stale = new Date(Date.now() - 50 * 3600000).toISOString();
    store.put('tickets', { ...ticket, updated_at: stale });
    assert.equal(service.runReminders().created, 1);
    assert.equal(service.runReminders().created, 0);
    assert.equal(service.runReminders(Date.now() + 24 * 3600000).created, 1);
    assert.equal(service.badge(users.icey.id), 1);
    assert.equal(service.badge(users.qinzhi.id), 0);
    assert.equal(service.badge(users.supervisor.id), 0);
    service.accept(ticket.id, users.icey.id);
    assert.equal(service.badge(users.icey.id), 0);
  } finally { close(); }
});

test('附件记录必须位于当前工单目录且仍受工单可见权限约束', () => {
  const { service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    assert.throws(() => service.registerAttachment({ ticket_id: ticket.id, object_path: 'other/private.pdf' }, users.sales.id), /附件路径无效/);
    const attachment = service.registerAttachment({ ticket_id: ticket.id, object_path: `${ticket.id}/proof.pdf`, file_name: 'proof.pdf' }, users.sales.id);
    assert.equal(service.canAccessFile(attachment.object_path, users.icey.id), true);
    assert.equal(service.canAccessFile(attachment.object_path, users.qinzhi.id), false);
  } finally { close(); }
});
