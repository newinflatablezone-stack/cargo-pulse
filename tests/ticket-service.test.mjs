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

test('新建工单不需要标题并自动使用问题描述第一行作为摘要', () => {
  const { service, users, close } = fixture();
  try {
    const ticket = service.create({
      description: '客户反馈货物未更新\n请尽快核实', category: 'logistics',
      priority: 'normal', assignee_id: users.icey.id
    }, users.sales.id);
    assert.equal(ticket.title, '客户反馈货物未更新');
    assert.equal(ticket.description, '客户反馈货物未更新\n请尽快核实');
  } finally { close(); }
});

test('ICEY 与秦枝的工单在服务端严格隔离，主管可查看全部', () => {
  const { store, service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    assert.equal(service.actor(users.icey.id).role, 'follower');
    assert.equal(service.bootstrap(users.icey.id).tickets.length, 1);
    assert.equal(service.bootstrap(users.icey.id).notifications[0].type, 'assigned');
    assert.equal(service.bootstrap(users.icey.id).settings.normal, 9);
    assert.equal(service.bootstrap(users.icey.id).settings.important, 6);
    assert.equal(service.bootstrap(users.icey.id).settings.urgent, 3);
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
    assert.throws(() => service.reply({ ticket_id: ticket.id, kind: 'message', text: '已向货代查询' }, users.icey.id), /请选择/);
    service.reply({ ticket_id: ticket.id, kind: 'progress', text: '已向货代查询，需要继续处理' }, users.icey.id);
    assert.equal(service.ticket(ticket.id).status, 'in_progress');
    assert.equal(service.badge(users.icey.id), 0);
    assert.equal(service.badge(users.sales.id), 1);
    assert.match(service.unreadNotifications(users.sales.id)[0].title, /更新了处理进展/);
    service.reply({ ticket_id: ticket.id, kind: 'message', text: '客户正在等待' }, users.sales.id);
    assert.equal(service.badge(users.icey.id), 1);
    assert.match(service.unreadNotifications(users.icey.id)[0].title, /发送了新消息/);
    service.reply({ ticket_id: ticket.id, kind: 'progress', text: '已有进展' }, users.icey.id);
    assert.equal(service.badge(users.icey.id), 0);
    service.reply({ ticket_id: ticket.id, kind: 'resolution', text: '已经解决' }, users.icey.id);
    assert.equal(service.ticket(ticket.id).status, 'waiting_confirmation');
    assert.equal(service.badge(users.sales.id), 1);
    assert.throws(() => service.reply({ ticket_id: ticket.id, kind: 'message', text: '普通回复' }, users.sales.id), /确认已解决或退回处理/);
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

test('普通每 9 小时、重要每 6 小时、紧急每 3 小时循环提醒', () => {
  const { store, service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    const stale = new Date(Date.now() - 9 * 3600000 - 1000).toISOString();
    store.put('tickets', { ...ticket, updated_at: stale });
    assert.equal(service.runReminders().created, 1);
    assert.equal(service.runReminders().created, 0);
    assert.equal(service.runReminders(Date.now() + 9 * 3600000).created, 1);
    assert.equal(service.badge(users.icey.id), 1);
    assert.equal(service.badge(users.qinzhi.id), 0);
    assert.equal(service.badge(users.supervisor.id), 0);
    service.reply({ ticket_id: ticket.id, kind: 'progress', text: '继续处理' }, users.icey.id);
    assert.equal(service.badge(users.icey.id), 0);
    store.put('tickets', { ...service.ticket(ticket.id), status: 'closed' });

    const important = service.create({
      title: '重要物流异常', description: '可能影响交付', category: 'logistics',
      priority: 'important', assignee_id: users.icey.id
    }, users.sales.id);
    service.markNotificationsRead(users.icey.id);
    store.put('tickets', { ...important, updated_at: new Date(Date.now() - 6 * 3600000 - 1000).toISOString() });
    assert.equal(service.runReminders().created, 1);
    assert.equal(service.runReminders().created, 0);
    assert.equal(service.runReminders(Date.now() + 6 * 3600000).created, 1);
    store.put('tickets', { ...service.ticket(important.id), status: 'closed' });

    const urgent = service.create({
      title: '紧急交付异常', description: '已经影响交付', category: 'delivery',
      priority: 'urgent', assignee_id: users.qinzhi.id
    }, users.sales.id);
    service.markNotificationsRead(users.qinzhi.id);
    const urgentStale = new Date(Date.now() - 3 * 3600000 - 1000).toISOString();
    store.put('tickets', { ...urgent, updated_at: urgentStale });
    assert.equal(service.runReminders().created, 1);
    assert.equal(service.runReminders().created, 0);
    assert.equal(service.runReminders(Date.now() + 3 * 3600000).created, 1);
    assert.equal(service.badge(users.qinzhi.id), 1);
  } finally { close(); }
});

test('工单汇总标记已超时，按等级阈值计算且已解决不计入', () => {
  const { store, service, users, close } = fixture();
  try {
    const important = createForIcey(service, users);
    store.put('tickets', { ...important, updated_at: new Date(Date.now() - 6 * 3600000 - 1000).toISOString() });
    let summary = service.bootstrap(users.supervisor.id).tickets.find(row => row.id === important.id);
    assert.equal(summary.reminder_interval_hours, 6);
    assert.equal(summary.is_overdue, true);
    assert.ok(summary.overdue_seconds >= 1);

    store.put('tickets', { ...service.ticket(important.id), status: 'closed' });
    summary = service.bootstrap(users.supervisor.id).tickets.find(row => row.id === important.id);
    assert.equal(summary.is_overdue, false);
    assert.equal(summary.overdue_seconds, 0);
  } finally { close(); }
});

test('打开工单即视为已读，只清除该工单提醒', () => {
  const { service, users, close } = fixture();
  try {
    const first = createForIcey(service, users);
    const second = service.create({
      title: '第二张工单', description: '用于验证逐单已读', category: 'logistics',
      priority: 'normal', assignee_id: users.icey.id
    }, users.sales.id);
    assert.equal(service.badge(users.icey.id), 2);
    service.detail(first.id, users.icey.id);
    assert.equal(service.badge(users.icey.id), 1);
    assert.equal(service.unreadNotifications(users.icey.id)[0].ticket_id, second.id);
    service.detail(second.id, users.icey.id);
    assert.equal(service.badge(users.icey.id), 0);
  } finally { close(); }
});

test('每张工单按业务员等待到跟单有效回复计算平均回复时间', () => {
  const { store, service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    const created = store.all('ticket_messages').find(row => row.ticket_id === ticket.id && row.kind === 'created');
    store.put('ticket_messages', { ...created, created_at: '2026-10-13T10:00:00.000Z' });
    const first = service.reply({ ticket_id: ticket.id, kind: 'progress', text: '第一次回复' }, users.icey.id).message;
    store.put('ticket_messages', { ...first, created_at: '2026-10-13T12:00:00.000Z' });
    const followUp = service.reply({ ticket_id: ticket.id, kind: 'message', text: '业务员补充' }, users.sales.id).message;
    store.put('ticket_messages', { ...followUp, created_at: '2026-10-13T14:00:00.000Z' });
    const second = service.reply({ ticket_id: ticket.id, kind: 'resolution', text: '第二次回复' }, users.icey.id).message;
    store.put('ticket_messages', { ...second, created_at: '2026-10-13T15:00:00.000Z' });
    const listed = service.bootstrap(users.sales.id).tickets.find(row => row.id === ticket.id);
    assert.equal(listed.average_response_seconds, 90 * 60);
    assert.equal(listed.response_count, 2);
    assert.equal(service.detail(ticket.id, users.sales.id).ticket.average_response_seconds, 90 * 60);
  } finally { close(); }
});

test('只有管理员可以删除聊天记录，原始问题不可删除', () => {
  const { store, service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    const reply = service.reply({ ticket_id: ticket.id, kind: 'progress', text: '可删除的回复' }, users.icey.id).message;
    service.registerAttachment({ ticket_id: ticket.id, message_id: reply.id, object_path: `${ticket.id}/reply.pdf`, file_name: 'reply.pdf' }, users.icey.id);
    assert.throws(() => service.deleteMessage(reply.id, users.sales.id), /仅管理员/);
    assert.throws(() => service.deleteMessage(reply.id, users.icey.id), /仅管理员/);
    assert.equal(service.deleteMessage(reply.id, users.supervisor.id).ok, true);
    assert.equal(store.all('ticket_messages').some(row => row.id === reply.id), false);
    assert.equal(store.all('ticket_attachments').some(row => row.message_id === reply.id), false);
    const created = store.all('ticket_messages').find(row => row.ticket_id === ticket.id && row.kind === 'created');
    assert.throws(() => service.deleteMessage(created.id, users.supervisor.id), /原始问题/);
  } finally { close(); }
});

test('待业务员确认持续提醒提交人，确认解决后停止提醒', () => {
  const { store, service, users, close } = fixture();
  try {
    const ticket = createForIcey(service, users);
    service.reply({ ticket_id: ticket.id, kind: 'resolution', text: '处理完成，请确认' }, users.icey.id);
    service.markNotificationsRead(users.sales.id);
    const waiting = service.ticket(ticket.id);
    store.put('tickets', { ...waiting, updated_at: new Date(Date.now() - 9 * 3600000 - 1000).toISOString() });
    assert.equal(service.runReminders().created, 1);
    assert.equal(service.badge(users.sales.id), 1);
    service.decide({ ticket_id: ticket.id, action: 'close' }, users.sales.id);
    assert.equal(service.badge(users.sales.id), 0);
    assert.equal(service.runReminders(Date.now() + 24 * 3600000).created, 0);
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
