import { createCipheriv, createECDH, createHmac, createPrivateKey, createHash, randomBytes, randomUUID, sign } from 'node:crypto';

const b64url = value => Buffer.from(value).toString('base64url');
const fromB64url = value => Buffer.from(String(value || ''), 'base64url');
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(String(value)).digest('hex');

function hmac(key, value) { return createHmac('sha256', key).update(value).digest(); }
function hkdfExpand(prk, info, length) {
  let output = Buffer.alloc(0), previous = Buffer.alloc(0), counter = 1;
  while (output.length < length) {
    previous = hmac(prk, Buffer.concat([previous, Buffer.from(info), Buffer.from([counter++])]));
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

function ensureVapidKeys(store) {
  const envPublic = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const envPrivate = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  if (envPublic && envPrivate) return { publicKey: envPublic, privateKey: envPrivate };
  const storedPublic = store.meta('web_push_vapid_public_key');
  const storedPrivate = store.meta('web_push_vapid_private_key');
  if (storedPublic && storedPrivate) return { publicKey: storedPublic, privateKey: storedPrivate };
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const publicKey = b64url(ecdh.getPublicKey()), privateKey = b64url(ecdh.getPrivateKey());
  store.setMeta('web_push_vapid_public_key', publicKey);
  store.setMeta('web_push_vapid_private_key', privateKey);
  return { publicKey, privateKey };
}

function vapidAuthorization(endpoint, publicKey, privateKey, subject) {
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const publicBytes = fromB64url(publicKey), privateBytes = fromB64url(privateKey);
  const key = createPrivateKey({ key: {
    kty: 'EC', crv: 'P-256',
    x: b64url(publicBytes.subarray(1, 33)), y: b64url(publicBytes.subarray(33, 65)), d: b64url(privateBytes)
  }, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64url(signature)}, k=${publicKey}`;
}

function encryptPayload(subscription, payload) {
  const userPublic = fromB64url(subscription.p256dh), authSecret = fromB64url(subscription.auth);
  if (userPublic.length !== 65 || authSecret.length !== 16) throw Error('推送订阅密钥无效');
  const server = createECDH('prime256v1');
  server.generateKeys();
  const serverPublic = server.getPublicKey();
  const sharedSecret = server.computeSecret(userPublic);
  const authPrk = hmac(authSecret, sharedSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), userPublic, serverPublic]);
  const ikm = hkdfExpand(authPrk, keyInfo, 32);
  const salt = randomBytes(16), prk = hmac(salt, ikm);
  const cek = hkdfExpand(prk, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdfExpand(prk, 'Content-Encoding: nonce\0', 12);
  const plain = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, encrypted]);
}

export async function sendWebPush(subscription, payload, vapid) {
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: vapidAuthorization(subscription.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: payload.urgency || 'normal'
    },
    body: encryptPayload(subscription, payload)
  });
  return { status: response.status, ok: response.ok };
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
    return {
      available: true,
      public_key: this.vapid.publicKey,
      subscriptions: this.store.all('push_subscriptions').filter(row => row.user_id === userId).length
    };
  }

  subscribe(userId, body) {
    const endpoint = String(body.endpoint || '').trim();
    const p256dh = String(body.keys?.p256dh || body.p256dh || '');
    const auth = String(body.keys?.auth || body.auth || '');
    let parsed;
    try { parsed = new URL(endpoint); } catch { throw Object.assign(Error('推送订阅地址无效'), { status: 400 }); }
    if (parsed.protocol !== 'https:' || fromB64url(p256dh).length !== 65 || fromB64url(auth).length !== 16) throw Object.assign(Error('推送订阅信息无效'), { status: 400 });
    const id = hash(endpoint), existing = this.store.all('push_subscriptions').find(row => row.id === id);
    this.store.put('push_subscriptions', { id, user_id: userId, endpoint, p256dh, auth, created_at: existing?.created_at || now(), updated_at: now() });
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
          sent += 1;
        } else if ([404, 410].includes(result.status)) {
          this.store.remove('push_subscriptions', [subscription.id]);
          removed += 1;
        }
      } catch (error) {
        if ([404, 410].includes(error?.statusCode || error?.status)) {
          this.store.remove('push_subscriptions', [subscription.id]);
          removed += 1;
        } else console.error('Web Push request failed:', error.message || error);
      }
    }
    return { sent, removed, subscriptions: subscriptions.length };
  }
}
