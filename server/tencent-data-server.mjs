import http from 'node:http';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { TencentDataStore, TABLES, isPublicRequest, lookupCustomerTracking, shopifyLineSummary, shopifyShippingChoice, shopifyBlowerChoice, shopifyCustomerInfo, SHOPIFY_IMPORT_START, SHOPIFY_EXPLICIT_ORDER_NUMBERS, shopifySyncEligible } from './tencent-data-core.mjs';

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
const send = (res, status, value, headers = {}) => {
  const body = value == null ? '' : JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Cargo-Pulse-Data-Revision': DATA_REVISION, ...(value?.access_token ? { 'Set-Cookie': `cp_order_images=${value.access_token}; HttpOnly; Secure; SameSite=Strict; Path=/storage/v1/; Max-Age=3600` } : {}), ...headers });
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
  const decoded = decodeURIComponent(raw);
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part === '.' || part === '..')) throw Object.assign(Error('非法文件路径'), { status: 400 });
  const cleaned = normalize('/' + decoded).replace(/^[/\\]+/, '');
  if (cleaned.includes('..')) throw Object.assign(Error('非法文件路径'), { status: 400 });
  return join(root, cleaned);
};
const objectSigningKey = IMPORT_SECRET || randomUUID();
const objectSignature = (raw, expires, userId) => createHmac('sha256', objectSigningKey).update(`${raw}\n${expires}\n${userId}`).digest('base64url');
const storageUser = req => {
  const cookie = String(req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('cp_order_images='));
  return store.session(bearer(req) || (cookie ? cookie.slice('cp_order_images='.length) : ''));
};

async function authRoute(req, res, url) {
  if (url.pathname.endsWith('/logout') && req.method === 'POST') {
    const body = await readBody(req), token = bearer(req), user = store.session(token);
    if (user && store.session(body.refresh_token, 'refresh')?.id === user.id) store.revokeSession(body.refresh_token);
    store.revokeSession(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'cp_order_images=; HttpOnly; Secure; SameSite=Strict; Path=/storage/v1/; Max-Age=0' });
  }
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
  if (name === 'lookup_customer_tracking') {
    return send(res, 200, lookupCustomerTracking(store, body.p_email));
  }
  if (!user) throw Object.assign(Error('请先登录'), { status: 401 });
  if (name === 'order_issues') {
    if (req.method !== 'POST') throw Object.assign(Error('请使用 POST 请求'), { status: 405 });
    return send(res, 200, store.orderIssues(user.id, body));
  }
  if (name === 'shopify_order_intake') {
    if (req.method !== 'POST') throw Object.assign(Error('请使用 POST 请求'), {status:405});
    return send(res, 200, store.shopifyIntake(user.id, body));
  }
  if (name === 'shopify_order_handoff') {
    if (req.method !== 'POST') throw Object.assign(Error('请使用 POST 请求'), {status:405});
    return send(res, 200, store.shopifyHandoff(user.id, body));
  }
  if (name === 'salesperson_order') {
    if (req.method !== 'POST') throw Object.assign(Error('请使用 POST 请求'), {status:405});
    return send(res, 200, store.salespersonOrder(user.id, body));
  }
  if (name === 'home_bootstrap') return send(res, 200, store.homeSnapshot(user.id));
  if (name === 'home_core') return send(res, 200, store.homeCoreSnapshot(user.id));
  if (name === 'internal_resource_permissions') return send(res, 200, store.internalResourcePermissions(user.id));
  if (name === 'home_relations') return send(res, 200, store.homeRelationsSnapshot(user.id));
  if (name === 'list_visible_orders') return send(res, 200, store.visibleRows('orders', user.id));
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
    if (['sales_supplement', 'follower_create'].includes(order.current_step)) throw Object.assign(Error('请通过订单交接完成这一步'), {status:409});
    if (order.current_step === 'business_placed' && !String(order.factory_name || '').trim()) throw Object.assign(Error('请先填写主工厂，再确认向工厂下单'), {status:400});
    if (order.current_step === 'completed') throw Object.assign(Error('已完成订单不能继续推进'), { status: 409 });
    if (body.target_next_step !== 'completed' && !body.target_deadline) throw Object.assign(Error('进行中的步骤必须有截止时间'), { status: 400 });
    const transitionTime = new Date().toISOString();
    let stageDeadline = body.target_deadline, orderDate = order.order_date;
    const factoryOrder = order.current_step === 'business_placed';
    if (factoryOrder) {
      const next = order.inventory_mode === 'stock' ? ['shipping_selection',1] :
        order.needs_rendering ? ['rendering',3] : ['production',10];
      if (body.target_next_step !== next[0]) throw Object.assign(Error('下一阶段不正确，请刷新订单'), {status:409});
      orderDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'})
        .format(new Date(transitionTime));
      stageDeadline = new Date(Date.parse(transitionTime) + next[1] * 86400000).toISOString();
    }
    const active = store.all('order_events').filter(row => row.order_id === order.id && !row.completed_at);
    active.forEach(row => store.put('order_events', { ...row, completed_at: transitionTime, completed_by: user.id }));
    store.put('order_events', { id: randomUUID(), order_id: order.id, step_key: body.target_next_step, started_at: transitionTime, deadline_at: stageDeadline, completed_at: null, completed_by: null, note: null, created_at: transitionTime });
    const shipping = body.target_shipping || {};
    store.put('orders', {
      ...order,
      ...(body.target_shipping ? { shipped_at: shipping.shipped_at, shipping_mode: shipping.shipping_mode, forwarder_name: shipping.forwarder_name, sea_region: shipping.sea_region || null, overseas_method: shipping.overseas_method || null } : {}),
      ...(body.target_tracking_no ? { tracking_no: body.target_tracking_no } : {}),
      current_step: body.target_next_step,
      step_started_at: transitionTime,
      step_deadline: stageDeadline,
      ...(factoryOrder ? { order_date: orderDate } : {}),
      rollback_used: false,
      updated_at: transitionTime
    });
    if (factoryOrder) return send(res, 200, { started_at: transitionTime, deadline_at: stageDeadline, order_date: orderDate });
  } else throw Object.assign(Error('暂不支持该事务操作'), { status: 404 });
  return send(res, 200, null);
}

async function storageRoute(req, res, url, user) {
  if (!user) throw Object.assign(Error('请先登录'), { status: 401 });
  const signPrefix = '/storage/v1/object/sign/order-images/';
  const objectPrefix = '/storage/v1/object/order-images/';
  if (url.pathname.startsWith(signPrefix)) {
    const raw = url.pathname.slice(signPrefix.length);
    safeUploadPath(raw);
    if (!store.canReadObject(user.id, decodeURIComponent(raw))) throw Object.assign(Error('图片不存在或无权访问'), { status: 404 });
    const duration = Number((await readBody(req)).expiresIn || 3600);
    const expires = Math.floor(Date.now() / 1000) + (Number.isFinite(duration) ? Math.max(1, Math.min(3600, duration)) : 3600);
    const token = objectSignature(raw, expires, user.id);
    return send(res, 200, { signedURL: `/object/order-images/${raw}?expires=${expires}&uid=${encodeURIComponent(user.id)}&token=${encodeURIComponent(token)}` }, { 'Set-Cookie': `cp_order_images=${bearer(req)}; HttpOnly; Secure; SameSite=Strict; Path=/storage/v1/; Max-Age=3600` });
  }
  if (url.pathname.startsWith('/storage/v1/object/order-images/')) {
    const raw = decodeURIComponent(url.pathname.slice(objectPrefix.length));
    const productUpload = req.method === 'POST' && store.canUploadShopifyProductImage(user.id, raw);
    if (!store.isFollower(user.id) && !productUpload) throw Object.assign(Error('没有操作权限'), { status: 403 });
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
  safeUploadPath(raw);
  const user = storageUser(req);
  const ownerId = url.searchParams.get('uid');
  if (!user || user.id !== ownerId || !store.canReadObject(user.id, decodeURIComponent(raw))) throw Object.assign(Error('图片不存在或无权访问'), { status: 404 });
  const expected = objectSignature(raw, expires, ownerId);
  const valid = expires > Math.floor(Date.now() / 1000) && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) throw Object.assign(Error('图片链接已失效'), { status: 403 });
  const file = safeUploadPath(raw);
  const info = await stat(file); res.writeHead(200, { 'Content-Length': info.size, 'Cache-Control': 'private, no-store' }); res.end(await readFile(file));
}

const AI_READ_TABLES = new Set([
  'orders', 'order_events', 'order_factories', 'order_shipments', 'order_shipment_events',
  'order_images', 'order_issues', 'partners', 'internal_resource_tables'
]);

function aiReadRoute(req, res, url) {
  const path = url.pathname.slice('/rest/v1/ai/'.length);
  const keyPath = /^keys(?:\/([a-f0-9]{64}))?$/.exec(path);
  if (keyPath) {
    const user = requireUser(req);
    if (!store.isSupervisor(user.id)) throw Object.assign(Error('仅主管可管理 AI 读取密钥'), { status: 403 });
    if (keyPath[1] && req.method === 'DELETE') {
      store.revokeAiReadKey(user.id, keyPath[1]);
      return send(res, 204, null);
    }
    if (!keyPath[1] && req.method === 'GET') return send(res, 200, { keys: store.aiReadKeys(user.id) });
    if (!keyPath[1] && req.method === 'POST') return send(res, 201, store.issueAiReadKey(user.id));
    return send(res, 405, { message: '不支持此请求方法' });
  }

  const user = store.session(bearer(req), 'ai_read');
  if (!user || !store.isSupervisor(user.id)) throw Object.assign(Error('AI 读取密钥无效或已过期'), { status: 401 });
  if (req.method !== 'GET') return send(res, 405, { message: '此接口仅支持读取' }, { Allow: 'GET' });
  if (path === 'datasets') return send(res, 200, { datasets: [...AI_READ_TABLES], default_limit: 100, max_limit: 500 });
  if (!AI_READ_TABLES.has(path)) return send(res, 404, { message: '数据集不存在' });
  const limit = Number(url.searchParams.get('limit') ?? '100');
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return send(res, 400, { message: 'limit 必须是 1 到 500 之间的整数' });
  return send(res, 200, store.aiReadPage(path, url.searchParams.get('cursor') || '', limit));
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/rest/v1/ai/')) return aiReadRoute(req, res, url);
    if (url.pathname === '/health') return send(res, 200, { ok: true });
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
    const user = isPublicRequest(url.pathname) ? store.session(bearer(req)) : requireUser(req);
    if (url.pathname.startsWith('/storage/v1/')) return await storageRoute(req, res, url, user);
    const rpcMatch = /^\/rest\/v1\/rpc\/([a-z0-9_]+)$/.exec(url.pathname);
    if (rpcMatch) return rpc(req, res, rpcMatch[1], await readBody(req), user);
    const tableMatch = /^\/rest\/v1\/([a-z0-9_]+)$/.exec(url.pathname);
    if (tableMatch && TABLES.includes(tableMatch[1])) {
      const body = ['POST', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, store.mutate(tableMatch[1], req.method, url, body, user.id, String(req.headers.prefer || ''), String(req.headers.range || '')));
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

// Deadline reminders and retry delivery run in the dedicated systemd worker.
// Keeping those provider calls out of this process protects the core API.

// General sync stays at Beijing time 2026-11-21 00:00 (SHOPIFY_IMPORT_START).
// Order 9050 is five minutes earlier and is requested by name, not by moving
// that window backward.
const period = 30 * 60 * 1000;
const orderQuery = `query ImportOrders($query: String!, $after: String) {
  orders(first: 25, after: $after, query: $query, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt note email phone
      customAttributes { key value }
      shippingAddress { name firstName lastName phone address1 address2 city province zip country }
      shippingLines(first: 10) { nodes { title code } }
      lineItems(first: 30) {
        nodes { name quantity variantTitle image { url } customAttributes { key value } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
const lineQuery = `query ImportOrderItems($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 100, after: $after) {
      nodes { name quantity variantTitle image { url } customAttributes { key value } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function mapShopifyOrder(order, items) {
  const attributes = [...(order.customAttributes || []), ...items.flatMap(item => item.customAttributes || [])];
  const shipping = (order.shippingLines?.nodes || []).map(line=>[line.title,line.code].filter(Boolean).join(' ')).join(' ');
  const dimensions = /\d+(?:\.\d+)?\s*(?:cm|mm|m|ft|in|米|英尺)?\s*[×xX*]\s*\d+(?:\.\d+)?(?:\s*(?:cm|mm|m|ft|in|米|英尺)?\s*[×xX*]\s*\d+(?:\.\d+)?)?\s*(?:cm|mm|m|ft|in|米|英尺)?/gi;
  const sizes = [...attributes.filter(entry=>/^(size|dimensions?|产品尺寸|尺寸)$/i.test(String(entry.key || '').trim())).map(entry=>entry.value),
    ...items.flatMap(item=>[...(String(item.variantTitle||'').match(dimensions)||[]),...(String(item.name||'').match(dimensions)||[])])];
  const address = order.shippingAddress || {};
  const summary = shopifyLineSummary(items);
  const note = order.note || '';
  return {
    id: order.id, order_no: String(order.name || '').trim(),
    order_date: new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(order.createdAt)),
    product_name: summary.product_name, quantity: summary.quantity,
    image_urls: [...new Set(items.map(item=>item.image?.url).filter(url=>typeof url==='string'&&url.startsWith('https://')))],
    size: [...new Set(sizes.map(size=>String(size||'').trim()).filter(Boolean))].join(' / '),
    requirements: note, abnormal_note: note,
    blower: shopifyBlowerChoice(shipping),
    customer_info: shopifyCustomerInfo({
      name: address.name || [address.firstName, address.lastName].filter(Boolean).join(' '),
      address: [address.address1, address.address2, address.city, address.province, address.zip, address.country].filter(Boolean).join(', '),
      email: order.email,
      phone: address.phone || order.phone
    }),
    shipping_mode: shopifyShippingChoice(shipping),
    country: address.country || ''
  };
}

function startShopifySync(store, env = process.env) {
  const domain = String(env.SHOPIFY_ORDER_SHOP || '').toLowerCase().trim();
  const {SHOPIFY_ORDER_CLIENT_ID:clientId, SHOPIFY_ORDER_CLIENT_SECRET:clientSecret} = env;
  let token = env.SHOPIFY_ORDER_TOKEN, tokenExpires = token ? Infinity : 0;
  const version = env.SHOPIFY_ORDER_API_VERSION || '2026-10';
  if ((!token && (!clientId || !clientSecret)) || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain) || !/^\d{4}-(01|04|07|10)$/.test(version)) return;
  let running = false;
  async function query(document, variables) {
    if (Date.now() >= tokenExpires) {
      const response = await fetch(`https://${domain}/admin/oauth/access_token`,{
        method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams({grant_type:'client_credentials',client_id:clientId,client_secret:clientSecret}),
        signal:AbortSignal.timeout(30000), redirect:'error'
      });
      if (!response.ok) throw Error('Shopify 认证 HTTP '+response.status);
      const result = await response.json();
      if (!result.access_token || !Number.isFinite(result.expires_in)) throw Error('Shopify 未返回可续期的访问凭据');
      token=result.access_token;
      tokenExpires=Date.now()+Math.max(0,result.expires_in-300)*1000;
    }
    const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`,{
      method:'POST', headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},
      body:JSON.stringify({query:document,variables}), signal:AbortSignal.timeout(30000), redirect:'error'
    });
    if (!response.ok) throw Error('Shopify HTTP '+response.status);
    const result = await response.json();
    if (result.errors?.length || !result.data) throw Error('Shopify 未返回完整订单数据，请检查应用权限');
    return result.data;
  }
  async function sync() {
    if(running)return;
    running=true;
    try {
      let changed = 0;
      async function importSearch(search) {
        let after = null;
        do {
          const {orders} = await query(orderQuery,{query:search,after});
          for(const order of orders.nodes){
            if(!shopifySyncEligible(order)||!store.shopifyOrderNeedsRefresh(order.name, order.id))continue;
            let connection=order.lineItems;
            const items=[...connection.nodes];
            while(connection.pageInfo.hasNextPage){
              const result=await query(lineQuery,{id:order.id,after:connection.pageInfo.endCursor});
              connection=result.order.lineItems;
              items.push(...connection.nodes);
            }
            if(store.importShopifyOrder(mapShopifyOrder(order,items))) changed += 1;
          }
          after=orders.pageInfo.hasNextPage?orders.pageInfo.endCursor:null;
        }while(after);
      }
      await importSearch("created_at:>='"+SHOPIFY_IMPORT_START+"'");
      for (const number of SHOPIFY_EXPLICIT_ORDER_NUMBERS) await importSearch('name:#'+number);
      if(changed) console.log('Shopify 自北京时间 2026-11-21 00:00 起、以及指定的 9050，系统中尚未建档的订单已写入待业务员补充信息：'+changed+' 单');
    }catch(error){console.warn('Shopify 自动导入失败',error.message);}
    finally{running=false;}
  }
  void sync();
  setInterval(sync,period).unref();
}

function promoteUnclaimedShopifyOrders(store) {
  try {
    const promoted = store.promoteOpenShopifyIntake();
    const converted = promoted.converted.map(row => row.order_no);
    const linked = promoted.already_present.map(row => row.order_no);
    if (converted.length || linked.length) console.log('Shopify 未提交导入单已转入待业务员补充信息 ' + JSON.stringify({ converted, already_present: linked }));
    if (promoted.skipped.length) console.warn('Shopify 未提交导入单缺少订单号，未转入 ' + promoted.skipped.map(row => row.id).join(', '));
  } catch (error) {
    console.warn('Shopify 未认领订单转入失败', error.message);
  }
}

promoteUnclaimedShopifyOrders(store);
startShopifySync(store);
server.listen(PORT, '127.0.0.1', () => console.log(`Cargo Pulse Tencent data service listening on 127.0.0.1:${PORT}`));
