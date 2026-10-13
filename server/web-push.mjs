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
  const response = await webPush.sendNotification({
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth }
  }, JSON.stringify(payload), {
    TTL: 86400,
    urgency: payload.urgency || 'normal',
    contentEncoding: 'aes128gcm',
    vapidDetails: vapid
  });
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
    return {
      available: true,
      public_key: this.vapid.publicKey,
      subscriptions: subscriptions.length,
      healthy_subscriptions: subscriptions.filter(row => !row.last_error).length
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
    const task = this.sendTicketNotification(notification, tickets).catch(error => console.error('Web Push delivery failed:', error));
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
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

  async test(userId) {
    return this.deliver(userId, {
      title: 'Cargo Pulse · 测试通知', body: '桌面通知已成功开启', event_type: '测试通知',
      url: '/?resource=tickets', tag: `ticket-push-test-${Date.now()}`
    }, `test:${randomUUID()}`);
  }

  async deliver(userId, payload, dedupeKey) {
    let sent = 0, removed = 0;
    const subscriptions = this.store.all('push_subscriptions').filter(row => row.user_id === userId);
    for (const subscription of subscriptions) {
      const deliveryId = hash(`${dedupeKey}:${subscription.id}`);
      if (this.store.all('push_delivery_logs').some(row => row.id === deliveryId)) continue;
      try {
        const result = await this.sender(subscription, payload, this.vapid);
        if (result.ok || [201, 202].includes(result.status)) {
          this.store.put('push_delivery_logs', { id: deliveryId, user_id: userId, subscription_id: subscription.id, dedupe_key: dedupeKey, created_at: now() });
          this.store.put('push_subscriptions', { ...subscription, last_success_at: now(), last_error: null, last_status: result.status, updated_at: now() });
          sent += 1;
        } else if ([404, 410].includes(result.status)) {
          this.store.remove('push_subscriptions', [subscription.id]);
          removed += 1;
        }
      } catch (error) {
        if ([404, 410].includes(error?.statusCode || error?.status)) {
          this.store.remove('push_subscriptions', [subscription.id]);
          removed += 1;
        } else {
          const message = String(error?.body || error?.message || error).slice(0, 500);
          this.store.put('push_subscriptions', { ...subscription, last_error: message, last_status: error?.statusCode || error?.status || null, updated_at: now() });
          console.error('Web Push request failed:', message);
        }
      }
    }
    return { sent, removed, subscriptions: subscriptions.length };
  }
}
