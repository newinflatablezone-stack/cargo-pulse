import http from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { TencentDataStore, TABLES, isPublicRequest, lookupCustomerTracking } from './tencent-data-core.mjs';

let TicketService;
try { ({ TicketService } = await import('./ticket-service.mjs')); }
catch (localModuleError) {
  try { ({ TicketService } = await import('file:///var/www/cargo-pulse/runtime/ticket-service.mjs')); }
  catch { throw localModuleError; }
}

const PORT = Number(process.env.PORT || 8788);
const DATA_DIR = process.env.CARGO_PULSE_DATA_DIR || '/var/lib/cargo-pulse/data';
const DB_FILE = process.env.CARGO_PULSE_DB || join(DATA_DIR, 'cargo-pulse.sqlite');
const UPLOAD_DIR = process.env.CARGO_PULSE_ORDER_UPLOADS || '/var/lib/cargo-pulse/uploads/orders';
const IMPORT_SECRET = process.env.CARGO_PULSE_IMPORT_SECRET || '';
const LEGACY_URL = String(process.env.LEGACY_SUPABASE_URL || '').replace(/\/$/, '');
const LEGACY_KEY = process.env.LEGACY_SUPABASE_KEY || '';
await mkdir(DATA_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });
const store = new TencentDataStore(DB_FILE);
const ensureInvite = key => {
  const existing = store.all('app_settings').find(row => row.key === key);
  if (existing?.value) return existing.value;
  const value = randomUUID().replaceAll('-', '');
  store.put('app_settings', { key, value, created_at: new Date().toISOString() });
  return value;
};
ensureInvite('business_invite');
ensureInvite('follower_invite');
const DATA_REVISION = createHash('sha256').update(await readFile(new URL('./tencent-data-core.mjs', import.meta.url))).digest('hex');
const tickets = new TicketService(store);
let push = null;
let pushInitError = null;
try {
  let WebPushService;
  try { ({ WebPushService } = await import('./web-push.mjs')); }
  catch { ({ WebPushService } = await import('file:///var/www/cargo-pulse/runtime/web-push.mjs')); }
  push = new WebPushService(store);
  tickets.setNotificationHandler(notification => push.queueTicketNotification(notification, tickets));
} catch (caught) {
  // Web Push is an optional delivery channel. A crypto/runtime/configuration
  // problem must never take down authentication, orders, or the ticket API.
  pushInitError = caught;
  console.error('Web Push disabled; core data service remains available:', caught);
}
const pushStatus = userId => push
  ? push.status(userId)
  : { available: false, public_key: null, subscriptions: 0 };
const requirePush = () => {
  if (!push) throw Object.assign(Error('桌面通知服务暂不可用'), { status: 503, cause: pushInitError });
  return push;
};

const send = (res, status, value, headers = {}) => {
  const body = value == null ? '' : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cargo-Pulse-Data-Revision': DATA_REVISION, ...headers });
  res.end(body);
};
const error = (res, caught) => send(res, caught.status || 500, { message: caught.message || '服务器错误' });
const bearer = req => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const readBody = async (req, max = 25 * 1024 * 1024) => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(Error('请求内容过大'), { status: 413 }); chunks.push(chunk); }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) return {};
  return String(req.headers['content-type'] || '').includes('application/json') ? JSON.parse(buffer.toString('utf8')) : buffer;
};
const requireUser = req => {
  const user = store.session(bearer(req));
  if (!user) throw Object.assign(Error('登录已失效'), { status: 401 });
  return user;
};
const safeUploadPath = (raw, root = UPLOAD_DIR) => {
  const cleaned = normalize('/' + decodeURIComponent(raw)).replace(/^[/\\]+/, '');
  if (cleaned.includes('..')) throw Object.assign(Error('非法文件路径'), { status: 400 });
  return join(root, cleaned);
};
const objectSignature = (raw, expires) => createHmac('sha256', IMPORT_SECRET).update(`${raw}\n${expires}`).digest('base64url');

async function authRoute(req, res, url) {
  if (url.pathname.endsWith('/user') && req.method === 'GET') {
    const user = requireUser(req);
    return send(res, 200, { id: user.id, email: user.email });
  }
  const body = await readBody(req);
  if (url.pathname.endsWith('/signup')) {
    if (!body.email || String(body.password || '').length < 6) throw Object.assign(Error('邮箱或密码不符合要求'), { status: 400 });
    if (store.accountByEmail(body.email)) throw Object.assign(Error('账号已经存在'), { status: 409 });
    const requestedRole = body.data?.registration_role === 'follower' || !body.data?.registration_role && body.data?.follower_invite ? 'follower' : 'business';
    const suppliedInvite = String(body.data?.registration_invite || body.data?.follower_invite || '');
    const setting = store.all('app_settings').find(row => row.key === `${requestedRole}_invite`);
    if (!suppliedInvite || suppliedInvite !== setting?.value) throw Object.assign(Error('注册链接无效，请联系主管获取最新邀请链接'), { status: 403 });
    const role = requestedRole;
    const user = store.upsertAccount({ email: body.email, password: body.password, role });
    return send(res, 200, store.issueSession(user));
  }
  if (url.searchParams.get('grant_type') === 'password') {
    let session = store.login(body.email, body.password);
    if (!session && LEGACY_URL && LEGACY_KEY) {
      const response = await fetch(`${LEGACY_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: LEGACY_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: body.email, password: body.password }) });
      const legacy = await response.json().catch(() => ({}));
      if (response.ok && legacy.user?.id) {
        const profileResponse = await fetch(`${LEGACY_URL}/rest/v1/profiles?id=eq.${legacy.user.id}&select=*`, { headers: { apikey: LEGACY_KEY, Authorization: `Bearer ${legacy.access_token}` } });
        const [profile] = await profileResponse.json().catch(() => []);
        const user = store.upsertAccount({ id: legacy.user.id, email: legacy.user.email, password: body.password, role: profile?.role || 'business' });
        session = store.issueSession(user);
      }
    }
    if (!session) throw Object.assign(Error('邮箱或密码错误'), { status: 400 });
    return send(res, 200, session);
  }
  if (url.searchParams.get('grant_type') === 'refresh_token') {
    let session = store.refresh(body.refresh_token);
    if (!session && LEGACY_URL && LEGACY_KEY) {
      const response = await fetch(`${LEGACY_URL}/auth/v1/token?grant_type=refresh_token`, { method: 'POST', headers: { apikey: LEGACY_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: body.refresh_token }) });
      const legacy = await response.json().catch(() => ({}));
      if (response.ok && legacy.user?.id) {
        const profileResponse = await fetch(`${LEGACY_URL}/rest/v1/profiles?id=eq.${legacy.user.id}&select=*`, { headers: { apikey: LEGACY_KEY, Authorization: `Bearer ${legacy.access_token}` } });
        const [profile] = await profileResponse.json().catch(() => []);
        const user = store.upsertAccount({ id: legacy.user.id, email: legacy.user.email, role: profile?.role || 'business' });
        session = store.issueSession(user);
      }
    }
    if (!session) throw Object.assign(Error('登录已失效'), { status: 401 });
    return send(res, 200, session);
  }
  throw Object.assign(Error('不支持的登录操作'), { status: 404 });
}

async function rpc(req, res, name, body, user) {
  if (name === 'push_health') return send(res, 200, {
    ok: true,
    web_push: Boolean(push),
    error: pushInitError ? String(pushInitError.message || pushInitError).slice(0, 300) : null
  });
  if (name === 'ticket_bootstrap') return send(res, 200, { ...tickets.bootstrap(user.id), push: pushStatus(user.id) });
  if (name === 'ticket_detail') return send(res, 200, tickets.detail(body.ticket_id, user.id));
  if (name === 'ticket_create') return send(res, 200, tickets.create(body, user.id));
  if (name === 'ticket_accept') return send(res, 200, tickets.accept(body.ticket_id, user.id));
  if (name === 'ticket_reply') return send(res, 200, tickets.reply(body, user.id));
  if (name === 'ticket_message_delete') return send(res, 200, tickets.deleteMessage(body.message_id, user.id));
  if (name === 'ticket_delete') {
    const result = tickets.deleteTicket(body.ticket_id, user.id);
    await Promise.all(result.object_paths.map(path => unlink(safeUploadPath(path, join(UPLOAD_DIR, 'tickets'))).catch(() => {})));
    return send(res, 200, { ok: true, ticket_id: result.ticket_id });
  }
  if (name === 'ticket_decide') return send(res, 200, tickets.decide(body, user.id));
  if (name === 'ticket_admin_update') return send(res, 200, tickets.adminUpdate(body, user.id));
  if (name === 'ticket_archive') return send(res, 200, tickets.archive(body.ticket_id, user.id));
  if (name === 'ticket_notifications_read') return send(res, 200, tickets.markNotificationsRead(user.id));
  if (name === 'ticket_notification_snapshot') return send(res, 200, tickets.notificationSnapshot(user.id));
  if (name === 'ticket_push_subscribe') return send(res, 200, requirePush().subscribe(user.id, body.subscription || body));
  if (name === 'ticket_push_unsubscribe') return send(res, 200, requirePush().unsubscribe(user.id, body.endpoint));
  if (name === 'ticket_push_test') return send(res, 200, await requirePush().test(user.id));
  if (name === 'ticket_register_attachment') return send(res, 200, tickets.registerAttachment(body, user.id));
  if (name === 'lookup_customer_tracking') {
    return send(res, 200, lookupCustomerTracking(store, body.p_email));
  }
  if (!user) throw Object.assign(Error('请先登录'), { status: 401 });
  if (name === 'home_bootstrap') {
    const ticketReminder = tickets.homeReminder(user.id);
    return send(res, 200, {
      ...store.homeSnapshot(user.id),
      ticket_badge_count: ticketReminder.count,
      ticket_notifications: ticketReminder.notifications
    });
  }
  if (name === 'home_core') {
    const ticketReminder = tickets.homeReminder(user.id);
    return send(res, 200, {
      ...store.homeCoreSnapshot(user.id),
      ticket_badge_count: ticketReminder.count,
      ticket_notifications: ticketReminder.notifications
    });
  }
  if (name === 'home_relations') return send(res, 200, store.homeRelationsSnapshot());
  if (name === 'list_visible_orders') return send(res, 200, store.all('orders').filter(row => !row.deleted_at || store.isSupervisor(user.id)));
  if (name === 'impersonate_user') {
    if (!store.isSupervisor(user.id)) throw Object.assign(Error('仅主管可以切换账号'), { status: 403 });
    const targetProfile = store.profile(body.target_user_id);
    const targetAccount = targetProfile && store.accountById(targetProfile.id);
    if (!targetAccount) throw Object.assign(Error('用户不存在'), { status: 404 });
    if (!store.isUserActive(targetProfile.id)) throw Object.assign(Error('停用账号不能登录'), { status: 400 });
    if (targetProfile.id === user.id) throw Object.assign(Error('当前已经是主管账号'), { status: 400 });
    return send(res, 200, { ...store.issueSession(targetAccount), impersonated_by: { id: user.id, email: user.email } });
  }
  if (!store.isFollower(user.id)) throw Object.assign(Error('没有操作权限'), { status: 403 });
  const order = store.all('orders').find(row => row.id === body.target_order_id);
  if (['soft_delete_order', 'restore_deleted_order', 'permanently_delete_order'].includes(name) && !order) throw Object.assign(Error('订单不存在'), { status: 404 });
  if (name === 'soft_delete_order') store.put('orders', { ...order, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  else if (name === 'restore_deleted_order') {
    if (!store.isSupervisor(user.id)) throw Object.assign(Error('仅主管可以恢复订单'), { status: 403 });
    store.put('orders', { ...order, deleted_at: null, updated_at: new Date().toISOString() });
  } else if (name === 'permanently_delete_order') {
    if (!store.isSupervisor(user.id)) throw Object.assign(Error('仅主管可以永久删除订单'), { status: 403 });
    for (const table of ['order_events', 'order_images', 'order_factories', 'order_shipments']) {
      const ids = store.all(table).filter(row => row.order_id === order.id).map(row => row.id);
      store.remove(table, ids);
    }
    store.remove('orders', [order.id]);
  } else if (name === 'set_user_role') {
    if (!store.isSupervisor(user.id)) throw Object.assign(Error('仅主管可以分配角色'), { status: 403 });
    const profile = store.profile(body.target_user_id); if (!profile) throw Object.assign(Error('用户不存在'), { status: 404 });
    store.put('profiles', { ...profile, role: body.target_role });
  } else if (name === 'set_user_active') {
    if (!store.isSupervisor(user.id)) throw Object.assign(Error('仅主管可以停用账号'), { status: 403 });
    const target = store.profile(body.target_user_id); if (!target) throw Object.assign(Error('用户不存在'), { status: 404 });
    const protectedEmails = new Set(['505863160@qq.com', '2548462886@qq.com', '1544264271@qq.com']);
    if (protectedEmails.has(String(target.email || '').toLowerCase())) throw Object.assign(Error('主管和指定跟单账号不能停用'), { status: 400 });
    store.setUserActive(target.id, Boolean(body.active));
  } else if (name === 'transition_order_stage') {
    if (!order || order.deleted_at) throw Object.assign(Error('订单不存在'), { status: 404 });
    if (order.current_step === 'completed') throw Object.assign(Error('已完成订单不能继续推进'), { status: 409 });
    if (body.target_next_step !== 'completed' && !body.target_deadline) throw Object.assign(Error('进行中的步骤必须有截止时间'), { status: 400 });
    const transitionTime = new Date().toISOString();
    const active = store.all('order_events').filter(row => row.order_id === order.id && !row.completed_at);
    active.forEach(row => store.put('order_events', { ...row, completed_at: transitionTime, completed_by: user.id }));
    store.put('order_events', { id: randomUUID(), order_id: order.id, step_key: body.target_next_step, started_at: transitionTime, deadline_at: body.target_deadline, completed_at: null, completed_by: null, note: null, created_at: transitionTime });
    const shipping = body.target_shipping || {};
    store.put('orders', {
      ...order,
      ...(body.target_shipping ? { shipping_mode: shipping.shipping_mode, forwarder_name: shipping.forwarder_name, sea_region: shipping.sea_region || null, overseas_method: shipping.overseas_method || null } : {}),
      ...(body.target_tracking_no ? { tracking_no: body.target_tracking_no } : {}),
      current_step: body.target_next_step,
      step_started_at: transitionTime,
      step_deadline: body.target_deadline,
      rollback_used: false,
      updated_at: transitionTime
    });
  } else throw Object.assign(Error('暂不支持该事务操作'), { status: 404 });
  return send(res, 200, null);
}

async function storageRoute(req, res, url, user) {
  if (!user) throw Object.assign(Error('请先登录'), { status: 401 });
  const signPrefix = '/storage/v1/object/sign/order-images/';
  const objectPrefix = '/storage/v1/object/order-images/';
  const ticketSignPrefix = '/storage/v1/object/sign/ticket-files/';
  const ticketObjectPrefix = '/storage/v1/object/ticket-files/';
  if (url.pathname.startsWith(ticketSignPrefix)) {
    const raw = url.pathname.slice(ticketSignPrefix.length);
    if (!tickets.canAccessFile(decodeURIComponent(raw), user.id)) throw Object.assign(Error('没有查看附件的权限'), { status: 403 });
    const expires = Math.floor(Date.now() / 1000) + Math.min(3600, Number((await readBody(req)).expiresIn || 3600));
    const token = objectSignature(`ticket:${raw}`, expires);
    return send(res, 200, { signedURL: `/object/ticket-files/${raw}?expires=${expires}&token=${encodeURIComponent(token)}` });
  }
  if (url.pathname.startsWith(ticketObjectPrefix)) {
    const raw = decodeURIComponent(url.pathname.slice(ticketObjectPrefix.length));
    const ticketId = raw.split('/')[0];
    tickets.requireTicket(ticketId, tickets.actor(user.id));
    const file = safeUploadPath(raw, join(UPLOAD_DIR, 'tickets'));
    if (req.method === 'POST') { const body = await readBody(req, 25 * 1024 * 1024); await mkdir(dirname(file), { recursive: true }); await writeFile(file, body); return send(res, 200, { Key: raw }); }
  }
  if (url.pathname.startsWith(signPrefix)) {
    const raw = url.pathname.slice(signPrefix.length);
    const expires = Math.floor(Date.now() / 1000) + Math.min(3600, Number((await readBody(req)).expiresIn || 3600));
    const token = objectSignature(raw, expires);
    return send(res, 200, { signedURL: `/object/order-images/${raw}?expires=${expires}&token=${encodeURIComponent(token)}` });
  }
  if (url.pathname.startsWith('/storage/v1/object/order-images/')) {
    if (!store.isFollower(user.id)) throw Object.assign(Error('没有操作权限'), { status: 403 });
    const file = safeUploadPath(url.pathname.slice(objectPrefix.length));
    if (req.method === 'POST') { const body = await readBody(req); await mkdir(dirname(file), { recursive: true }); await writeFile(file, body); return send(res, 200, { Key: file }); }
    if (req.method === 'DELETE') { await unlink(file).catch(() => {}); return send(res, 200, {}); }
  }
  if (url.pathname.startsWith('/storage/v1/object/order-images/')) throw Object.assign(Error('文件不存在'), { status: 404 });
  throw Object.assign(Error('不支持的存储操作'), { status: 404 });
}

async function serveObject(req, res, url) {
  const raw = url.pathname.slice('/storage/v1/object/order-images/'.length);
  const expires = Number(url.searchParams.get('expires') || 0), supplied = String(url.searchParams.get('token') || '');
  const expected = objectSignature(raw, expires);
  const valid = expires > Math.floor(Date.now() / 1000) && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) throw Object.assign(Error('图片链接已失效'), { status: 403 });
  const file = safeUploadPath(raw);
  const info = await stat(file); res.writeHead(200, { 'Content-Length': info.size, 'Cache-Control': 'private, max-age=3600' }); res.end(await readFile(file));
}

async function serveTicketObject(req, res, url) {
  const raw = url.pathname.slice('/storage/v1/object/ticket-files/'.length);
  const expires = Number(url.searchParams.get('expires') || 0), supplied = String(url.searchParams.get('token') || '');
  const expected = objectSignature(`ticket:${raw}`, expires);
  const valid = expires > Math.floor(Date.now() / 1000) && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) throw Object.assign(Error('附件链接已失效'), { status: 403 });
  const file = safeUploadPath(raw, join(UPLOAD_DIR, 'tickets'));
  const info = await stat(file); res.writeHead(200, { 'Content-Length': info.size, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(raw.split('/').pop() || 'attachment')}`, 'Cache-Control': 'private, max-age=3600' }); res.end(await readFile(file));
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') return send(res, 200, { ok: true, orders: store.count('orders'), web_push: Boolean(push) });
    // Await every asynchronous route here so its rejection stays inside this
    // request's error boundary. Returning the promise directly would let a
    // normal 4xx error become an unhandled rejection and terminate Node.
    if (url.pathname.startsWith('/auth/v1/')) return await authRoute(req, res, url);
    if (url.pathname === '/admin/import' && req.method === 'POST') {
      if (!IMPORT_SECRET || req.headers['x-import-secret'] !== IMPORT_SECRET) throw Object.assign(Error('禁止导入'), { status: 403 });
      const body = await readBody(req, 1024 * 1024 * 1024);
      for (const [table, rows] of Object.entries(body.tables || {})) store.importRows(table, rows);
      for (const profile of body.tables?.profiles || []) store.upsertAccount({ id: profile.id, email: profile.email, role: profile.role });
      return send(res, 200, Object.fromEntries(TABLES.map(table => [table, store.count(table)])));
    }
    if (url.pathname.startsWith('/admin/import-object/') && req.method === 'POST') {
      if (!IMPORT_SECRET || req.headers['x-import-secret'] !== IMPORT_SECRET) throw Object.assign(Error('禁止导入'), { status: 403 });
      const file = safeUploadPath(url.pathname.slice('/admin/import-object/'.length));
      const body = await readBody(req, 100 * 1024 * 1024);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
      return send(res, 200, { ok: true, size: body.length });
    }
    if (url.pathname.startsWith('/storage/v1/object/order-images/') && req.method === 'GET') return await serveObject(req, res, url);
    if (url.pathname.startsWith('/storage/v1/object/ticket-files/') && req.method === 'GET') return await serveTicketObject(req, res, url);
    const user = isPublicRequest(url.pathname) ? store.session(bearer(req)) : requireUser(req);
    if (url.pathname.startsWith('/storage/v1/')) return await storageRoute(req, res, url, user);
    const rpcMatch = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
    if (rpcMatch) return rpc(req, res, rpcMatch[1], await readBody(req), user);
    const tableMatch = /^\/rest\/v1\/([a-z0-9_]+)$/.exec(url.pathname);
    if (tableMatch && TABLES.includes(tableMatch[1])) {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, store.mutate(tableMatch[1], req.method, url, body, user.id, String(req.headers.prefer || '')));
    }
    throw Object.assign(Error('接口不存在'), { status: 404 });
  } catch (caught) { error(res, caught); }
}

const server = http.createServer((req, res) => {
  // Keep one final promise boundary at the HTTP server edge. handleRequest
  // normally consumes route errors itself; this protects the process if a
  // future asynchronous branch is added without its own error handling.
  void handleRequest(req, res).catch(caught => {
    if (!res.headersSent) error(res, caught);
    else res.destroy(caught);
  });
});

// Deadline reminders run on the server and never depend on a browser being open.
// The separate systemd timer may also run on upgraded hosts; notification keys
// make both paths idempotent.
const runTicketReminders = () => {
  try { tickets.runReminders(); }
  catch (caught) { console.error('Ticket reminder check failed:', caught); }
};
setTimeout(runTicketReminders, 10_000).unref();
setInterval(runTicketReminders, 5 * 60_000).unref();

server.listen(PORT, '127.0.0.1', () => console.log(`Cargo Pulse Tencent data service listening on 127.0.0.1:${PORT}`));
