import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { TencentDataStore, TABLES, isPublicRequest } from './tencent-data-core.mjs';

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

const send = (res, status, value, headers = {}) => {
  const body = value == null ? '' : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
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
const safeUploadPath = raw => {
  const cleaned = normalize('/' + decodeURIComponent(raw)).replace(/^[/\\]+/, '');
  if (cleaned.includes('..')) throw Object.assign(Error('非法文件路径'), { status: 400 });
  return join(UPLOAD_DIR, cleaned);
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
    const setting = store.all('app_settings').find(row => row.key === 'follower_invite');
    const role = body.data?.follower_invite && body.data.follower_invite === setting?.value ? 'follower' : 'business';
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

function rpc(req, res, name, body, user) {
  if (name === 'lookup_customer_tracking') {
    const email = String(body.p_email || '').trim().toLowerCase();
    const rows = store.all('orders').filter(row => String(row.customer_info || '').toLowerCase().includes(email) && !row.deleted_at)
      .map(row => ({ order_no: row.order_no, product_name: row.product_name, current_step: row.current_step, updated_at: row.updated_at }));
    return send(res, 200, rows);
  }
  if (!user) throw Object.assign(Error('请先登录'), { status: 401 });
  if (name === 'list_visible_orders') return send(res, 200, store.all('orders').filter(row => !row.deleted_at || store.isSupervisor(user.id)));
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/health') return send(res, 200, { ok: true, orders: store.count('orders') });
    if (url.pathname.startsWith('/auth/v1/')) return authRoute(req, res, url);
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
    if (url.pathname.startsWith('/storage/v1/object/order-images/') && req.method === 'GET') return serveObject(req, res, url);
    const user = isPublicRequest(url.pathname) ? store.session(bearer(req)) : requireUser(req);
    if (url.pathname.startsWith('/storage/v1/')) return storageRoute(req, res, url, user);
    const rpcMatch = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
    if (rpcMatch) return rpc(req, res, rpcMatch[1], await readBody(req), user);
    const tableMatch = /^\/rest\/v1\/([a-z0-9_]+)$/.exec(url.pathname);
    if (tableMatch && TABLES.includes(tableMatch[1])) {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, store.mutate(tableMatch[1], req.method, url, body, user.id, String(req.headers.prefer || '')));
    }
    throw Object.assign(Error('接口不存在'), { status: 404 });
  } catch (caught) { error(res, caught); }
});

server.listen(PORT, '127.0.0.1', () => console.log(`Cargo Pulse Tencent data service listening on 127.0.0.1:${PORT}`));
