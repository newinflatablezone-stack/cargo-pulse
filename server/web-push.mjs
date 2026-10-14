import { createHash, randomUUID } from 'node:crypto';
import webPush from 'web-push';

const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(String(value)).digest('hex');

function ensureVapidKeys(store) {
  const envPublic = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const envPrivate = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
  const storedPublic = store.meta('web_push_vapid_public_key');
  const storedPrivate = store.meta('web_push_vapid_private_key');
  if (storedPublic && storedPrivate) return { publicKey: storedPublic, privateKey: storedPrivate };
  const { publicKey, privateKey } = webPush.generateVAPIDKeys();
  store.setMeta('web_push_vapid_public_key', publicKey);
  store.setMeta('web_push_vapid_private_key', privateKey);
  return { publicKey, privateKey };
}

export async function sendWebPush(subscription, payload, vapid) {
  const request = webPush.sendNotification({
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth }
  }, JSON.stringify(payload), {
    TTL: 86400,
    urgency: payload.urgency || 'normal',
    contentEncoding: 'aes128gcm',
    vapidDetails: vapid,
    timeout: 12_000
  });
  let timer;
  const response = await Promise.race([
    request,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error('推送网关连接超时')), 15_000); })
  ]).finally(() => clearTimeout(timer));
  return { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300 };
}

const eventLabels = {
  assigned: '新工单 / 工单指派', reply: '收到新回复', resolution: '等待确认',
  reopened: '退回处理', due_soon: '即将到期', unresolved: '工单已超期', test: '测试通知'
};

export class WebPushService {
  constructor(store, options = {}) {
    this.store = store;
    const keys = options.keys || ensureVapidKeys(store);
    this.vapid = { ...keys, subject: options.subject || process.env.WEB_PUSH_SUBJECT || 'mailto:505863160@qq.com' };
    this.sender = options.sender || sendWebPush;
    this.pending = new Set();
  }

  status(userId) {
    const subscriptions = this.store.all('push_subscriptions').filter(row => row.user_id === userId);
    const pending = this.store.all('ticket_notifications').filter(row => row.user_id === userId && row.push_pending_at && !row.push_completed_at);
    return {
      available: true,
      public_key: this.vapid.publicKey,
      subscriptions: subscriptions.length,
      healthy_subscriptions: subscriptions.filter(row => !row.last_error).length,
      pending_notifications: pending.length,
      last_success_at: subscriptions.map(row => row.last_success_at).filter(Boolean).sort().at(-1) || null,
      last_error: subscriptions.map(row => row.last_error).filter(Boolean).at(-1) || null
    };
  }

  diagnostics() {
    const subscriptions = this.store.all('push_subscriptions');
    const notifications = this.store.all('ticket_notifications').filter(row => row.push_pending_at);
    const deliveries = this.store.all('push_delivery_logs');
    const statusCounts = {};
    const gatewayCounts = {};
    for (const row of subscriptions) {
      const key = String(row.last_status ?? (row.last_error ? 'error' : 'never'));
      statusCounts[key] = (statusCounts[key] || 0) + 1;
      let gateway = 'invalid';
      try { gateway = new URL(row.endpoint).hostname; } catch {}
      gatewayCounts[gateway] = (gatewayCounts[gateway] || 0) + 1;
    }
    const pending = notifications.filter(row => !row.push_completed_at);
    const workerFailures = pending.filter(row => row.push_worker_error);
    return {
      subscriptions: subscriptions.length,
      healthy_subscriptions: subscriptions.filter(row => !row.last_error).length,
      subscription_statuses: statusCounts,
      subscription_gateways: gatewayCounts,
      in_flight_deliveries: this.pending.size,
      queued_notifications: notifications.length,
      pending_notifications: pending.length,
      pending_never_attempted: pending.filter(row => !Number(row.push_attempts || 0)).length,
      pending_attempted: pending.filter(row => Number(row.push_attempts || 0) > 0).length,
      worker_failures: workerFailures.length,
      last_worker_exit_code: workerFailures.map(row => row.push_worker_exit_code).filter(value => value !== undefined).at(-1) ?? null,
      last_worker_error: workerFailures.map(row => row.push_worker_error).filter(Boolean).at(-1) || null,
      completed_notifications: notifications.filter(row => row.push_completed_at).length,
      delivery_receipts: deliveries.length,
      last_delivery_at: deliveries.map(row => row.created_at).filter(Boolean).sort().at(-1) || null,
      last_attempt_at: notifications.map(row => row.push_last_attempt_at).filter(Boolean).sort().at(-1) || null
    };
  }

  subscribe(userId, body) {
    const endpoint = String(body.endpoint || '').trim();
    const p256dh = String(body.keys?.p256dh || body.p256dh || '');
    const auth = String(body.keys?.auth || body.auth || '');
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw Object.assign(Error('推送订阅地址无效'), { status: 400 }); }
    if (parsed.protocol !== 'https:' || Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(auth, 'base64url').length !== 16) throw Object.assign(Error('推送订阅信息无效'), { status: 400 });
    const id = hash(endpoint), existing = this.store.all('push_subscriptions').find(row => row.id === id);
    this.store.put('push_subscriptions', { id, user_id: userId, endpoint, p256dh, auth, created_at: existing?.created_at || now(), updated_at: now(), last_error: null, last_status: null });
    return this.status(userId);
  }

  unsubscribe(userId, endpoint) {
    const row = this.store.all('push_subscriptions').find(item => item.endpoint === endpoint && item.user_id === userId);
    if (row) this.store.remove('push_subscriptions', [row.id]);
    return this.status(userId);
  }

  queueTicketNotification(notification, tickets) {
    // Never let a push provider or a concurrent SQLite write terminate the
    // core data process. Push is retried from the durable notification row;
    // orders, login and tickets must stay available even when delivery fails.
    const task = (async () => {
      let result;
      try { result = await this.sendTicketNotification(notification, tickets); }
      catch (error) {
        result = {
          sent: 0, delivered: 0, pending: 1,
          error: String(error?.body || error?.message || error).slice(0, 500)
        };
      }
      try { return this.recordTicketDelivery(notification, result); }
      catch (error) {
        console.error('Web Push delivery state could not be saved:', String(error?.message || error));
        return result;
      }
    })();
    this.pending.add(task);
    // Supplying both handlers prevents the Promise returned by finally() from
    // becoming an unhandled rejection under Node's strict default behavior.
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task));
    return task;
  }

  async flush() { await Promise.all([...this.pending]); }

  async sendTicketNotification(notification, tickets) {
    const ticket = tickets.ticket(notification.ticket_id);
    if (!ticket) return { sent: 0 };
    let actor;
    try { actor = tickets.actor(notification.user_id); } catch { return { sent: 0 }; }
    if (!tickets.canView(ticket, actor)) return { sent: 0 };
    const eventType = eventLabels[notification.type] || '工单更新';
    return this.deliver(notification.user_id, {
      title: `${ticket.ticket_no} · ${eventType}`,
      body: ticket.title,
      event_type: eventType,
      ticket_no: ticket.ticket_no,
      ticket_title: ticket.title,
      url: `/?resource=tickets&ticket=${encodeURIComponent(ticket.id)}`,
      tag: `ticket-${ticket.id}-${notification.type}`,
      urgency: ticket.priority === 'urgent' ? 'high' : 'normal'
    }, notification.id);
  }

  recordTicketDelivery(notification, result) {
    const current = this.store.all('ticket_notifications').find(row => row.id === notification.id);
    if (!current) return result;
    const stamp = now(), attempts = Number(current.push_attempts || 0) + 1;
    const completed = Number(result.delivered || result.sent || 0) > 0 && Number(result.pending || 0) === 0;
    const delays = [30, 120, 300, 900, 1800];
    const retrySeconds = delays[Math.min(attempts - 1, delays.length - 1)];
    this.store.put('ticket_notifications', {
      ...current,
      push_attempts: attempts,
      push_last_attempt_at: stamp,
      push_completed_at: completed ? stamp : null,
      push_next_attempt_at: completed ? null : new Date(Date.now() + retrySeconds * 1000).toISOString(),
      push_last_error: result.error || (completed ? null : '没有可确认送达的浏览器订阅')
    });
    if (result.error) console.error('Web Push delivery failed:', result.error);
    return result;
  }

  async retryPendingTicketNotifications(tickets, { userId = null, limit = 50, at = Date.now() } = {}) {
    const rows = this.store.all('ticket_notifications')
      .filter(row => row.push_pending_at && !row.push_completed_at && (!userId || row.user_id === userId))
      .filter(row => !row.push_next_attempt_at || new Date(row.push_next_attempt_at).getTime() <= at)
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
      .slice(0, limit);
    const results = [];
    for (const notification of rows) results.push(await this.queueTicketNotification(notification, tickets));
    return { attempted: rows.length, sent: results.reduce((sum, row) => sum + Number(row?.sent || 0), 0) };
  }

  async test(userId, endpoint = '') {
    return this.deliver(userId, {
      title: 'Cargo Pulse · 测试通知', body: '桌面通知已成功开启', event_type: '测试通知',
      url: '/?resource=tickets', tag: `ticket-push-test-${Date.now()}`
    }, `test:${randomUUID()}`, endpoint);
  }

  async deliver(userId, payload, dedupeKey, endpoint = '') {
    let sent = 0, removed = 0, failed = 0, delivered = 0;
    const subscriptions = this.store.all('push_subscriptions').filter(row => row.user_id === userId && (!endpoint || row.endpoint === endpoint));
    for (const subscription of subscriptions) {
      const deliveryId = hash(`${dedupeKey}:${subscription.id}`);
      if (this.store.all('push_delivery_logs').some(row => row.id === deliveryId)) { delivered += 1; continue; }
      try {
        const result = await this.sender(subscription, payload, this.vapid);
        if (result.ok || [201, 202].includes(result.status)) {
          this.store.put('push_delivery_logs', { id: deliveryId, user_id: userId, subscription_id: subscription.id, dedupe_key: dedupeKey, created_at: now() });
          this.store.put('push_subscriptions', { ...subscription, last_success_at: now(), last_error: null, last_status: result.status, updated_at: now() });
          sent += 1;
          delivered += 1;
        } else if ([404, 410].includes(result.status)) {
          this.store.remove('push_subscriptions', [subscription.id]);
          removed += 1;
        } else failed += 1;
      } catch (error) {
        if ([404, 410].includes(error?.statusCode || error?.status)) {
          this.store.remove('push_subscriptions', [subscription.id]);
          removed += 1;
        } else {
          const message = String(error?.body || error?.message || error).slice(0, 500);
          this.store.put('push_subscriptions', { ...subscription, last_error: message, last_status: error?.statusCode || error?.status || null, updated_at: now() });
          console.error('Web Push request failed:', message);
          failed += 1;
        }
      }
    }
    return { sent, delivered, removed, failed, pending: failed, subscriptions: subscriptions.length };
  }
}
