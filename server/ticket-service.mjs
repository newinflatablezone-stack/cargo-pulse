import { randomUUID } from 'node:crypto';

export const SUPERVISOR_EMAIL = '505863160@qq.com';
export const TICKET_FOLLOWERS = new Map([
  ['2548462886@qq.com', 'ICEY'],
  ['1544264271@qq.com', '秦枝']
]);
export const TICKET_TABLES = [
  'tickets', 'ticket_messages', 'ticket_attachments', 'ticket_history',
  'ticket_notifications', 'ticket_reminder_logs'
];

const now = () => new Date().toISOString();
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const emailOf = value => String(value || '').trim().toLowerCase();
const priorityRank = { urgent: 0, important: 1, normal: 2 };
const defaultSettings = { normal: 24, important: 12, urgent: 4 };
const activeStatuses = new Set(['pending', 'in_progress']);

function futureIso(value, label = '反馈截止时间') {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) fail(`${label}无效`);
  if (date.getTime() <= Date.now()) fail(`${label}必须晚于当前时间`);
  return date.toISOString();
}

export class TicketService {
  constructor(store) { this.store = store; }

  actor(userId) {
    const account = this.store.accountById(userId);
    const profile = this.store.profile(userId);
    if (!account || !profile) fail('登录已失效', 401);
    const email = emailOf(account.email);
    return {
      id: userId,
      email,
      role: email === SUPERVISOR_EMAIL ? 'supervisor' : TICKET_FOLLOWERS.has(email) ? 'follower' : profile.role,
      name: email === SUPERVISOR_EMAIL ? '主管' : TICKET_FOLLOWERS.get(email) || profile.name || email
    };
  }

  isSupervisor(actor) { return actor.email === SUPERVISOR_EMAIL; }
  isDesignatedFollower(actor) { return actor.role === 'follower' && TICKET_FOLLOWERS.has(actor.email); }
  ticket(id) { return this.store.all('tickets').find(row => row.id === id); }
  canView(ticket, actor) {
    return Boolean(ticket) && (this.isSupervisor(actor) || ticket.created_by === actor.id || ticket.assignee_id === actor.id);
  }
  requireTicket(id, actor) {
    const ticket = this.ticket(id);
    if (!ticket || ticket.archived_at && !this.isSupervisor(actor)) fail('工单不存在', 404);
    if (!this.canView(ticket, actor)) fail('没有查看该工单的权限', 403);
    return ticket;
  }
  requireAssignee(ticket, actor) {
    if (!this.isSupervisor(actor) && ticket.assignee_id !== actor.id) fail('只有当前负责人可以处理该工单', 403);
  }

  followers() {
    const profiles = this.store.all('profiles');
    return [...TICKET_FOLLOWERS].map(([email, name]) => {
      const profile = profiles.find(row => emailOf(row.email) === email);
      return profile ? { id: profile.id, email, name } : { id: null, email, name };
    });
  }

  settings() {
    const row = this.store.all('app_settings').find(item => item.key === 'ticket_sla_hours');
    try { return { ...defaultSettings, ...(JSON.parse(row?.value || '{}')) }; }
    catch { return { ...defaultSettings }; }
  }

  overdueInfo(ticket, at = Date.now()) {
    if (!activeStatuses.has(ticket.status) || !ticket.current_deadline) return { level: 'none', hours: 0 };
    const due = new Date(ticket.current_deadline).getTime();
    if (!Number.isFinite(due)) return { level: 'none', hours: 0 };
    const hours = (at - due) / 3600000;
    if (hours >= 48) return { level: 'red', hours };
    if (hours >= 0) return { level: 'orange', hours };
    if (hours >= -24) return { level: 'yellow', hours: 0 };
    return { level: 'none', hours: 0 };
  }

  visibleTickets(actor) {
    return this.store.all('tickets').filter(ticket => !ticket.archived_at && this.canView(ticket, actor)).map(ticket => ({
      ...ticket,
      overdue: this.overdueInfo(ticket)
    })).sort((a, b) => {
      const ao = ['red', 'orange'].includes(a.overdue.level) ? 0 : 1;
      const bo = ['red', 'orange'].includes(b.overdue.level) ? 0 : 1;
      return ao - bo || priorityRank[a.priority] - priorityRank[b.priority] || String(a.current_deadline || '9999').localeCompare(String(b.current_deadline || '9999')) || String(b.updated_at).localeCompare(String(a.updated_at));
    });
  }

  badge(userId) {
    const actor = this.actor(userId);
    return this.visibleTickets(actor).filter(ticket => {
      if (actor.role === 'business') return ticket.status === 'waiting_confirmation' || ['orange', 'red'].includes(ticket.overdue.level);
      return ['orange', 'red'].includes(ticket.overdue.level);
    }).length;
  }

  unreadNotifications(userId) {
    const actor = this.actor(userId);
    return this.store.all('ticket_notifications')
      .filter(row => row.user_id === actor.id && !row.read_at)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  homeReminder(userId) {
    const actor = this.actor(userId);
    const notifications = this.unreadNotifications(userId);
    const actionTickets = this.visibleTickets(actor).filter(ticket => {
      if (actor.role === 'business') return ticket.status === 'waiting_confirmation' || ['orange', 'red'].includes(ticket.overdue.level);
      return ['orange', 'red'].includes(ticket.overdue.level);
    });
    const ticketIds = new Set([
      ...notifications.map(row => row.ticket_id).filter(Boolean),
      ...actionTickets.map(ticket => ticket.id)
    ]);
    return { count: ticketIds.size, notifications: notifications.slice(0, 20) };
  }

  bootstrap(userId) {
    const actor = this.actor(userId);
    const notifications = this.unreadNotifications(userId);
    return {
      actor,
      followers: this.followers(),
      settings: this.settings(),
      tickets: this.visibleTickets(actor),
      notifications,
      badge_count: this.badge(userId)
    };
  }

  nextNumber() {
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const prefix = `TK-${day}-`;
    const latest = this.store.all('tickets').filter(row => String(row.ticket_no || '').startsWith(prefix)).reduce((max, row) => Math.max(max, Number(String(row.ticket_no).slice(prefix.length)) || 0), 0);
    return `${prefix}${String(latest + 1).padStart(4, '0')}`;
  }

  history(ticketId, actor, action, details = {}) {
    this.store.put('ticket_history', { id: randomUUID(), ticket_id: ticketId, actor_id: actor.id, actor_email: actor.email, actor_name: actor.name, action, details, created_at: now() });
  }

  notify(userId, ticketId, type, title, dedupeKey = '') {
    if (!userId) return null;
    if (dedupeKey && this.store.all('ticket_notifications').some(row => row.dedupe_key === dedupeKey && row.user_id === userId)) return null;
    return this.store.put('ticket_notifications', { id: randomUUID(), user_id: userId, ticket_id: ticketId, type, title, dedupe_key: dedupeKey || null, read_at: null, created_at: now() });
  }

  create(body, userId) {
    const actor = this.actor(userId);
    if (actor.role !== 'business' && !this.isSupervisor(actor)) fail('只有业务员或主管可以创建工单', 403);
    const title = String(body.title || '').trim(), description = String(body.description || '').trim();
    if (!title || !description) fail('请填写标题和问题描述');
    if (!['production', 'logistics', 'delivery', 'after_sales', 'other'].includes(body.category)) fail('问题分类无效');
    if (!['normal', 'important', 'urgent'].includes(body.priority)) fail('优先级无效');
    const follower = this.followers().find(item => item.id === body.assignee_id && item.id);
    if (!follower) fail('请选择 ICEY 或秦枝作为负责人');
    const stamp = now(), deadline = futureIso(body.first_deadline, '首次反馈截止时间');
    const ticket = this.store.put('tickets', {
      id: randomUUID(), ticket_no: this.nextNumber(), title, description,
      order_no: String(body.order_no || '').trim() || null, category: body.category, priority: body.priority,
      status: 'pending', created_by: actor.id, creator_email: actor.email, creator_name: actor.name,
      assignee_id: follower.id, assignee_email: follower.email, assignee_name: follower.name,
      first_deadline: deadline, current_deadline: deadline, accepted_at: null, resolved_at: null,
      closed_at: null, archived_at: null, created_at: stamp, updated_at: stamp
    });
    this.store.put('ticket_messages', { id: randomUUID(), ticket_id: ticket.id, kind: 'created', text: description, author_id: actor.id, author_email: actor.email, author_name: actor.name, created_at: stamp });
    this.history(ticket.id, actor, 'created', { priority: ticket.priority, assignee_email: follower.email, deadline });
    this.notify(follower.id, ticket.id, 'assigned', `新工单 ${ticket.ticket_no} 已分配给你`, `assigned:${ticket.id}:${follower.id}`);
    return ticket;
  }

  detail(ticketId, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(ticketId, actor);
    return {
      ticket: { ...ticket, overdue: this.overdueInfo(ticket) },
      messages: this.store.all('ticket_messages').filter(row => row.ticket_id === ticket.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
      attachments: this.store.all('ticket_attachments').filter(row => row.ticket_id === ticket.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
      history: this.store.all('ticket_history').filter(row => row.ticket_id === ticket.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    };
  }

  accept(ticketId, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(ticketId, actor);
    this.requireAssignee(ticket, actor);
    if (ticket.status !== 'pending') fail('只有待处理工单可以接手', 409);
    const updated = this.store.put('tickets', { ...ticket, status: 'in_progress', accepted_at: now(), updated_at: now() });
    this.history(ticket.id, actor, 'status_changed', { from: 'pending', to: 'in_progress' });
    return updated;
  }

  reply(body, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(body.ticket_id, actor);
    const kind = body.kind || 'message', text = String(body.text || '').trim();
    if (!text) fail('请填写回复内容');
    if (ticket.status === 'closed') fail('已关闭工单不能继续回复', 409);
    if (!['message', 'progress', 'resolution'].includes(kind)) fail('回复类型无效');
    if (kind !== 'message') this.requireAssignee(ticket, actor);
    let updated = ticket, nextDeadline = null;
    if (kind === 'progress') {
      if (!activeStatuses.has(ticket.status)) fail('当前状态不能提交进展', 409);
      nextDeadline = futureIso(body.next_deadline, '下一次反馈时间');
      updated = this.store.put('tickets', { ...ticket, status: 'in_progress', current_deadline: nextDeadline, accepted_at: ticket.accepted_at || now(), updated_at: now() });
      this.history(ticket.id, actor, 'progress_updated', { previous_deadline: ticket.current_deadline, next_deadline: nextDeadline, previous_overdue: this.overdueInfo(ticket).hours });
    } else if (kind === 'resolution') {
      if (!activeStatuses.has(ticket.status)) fail('当前状态不能提交解决结果', 409);
      updated = this.store.put('tickets', { ...ticket, status: 'waiting_confirmation', current_deadline: null, resolved_at: now(), updated_at: now() });
      this.history(ticket.id, actor, 'status_changed', { from: ticket.status, to: 'waiting_confirmation' });
      this.notify(ticket.created_by, ticket.id, 'resolution', `${ticket.ticket_no} 已提交解决结果，等待你的确认`, `resolution:${ticket.id}:${updated.resolved_at}`);
    }
    const message = this.store.put('ticket_messages', { id: randomUUID(), ticket_id: ticket.id, kind, text, next_deadline: nextDeadline, author_id: actor.id, author_email: actor.email, author_name: actor.name, created_at: now() });
    if (kind === 'message') this.store.put('tickets', { ...ticket, updated_at: now() });
    return { ticket: updated, message };
  }

  decide(body, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(body.ticket_id, actor);
    if (ticket.created_by !== actor.id && !this.isSupervisor(actor)) fail('只有提交人可以确认处理结果', 403);
    if (ticket.status !== 'waiting_confirmation') fail('当前工单不在待确认状态', 409);
    if (body.action === 'close') {
      const updated = this.store.put('tickets', { ...ticket, status: 'closed', closed_at: now(), updated_at: now() });
      this.history(ticket.id, actor, 'status_changed', { from: 'waiting_confirmation', to: 'closed' });
      this.notify(ticket.assignee_id, ticket.id, 'closed', `${ticket.ticket_no} 已由业务员确认关闭`, `closed:${ticket.id}`);
      return updated;
    }
    if (body.action === 'reopen') {
      const reason = String(body.reason || '').trim();
      if (!reason) fail('请填写退回原因');
      const deadline = futureIso(body.next_deadline, '新的反馈截止时间');
      const updated = this.store.put('tickets', { ...ticket, status: 'in_progress', current_deadline: deadline, resolved_at: null, closed_at: null, updated_at: now() });
      this.store.put('ticket_messages', { id: randomUUID(), ticket_id: ticket.id, kind: 'reopened', text: reason, next_deadline: deadline, author_id: actor.id, author_email: actor.email, author_name: actor.name, created_at: now() });
      this.history(ticket.id, actor, 'reopened', { reason, next_deadline: deadline });
      this.notify(ticket.assignee_id, ticket.id, 'reopened', `${ticket.ticket_no} 已被业务员退回处理`, `reopened:${ticket.id}:${deadline}`);
      return updated;
    }
    fail('确认操作无效');
  }

  adminUpdate(body, userId) {
    const actor = this.actor(userId);
    if (!this.isSupervisor(actor)) fail('仅主管可以调整工单', 403);
    const ticket = this.requireTicket(body.ticket_id, actor), changes = {}, details = {};
    if (body.priority && body.priority !== ticket.priority) {
      if (!['normal', 'important', 'urgent'].includes(body.priority)) fail('优先级无效');
      changes.priority = body.priority; details.priority = { from: ticket.priority, to: body.priority };
    }
    if (body.assignee_id && body.assignee_id !== ticket.assignee_id) {
      const follower = this.followers().find(item => item.id === body.assignee_id && item.id);
      if (!follower) fail('负责人无效');
      changes.assignee_id = follower.id; changes.assignee_email = follower.email; changes.assignee_name = follower.name;
      details.assignee = { from: ticket.assignee_email, to: follower.email };
      this.notify(follower.id, ticket.id, 'assigned', `${ticket.ticket_no} 已转交给你`, `transferred:${ticket.id}:${follower.id}:${Date.now()}`);
    }
    if (body.current_deadline && body.current_deadline !== ticket.current_deadline) {
      const reason = String(body.deadline_reason || '').trim();
      if (!reason) fail('修改截止时间必须填写原因');
      changes.current_deadline = futureIso(body.current_deadline); details.deadline = { from: ticket.current_deadline, to: changes.current_deadline, reason, previous_overdue: this.overdueInfo(ticket).hours };
    }
    if (!Object.keys(changes).length) return ticket;
    const updated = this.store.put('tickets', { ...ticket, ...changes, updated_at: now() });
    this.history(ticket.id, actor, 'admin_updated', details);
    return updated;
  }

  archive(ticketId, userId) {
    const actor = this.actor(userId);
    if (!this.isSupervisor(actor)) fail('仅主管可以归档工单', 403);
    const ticket = this.requireTicket(ticketId, actor);
    if (ticket.status !== 'closed') fail('只有已关闭工单可以归档', 409);
    const updated = this.store.put('tickets', { ...ticket, archived_at: now(), updated_at: now() });
    this.history(ticket.id, actor, 'archived');
    return updated;
  }

  updateSettings(body, userId) {
    const actor = this.actor(userId);
    if (!this.isSupervisor(actor)) fail('仅主管可以配置反馈时限', 403);
    const next = {};
    for (const key of ['normal', 'important', 'urgent']) {
      const value = Number(body[key]);
      if (!Number.isFinite(value) || value < 1 || value > 720) fail('反馈时限必须为 1–720 小时');
      next[key] = value;
    }
    this.store.put('app_settings', { key: 'ticket_sla_hours', value: JSON.stringify(next), updated_at: now() });
    return next;
  }

  markNotificationsRead(userId) {
    const actor = this.actor(userId), stamp = now();
    for (const row of this.store.all('ticket_notifications').filter(item => item.user_id === actor.id && !item.read_at)) this.store.put('ticket_notifications', { ...row, read_at: stamp });
    return { ok: true };
  }

  registerAttachment(body, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(body.ticket_id, actor);
    if (ticket.status === 'closed') fail('已关闭工单不能上传附件', 409);
    const objectPath = String(body.object_path || '');
    if (!objectPath.startsWith(`${ticket.id}/`) || objectPath.includes('..') || objectPath.includes('\\')) fail('附件路径无效');
    return this.store.put('ticket_attachments', { id: randomUUID(), ticket_id: ticket.id, message_id: body.message_id || null, file_name: String(body.file_name || '附件'), object_path: objectPath, mime_type: body.mime_type || 'application/octet-stream', size: Number(body.size || 0), uploaded_by: actor.id, uploader_name: actor.name, created_at: now() });
  }

  canAccessFile(path, userId) {
    const actor = this.actor(userId), attachment = this.store.all('ticket_attachments').find(row => row.object_path === path);
    return Boolean(attachment && this.canView(this.ticket(attachment.ticket_id), actor));
  }

  runReminders(at = Date.now()) {
    const supervisor = this.followUser(SUPERVISOR_EMAIL);
    let created = 0;
    for (const ticket of this.store.all('tickets').filter(row => !row.archived_at && activeStatuses.has(row.status))) {
      const info = this.overdueInfo(ticket, at);
      if (!['orange', 'red'].includes(info.level)) continue;
      if (this.notify(ticket.assignee_id, ticket.id, 'overdue', `${ticket.ticket_no} 已超过反馈截止时间`, `overdue:${ticket.id}:${ticket.current_deadline}`)) created += 1;
      if (info.hours >= 48 && supervisor) {
        const bucket = Math.floor(info.hours / 24);
        if (this.notify(supervisor.id, ticket.id, 'escalation', `${ticket.ticket_no} 已持续超期 ${Math.floor(info.hours)} 小时`, `escalation:${ticket.id}:${ticket.current_deadline}:${bucket}`)) created += 1;
      }
    }
    return { created };
  }

  followUser(email) {
    const account = this.store.accountByEmail(email);
    return account ? { id: account.id, email: account.email } : null;
  }
}
