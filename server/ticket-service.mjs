import { randomUUID } from 'node:crypto';

export const SUPERVISOR_EMAIL = '505863160@qq.com';
export const TICKET_FOLLOWERS = new Map([
  ['2548462886@qq.com', 'ICEY'],
  ['1544264271@qq.com', '秦枝']
]);
export const TICKET_BUSINESS_NAMES = new Map([
  ['sales@inflatable-zone.com', 'Ella'],
  ['sherry@inflatable-zone.com', 'Sherry'],
  ['demi@inflatable-zone.com', 'Demi'],
  ['rayna@inflatable-zone.com', 'Rayna']
]);
export const TICKET_TABLES = [
  'tickets', 'ticket_messages', 'ticket_attachments', 'ticket_history',
  'ticket_notifications', 'ticket_reminder_logs', 'push_subscriptions', 'push_delivery_logs'
];

const now = () => new Date().toISOString();
const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
const emailOf = value => String(value || '').trim().toLowerCase();
const displayName = (email, fallback = '') => {
  const normalized = emailOf(email);
  return TICKET_FOLLOWERS.get(normalized) || TICKET_BUSINESS_NAMES.get(normalized) || fallback || normalized;
};
const priorityRank = { urgent: 0, important: 1, normal: 2 };
const reminderHours = { urgent: 3, important: 6, normal: 9 };
const activeStatuses = new Set(['pending', 'in_progress']);
const unresolvedStatuses = new Set(['pending', 'in_progress', 'waiting_confirmation']);

export class TicketService {
  constructor(store) { this.store = store; this.notificationHandler = null; }
  setNotificationHandler(handler) { this.notificationHandler = handler; return this; }

  actor(userId) {
    const account = this.store.accountById(userId);
    const profile = this.store.profile(userId);
    if (!account || !profile) fail('登录已失效', 401);
    const email = emailOf(account.email);
    return {
      id: userId,
      email,
      role: email === SUPERVISOR_EMAIL ? 'supervisor' : TICKET_FOLLOWERS.has(email) ? 'follower' : profile.role,
      name: email === SUPERVISOR_EMAIL ? '主管' : displayName(email, profile.name)
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

  responseStats(ticket, messages = this.store.all('ticket_messages')) {
    const rows = messages.filter(row => row.ticket_id === ticket.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const durations = [];
    let waitingAt = null;
    for (const row of rows) {
      const moment = new Date(row.created_at).getTime();
      if (!Number.isFinite(moment)) continue;
      if (row.author_id === ticket.created_by) {
        if (waitingAt === null) waitingAt = moment;
      } else if (waitingAt !== null && ['message', 'progress', 'resolution'].includes(row.kind)) {
        durations.push(Math.max(0, moment - waitingAt));
        waitingAt = null;
      }
    }
    return {
      average_response_seconds: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length / 1000) : null,
      response_count: durations.length
    };
  }

  enrichTicket(ticket, messages, at = Date.now()) {
    const intervalHours = reminderHours[ticket.priority] || reminderHours.normal;
    const activityAt = new Date(ticket.updated_at || ticket.created_at).getTime();
    const elapsed = Number.isFinite(activityAt) ? at - activityAt : 0;
    const isOverdue = unresolvedStatuses.has(ticket.status) && elapsed >= intervalHours * 3600000;
    return {
      ...ticket,
      creator_name: displayName(ticket.creator_email, ticket.creator_name),
      assignee_name: displayName(ticket.assignee_email, ticket.assignee_name),
      ...this.responseStats(ticket, messages),
      reminder_interval_hours: intervalHours,
      is_overdue: isOverdue,
      overdue_seconds: isOverdue ? Math.floor((elapsed - intervalHours * 3600000) / 1000) : 0
    };
  }

  visibleTickets(actor) {
    const messages = this.store.all('ticket_messages');
    return this.store.all('tickets').filter(ticket => !ticket.archived_at && this.canView(ticket, actor)).map(ticket => this.enrichTicket(ticket, messages)).sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  badge(userId) {
    return new Set(this.unreadNotifications(userId).map(row => row.ticket_id).filter(Boolean)).size;
  }

  unreadNotifications(userId) {
    const actor = this.actor(userId);
    return this.store.all('ticket_notifications')
      .filter(row => row.user_id === actor.id && !row.read_at)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  homeReminder(userId) {
    const notifications = this.unreadNotifications(userId);
    const ticketIds = new Set(notifications.map(row => row.ticket_id).filter(Boolean));
    return { count: ticketIds.size, notifications: notifications.slice(0, 20) };
  }

  notificationSnapshot(userId) {
    const unread = this.unreadNotifications(userId);
    return {
      badge_count: new Set(unread.map(row => row.ticket_id).filter(Boolean)).size,
      notifications: unread.slice(0, 20)
    };
  }

  bootstrap(userId) {
    const actor = this.actor(userId);
    const notifications = this.unreadNotifications(userId);
    return {
      actor,
      followers: this.followers(),
      // Keep this shape temporarily so a browser with the previous cached UI
      // cannot crash while the new deadline-free bundle is being picked up.
      settings: { ...reminderHours },
      tickets: this.visibleTickets(actor),
      notifications,
      badge_count: new Set(notifications.map(row => row.ticket_id).filter(Boolean)).size
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
    const notification = this.store.put('ticket_notifications', { id: randomUUID(), user_id: userId, ticket_id: ticketId, type, title, dedupe_key: dedupeKey || null, read_at: null, created_at: now() });
    if (this.notificationHandler) {
      try {
        this.notificationHandler(notification);
      } catch (error) {
        console.error('Ticket notification handler failed:', error);
      }
    }
    return notification;
  }

  markTicketNotificationsRead(ticketId, userId) {
    const stamp = now();
    for (const row of this.store.all('ticket_notifications').filter(item => item.ticket_id === ticketId && item.user_id === userId && !item.read_at)) {
      this.store.put('ticket_notifications', { ...row, read_at: stamp });
    }
  }

  create(body, userId) {
    const actor = this.actor(userId);
    if (actor.role !== 'business' && !this.isSupervisor(actor)) fail('只有业务员或主管可以创建工单', 403);
    const description = String(body.description || '').trim();
    if (!description) fail('请填写问题描述');
    const title = (String(body.title || '').trim() || description.split(/\r?\n/).find(line => line.trim())?.trim() || '问题跟进').slice(0, 160);
    const category = body.category || 'other';
    if (!['production', 'logistics', 'delivery', 'after_sales', 'other'].includes(category)) fail('问题分类无效');
    if (!['normal', 'important', 'urgent'].includes(body.priority)) fail('优先级无效');
    const follower = this.followers().find(item => item.id === body.assignee_id && item.id);
    if (!follower) fail('请选择 ICEY 或秦枝作为负责人');
    const stamp = now();
    const ticket = this.store.put('tickets', {
      id: randomUUID(), ticket_no: this.nextNumber(), title, description,
      order_no: null, category, priority: body.priority,
      status: 'pending', created_by: actor.id, creator_email: actor.email, creator_name: actor.name,
      assignee_id: follower.id, assignee_email: follower.email, assignee_name: follower.name,
      first_deadline: null, current_deadline: null, accepted_at: null, resolved_at: null,
      closed_at: null, archived_at: null, created_at: stamp, updated_at: stamp
    });
    this.store.put('ticket_messages', { id: randomUUID(), ticket_id: ticket.id, kind: 'created', text: description, author_id: actor.id, author_email: actor.email, author_name: actor.name, created_at: stamp });
    this.history(ticket.id, actor, 'created', { priority: ticket.priority, assignee_email: follower.email });
    this.notify(follower.id, ticket.id, 'assigned', `新工单 ${ticket.ticket_no} 已分配给你`, `assigned:${ticket.id}:${follower.id}`);
    return ticket;
  }

  detail(ticketId, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(ticketId, actor);
    // Opening the ticket is the read receipt. Resolution/reminder state is
    // independent and can create a new notification later when required.
    this.markTicketNotificationsRead(ticket.id, actor.id);
    const messages = this.store.all('ticket_messages').filter(row => row.ticket_id === ticket.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(row => ({ ...row, author_name: displayName(row.author_email, row.author_name) }));
    return {
      ticket: this.enrichTicket(ticket, messages),
      messages,
      attachments: this.store.all('ticket_attachments').filter(row => row.ticket_id === ticket.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(row => ({ ...row, uploader_name: displayName(row.uploader_email, row.uploader_name) })),
      history: this.store.all('ticket_history').filter(row => row.ticket_id === ticket.id).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(row => ({ ...row, actor_name: displayName(row.actor_email, row.actor_name) }))
    };
  }

  accept(ticketId, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(ticketId, actor);
    this.requireAssignee(ticket, actor);
    if (ticket.status !== 'pending') fail('只有待处理工单可以接手', 409);
    const updated = this.store.put('tickets', { ...ticket, status: 'in_progress', accepted_at: now(), updated_at: now() });
    this.markTicketNotificationsRead(ticket.id, actor.id);
    this.history(ticket.id, actor, 'status_changed', { from: 'pending', to: 'in_progress' });
    return updated;
  }

  reply(body, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(body.ticket_id, actor);
    const kind = body.kind || 'message', text = String(body.text || '').trim();
    if (!text) fail('请填写回复内容');
    if (ticket.status === 'closed') fail('已关闭工单不能继续回复', 409);
    if (!['message', 'progress', 'resolution'].includes(kind)) fail('回复类型无效');
    const processorReply = ticket.assignee_id === actor.id || this.isSupervisor(actor);
    const creatorReply = ticket.created_by === actor.id;
    if (!processorReply && !creatorReply) fail('没有回复该工单的权限', 403);
    if (processorReply && kind === 'message') fail('请选择“继续处理”或“已处理，提交确认”');
    if (!processorReply && kind !== 'message') fail('业务员只能补充消息');
    if (ticket.status === 'waiting_confirmation' && kind === 'message') fail('请确认已解决或退回处理', 409);
    if (kind !== 'message') this.requireAssignee(ticket, actor);
    let updated = ticket;
    if (kind === 'progress') {
      if (!activeStatuses.has(updated.status)) fail('当前状态不能提交进展', 409);
      const previousStatus = updated.status;
      updated = this.store.put('tickets', { ...updated, status: 'in_progress', accepted_at: updated.accepted_at || now(), updated_at: now() });
      if (previousStatus !== 'in_progress') this.history(ticket.id, actor, 'status_changed', { from: previousStatus, to: 'in_progress' });
      this.history(ticket.id, actor, 'progress_updated');
    } else if (kind === 'resolution') {
      if (!activeStatuses.has(updated.status)) fail('当前状态不能提交解决结果', 409);
      const previousStatus = updated.status;
      updated = this.store.put('tickets', { ...updated, status: 'waiting_confirmation', current_deadline: null, resolved_at: now(), updated_at: now() });
      this.history(ticket.id, actor, 'status_changed', { from: previousStatus, to: 'waiting_confirmation' });
      this.notify(ticket.created_by, ticket.id, 'resolution', `${ticket.ticket_no} 已提交解决结果，等待你的确认`, `resolution:${ticket.id}:${updated.resolved_at}`);
    }
    const message = this.store.put('ticket_messages', { id: randomUUID(), ticket_id: ticket.id, kind, text, next_deadline: null, author_id: actor.id, author_email: actor.email, author_name: actor.name, created_at: now() });
    if (kind === 'message') updated = this.store.put('tickets', { ...updated, updated_at: now() });
    if (kind !== 'resolution') {
      const recipient = actor.id === ticket.created_by ? ticket.assignee_id : processorReply ? ticket.created_by : null;
      if (recipient && recipient !== actor.id) {
        const action = kind === 'progress' ? '更新了处理进展' : '发送了新消息';
        this.notify(recipient, ticket.id, 'reply', `${ticket.ticket_no} ${actor.name || actor.email} ${action}`, `reply:${message.id}`);
      }
    }
    this.markTicketNotificationsRead(ticket.id, actor.id);
    return { ticket: updated, message };
  }

  deleteMessage(messageId, userId) {
    const actor = this.actor(userId);
    if (!this.isSupervisor(actor)) fail('仅管理员可以删除聊天记录', 403);
    const message = this.store.all('ticket_messages').find(row => row.id === messageId);
    if (!message) fail('聊天记录不存在', 404);
    const ticket = this.requireTicket(message.ticket_id, actor);
    if (message.kind === 'created') fail('工单原始问题不能作为聊天删除', 409);
    const attachmentIds = this.store.all('ticket_attachments').filter(row => row.message_id === message.id).map(row => row.id);
    if (attachmentIds.length) this.store.remove('ticket_attachments', attachmentIds);
    this.store.remove('ticket_messages', [message.id]);
    this.history(ticket.id, actor, 'message_deleted', { message_id: message.id, kind: message.kind, author_email: message.author_email });
    return { ok: true, ticket_id: ticket.id };
  }

  deleteTicket(ticketId, userId) {
    const actor = this.actor(userId);
    if (!this.isSupervisor(actor)) fail('仅管理员可以删除工单', 403);
    const ticket = this.requireTicket(ticketId, actor);
    const attachments = this.store.all('ticket_attachments').filter(row => row.ticket_id === ticket.id);
    for (const table of ['ticket_messages', 'ticket_attachments', 'ticket_history', 'ticket_notifications', 'ticket_reminder_logs', 'push_delivery_logs']) {
      const ids = this.store.all(table).filter(row => row.ticket_id === ticket.id).map(row => row.id);
      if (ids.length) this.store.remove(table, ids);
    }
    this.store.remove('tickets', [ticket.id]);
    return { ok: true, ticket_id: ticket.id, object_paths: attachments.map(row => row.object_path).filter(Boolean) };
  }

  decide(body, userId) {
    const actor = this.actor(userId), ticket = this.requireTicket(body.ticket_id, actor);
    if (ticket.created_by !== actor.id && !this.isSupervisor(actor)) fail('只有提交人可以确认处理结果', 403);
    if (ticket.status !== 'waiting_confirmation') fail('当前工单不在待确认状态', 409);
    if (body.action === 'close') {
      const updated = this.store.put('tickets', { ...ticket, status: 'closed', closed_at: now(), updated_at: now() });
      this.markTicketNotificationsRead(ticket.id, actor.id);
      this.history(ticket.id, actor, 'status_changed', { from: 'waiting_confirmation', to: 'closed' });
      return updated;
    }
    if (body.action === 'reopen') {
      const reason = String(body.reason || '').trim();
      if (!reason) fail('请填写退回原因');
      const stamp = now();
      const updated = this.store.put('tickets', { ...ticket, status: 'in_progress', current_deadline: null, resolved_at: null, closed_at: null, updated_at: stamp });
      this.store.put('ticket_messages', { id: randomUUID(), ticket_id: ticket.id, kind: 'reopened', text: reason, next_deadline: null, author_id: actor.id, author_email: actor.email, author_name: actor.name, created_at: stamp });
      this.markTicketNotificationsRead(ticket.id, actor.id);
      this.history(ticket.id, actor, 'reopened', { reason });
      this.notify(ticket.assignee_id, ticket.id, 'reopened', `${ticket.ticket_no} 已被业务员退回处理`, `reopened:${ticket.id}:${stamp}`);
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
      this.markTicketNotificationsRead(ticket.id, ticket.assignee_id);
      this.notify(follower.id, ticket.id, 'assigned', `${ticket.ticket_no} 已转交给你`, `transferred:${ticket.id}:${follower.id}:${Date.now()}`);
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
    let created = 0;
    for (const ticket of this.store.all('tickets').filter(row => !row.archived_at && unresolvedStatuses.has(row.status))) {
      const activityAt = new Date(ticket.updated_at || ticket.created_at).getTime();
      if (!Number.isFinite(activityAt)) continue;
      const elapsed = at - activityAt;
      const intervalHours = reminderHours[ticket.priority] || reminderHours.normal;
      const intervalMs = intervalHours * 3600000;
      const recipient = ticket.status === 'waiting_confirmation' ? ticket.created_by : ticket.assignee_id;
      if (elapsed >= intervalMs - 3600000 && elapsed < intervalMs) {
        const action = ticket.status === 'waiting_confirmation' ? '即将到期，请确认是否已解决' : '即将到期，请及时处理';
        if (this.notify(recipient, ticket.id, 'due_soon', `${ticket.ticket_no} ${action}`, `due-soon:${ticket.id}:${recipient}:${ticket.updated_at || ticket.created_at}:${intervalHours}`)) created += 1;
        continue;
      }
      if (elapsed < intervalMs) continue;
      const bucket = Math.floor(elapsed / intervalMs);
      const action = ticket.status === 'waiting_confirmation' ? '等待你确认是否已解决' : '仍未解决，请及时处理';
      if (this.notify(recipient, ticket.id, 'unresolved', `${ticket.ticket_no} ${action}`, `unresolved:${ticket.id}:${recipient}:${ticket.updated_at || ticket.created_at}:${intervalHours}:${bucket}`)) created += 1;
    }
    return { created };
  }

  followUser(email) {
    const account = this.store.accountByEmail(email);
    return account ? { id: account.id, email: account.email } : null;
  }
}
