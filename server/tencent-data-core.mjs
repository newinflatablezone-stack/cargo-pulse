import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Keep the data service self-contained: older production deployers install
// this core file directly and may not yet copy newly added helper modules.
const normalizeDestination = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ').trim().replace(/\s+/g, ' ');
const MAINSTREAM_DESTINATION_ALIASES = new Map([
  ['美国',['美国','美國','us','usa','u.s.','u.s.a.','united states','united states of america']],['加拿大',['加拿大','canada']],['墨西哥',['墨西哥','mexico','méxico']],['澳大利亚',['澳大利亚','澳洲','australia']],['英国',['英国','英國','uk','u.k.','united kingdom','great britain','england','scotland','wales','northern ireland']],['法国',['法国','法國','france']],['德国',['德国','德國','germany','deutschland']],['荷兰',['荷兰','荷蘭','netherlands','holland']],['比利时',['比利时','比利時','belgium']],['卢森堡',['卢森堡','盧森堡','luxembourg']],['爱尔兰',['爱尔兰','愛爾蘭','ireland']],['瑞士',['瑞士','switzerland']],['奥地利',['奥地利','奧地利','austria']],['意大利',['意大利','义大利','義大利','italy']],['西班牙',['西班牙','spain']],['葡萄牙',['葡萄牙','portugal']],['丹麦',['丹麦','丹麥','denmark']],['瑞典',['瑞典','sweden']],['挪威',['挪威','norway']],['芬兰',['芬兰','芬蘭','finland']],['冰岛',['冰岛','冰島','iceland']],['日本',['日本','japan']],['新加坡',['新加坡','singapore']],['新西兰',['新西兰','新西蘭','纽西兰','紐西蘭','new zealand']],['韩国',['韩国','韓國','南韩','南韓','south korea','republic of korea','korea republic of']]
].flatMap(([name, aliases]) => aliases.map(alias => [normalizeDestination(alias), name])));
const classifyDestination = value => {
  const input = String(value || '').trim(), canonical = MAINSTREAM_DESTINATION_ALIASES.get(normalizeDestination(input)) || null;
  return { input, canonical, mainstream: Boolean(canonical), risk: input && !canonical ? 'non_mainstream' : input ? 'mainstream' : 'unknown' };
};

export const TABLES = [
  'profiles', 'app_settings', 'partners', 'orders', 'order_events', 'order_images', 'order_issues', 'order_issue_reads',
  'order_factories', 'order_shipments', 'order_shipment_events', 'internal_resource_tables',
  'tickets', 'ticket_messages', 'ticket_attachments', 'ticket_history',
  'ticket_notifications', 'ticket_reminder_logs', 'push_subscriptions', 'push_delivery_logs'
];

// Retain historical rows for backup/recovery, but expose no application API.
const RETIRED_FEATURE_TABLES = new Set(['tickets', 'ticket_messages', 'ticket_attachments', 'ticket_history', 'ticket_notifications', 'ticket_reminder_logs', 'push_subscriptions', 'push_delivery_logs']);

const PUBLIC_RPC = new Set(['lookup_customer_tracking']);
const SUPERVISOR_EMAIL = '505863160@qq.com';
const now = () => new Date().toISOString();
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value ?? null);

function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

function passwordMatches(password, encoded = '') {
  // Imported Supabase profiles deliberately start without a local password
  // hash. Treat that as a non-match so the auth route can verify the legacy
  // password once and persist a Tencent-local hash.
  const [salt, expectedHex] = String(encoded || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function decodeFilter(raw) {
  const value = String(raw ?? '');
  if (value === 'is.null') return { op: 'is', value: null };
  const dot = value.indexOf('.');
  return dot < 0 ? { op: 'eq', value } : { op: value.slice(0, dot), value: value.slice(dot + 1) };
}

function scalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  return value;
}

function matches(row, key, raw) {
  const { op, value } = decodeFilter(raw);
  const current = row[key];
  if (op === 'is') return current == null;
  if (op === 'eq') return String(current ?? '') === String(scalar(value) ?? '');
  if (op === 'neq') return String(current ?? '') !== String(scalar(value) ?? '');
  if (op === 'like' || op === 'ilike') {
    const escaped = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`, op === 'ilike' ? 'i' : '').test(String(current ?? ''));
  }
  if (op === 'in') {
    const list = value.replace(/^\(|\)$/g, '').split(',').map(item => decodeURIComponent(item).replace(/^"|"$/g, ''));
    return list.includes(String(current ?? ''));
  }
  if (op === 'gt') return current > scalar(value);
  if (op === 'gte') return current >= scalar(value);
  if (op === 'lt') return current < scalar(value);
  if (op === 'lte') return current <= scalar(value);
  return true;
}

function project(row, select) {
  if (!select || select === '*') return row;
  const fields = select.split(',').map(value => value.trim()).filter(value => /^[a-zA-Z0-9_]+$/.test(value));
  return Object.fromEntries(fields.map(field => [field, row[field]]));
}

export class TencentDataStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.tableCache = new Map();
    this.db.exec(`
      pragma journal_mode=WAL;
      pragma synchronous=NORMAL;
      pragma foreign_keys=ON;
      pragma busy_timeout=5000;
      create table if not exists records (
        table_name text not null,
        record_id text not null,
        data text not null,
        primary key (table_name, record_id)
      );
      create index if not exists records_table_idx on records(table_name);
      create table if not exists accounts (
        id text primary key,
        email text not null unique collate nocase,
        password_hash text,
        created_at text not null
      );
      create table if not exists sessions (
        token_hash text primary key,
        user_id text not null,
        kind text not null,
        expires_at integer not null
      );
      create index if not exists sessions_user_idx on sessions(user_id);
      create table if not exists meta (key text primary key, value text not null);
    `);
  }

  count(table) {
    return this.db.prepare('select count(*) count from records where table_name=?').get(table).count;
  }

  all(table) {
    const version = this.db.prepare('pragma data_version').get().data_version;
    if (version !== this.dataVersion) { this.tableCache.clear(); this.dataVersion = version; }
    if (!this.tableCache.has(table)) {
      this.tableCache.set(table, this.db.prepare('select data from records where table_name=?').all(table).map(({ data }) => JSON.parse(data)));
    }
    // Callers historically received fresh row objects. Preserve that contract
    // while avoiding repeated SQLite reads and JSON parsing for every request.
    return this.tableCache.get(table).map(row => ({ ...row }));
  }

  put(table, row) {
    const next = { ...row };
    if (!next.id && table !== 'app_settings' && table !== 'internal_resource_tables') next.id = randomUUID();
    const id = String(next.id ?? next.key ?? next.resource_key);
    if (!id || id === 'undefined') throw Error(`缺少 ${table} 主键`);
    this.db.prepare('insert into records(table_name,record_id,data) values(?,?,?) on conflict(table_name,record_id) do update set data=excluded.data')
      .run(table, id, json(next));
    this.tableCache.delete(table);
    return next;
  }

  remove(table, ids) {
    const del = this.db.prepare('delete from records where table_name=? and record_id=?');
    this.db.exec('begin immediate');
    try { ids.forEach(id => del.run(table, String(id))); this.db.exec('commit'); }
    catch (error) { this.db.exec('rollback'); throw error; }
    this.tableCache.delete(table);
  }

  accountByEmail(email) { return this.db.prepare('select * from accounts where email=? collate nocase').get(email); }
  accountById(id) { return this.db.prepare('select * from accounts where id=?').get(id); }

  upsertAccount({ id = randomUUID(), email, password = null, role = 'business' }) {
    const existing = this.accountByEmail(email);
    const userId = existing?.id || id;
    const encoded = password ? passwordHash(password) : existing?.password_hash || null;
    this.db.prepare('insert into accounts(id,email,password_hash,created_at) values(?,?,?,?) on conflict(email) do update set password_hash=coalesce(excluded.password_hash,accounts.password_hash)')
      .run(userId, email.toLowerCase(), encoded, existing?.created_at || now());
    const profile = this.all('profiles').find(row => row.id === userId) || { id: userId, email: email.toLowerCase(), role, created_at: now() };
    profile.email = email.toLowerCase();
    if (profile.email === SUPERVISOR_EMAIL) profile.role = 'follower';
    this.put('profiles', profile);
    return { ...profile, id: userId };
  }

  issueSession(user) {
    if (!this.isUserActive(user.id)) throw Object.assign(Error('账号已被停用'), { status: 403 });
    const access = randomBytes(32).toString('base64url');
    const refresh = randomBytes(48).toString('base64url');
    const epoch = Math.floor(Date.now() / 1000);
    const insert = this.db.prepare('insert into sessions(token_hash,user_id,kind,expires_at) values(?,?,?,?)');
    insert.run(tokenHash(access), user.id, 'access', epoch + 3600);
    insert.run(tokenHash(refresh), user.id, 'refresh', epoch + 2592000);
    return { access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: 3600, expires_at: epoch + 3600, user: { id: user.id, email: user.email } };
  }

  session(token, kind = 'access') {
    if (!token) return null;
    const row = this.db.prepare('select * from sessions where token_hash=? and kind=? and expires_at>?').get(tokenHash(token), kind, Math.floor(Date.now() / 1000));
    return row && this.isUserActive(row.user_id) ? this.accountById(row.user_id) : null;
  }

  meta(key) { return this.db.prepare('select value from meta where key=?').get(String(key))?.value ?? null; }
  setMeta(key, value) {
    this.db.prepare('insert into meta(key,value) values(?,?) on conflict(key) do update set value=excluded.value').run(String(key), String(value));
    return String(value);
  }

  revokeUserSessions(userId) { this.db.prepare('delete from sessions where user_id=?').run(userId); }

  setUserActive(userId, active) {
    const profile = this.profile(userId);
    if (!profile) throw Object.assign(Error('用户不存在'), { status: 404 });
    const next = this.put('profiles', { ...profile, disabled_at: active ? null : now() });
    if (!active) this.revokeUserSessions(userId);
    return next;
  }

  isUserActive(userId) { return !this.profile(userId)?.disabled_at; }

  login(email, password) {
    const account = this.accountByEmail(email);
    if (!account || !this.isUserActive(account.id) || !passwordMatches(password, account.password_hash)) return null;
    return this.issueSession(account);
  }

  refresh(refreshToken) {
    const account = this.session(refreshToken, 'refresh');
    if (!account) return null;
    this.db.prepare('delete from sessions where token_hash=?').run(tokenHash(refreshToken));
    return this.issueSession(account);
  }

  revokeSession(token) { if (token) this.db.prepare('delete from sessions where token_hash=?').run(tokenHash(token)); }

  profile(userId) { return this.all('profiles').find(row => row.id === userId); }
  isFollower(userId) { return this.profile(userId)?.role === 'follower'; }
  internalResourcePermissions(userId) {
    const profile = this.profile(userId);
    return { can_edit: Boolean(profile && !profile.disabled_at && (this.isFollower(userId) || this.isSupervisor(userId))) };
  }
  isSupervisor(userId) { return Boolean(userId) && this.accountById(userId)?.email?.toLowerCase() === SUPERVISOR_EMAIL; }

  canReadAllOrders(userId) {
    const actor = this.profile(userId);
    return Boolean(actor && !actor.disabled_at && (actor.role === 'follower' || this.isSupervisor(userId)));
  }

  ownsOrder(userId, order) {
    const actor = this.profile(userId);
    if (!actor || actor.disabled_at || actor.role !== 'business' || !order) return false;
    const explicit = [...new Set([order.business_id, order.business_user_id].filter(value => value != null && String(value).trim()).map(String))];
    if (explicit.length) return explicit.length === 1 && explicit[0] === userId;
    const assignedName = String(order.business_name || '').trim().toLowerCase();
    if (!assignedName) return order.created_by === userId;
    const matches = this.businessOwnersForName(assignedName);
    return matches.length === 1 && matches[0].id === userId;
  }

  businessOwnersForName(value) {
    const assignedName = String(value || '').trim().toLowerCase();
    if (!assignedName) return [];
    const aliases = { 'sales@inflatable-zone.com': 'Ella', 'sherry@inflatable-zone.com': 'Sherry', 'demi@inflatable-zone.com': 'Demi', 'rayna@inflatable-zone.com': 'Rayna' };
    // Ambiguous legacy names grant nobody access until staff assign an ID.
    return this.all('profiles').filter(candidate => {
      if (candidate.role !== 'business' || candidate.disabled_at) return false;
      const email = String(candidate.email || '').trim().toLowerCase();
      return [aliases[email], candidate.business_name, candidate.display_name, candidate.name].filter(Boolean)
        .some(name => String(name).trim().toLowerCase() === assignedName);
    });
  }

  normalizeOrderOwner(order, input) {
    if (!Object.hasOwn(input, 'business_name') || Object.hasOwn(input, 'business_id') || Object.hasOwn(input, 'business_user_id')) return order;
    const owners = this.businessOwnersForName(input.business_name);
    return { ...order, business_id: owners.length === 1 ? owners[0].id : null, business_user_id: null };
  }

  canReadOrder(userId, order) {
    if (!userId || !order || (order.deleted_at && !this.isSupervisor(userId))) return false;
    return this.canReadAllOrders(userId) || this.ownsOrder(userId, order);
  }

  visibleRows(table, userId) {
    const actor = userId && this.profile(userId);
    if (!actor || actor.disabled_at) return [];
    if (table === 'orders') return this.all(table).filter(order => this.canReadOrder(userId, order));
    if (table === 'profiles') return this.all(table).filter(row => this.isSupervisor(userId) || row.id === userId);
    if (table === 'app_settings') return this.all(table).filter(row => this.isSupervisor(userId) || !String(row.key || '').endsWith('_invite'));
    const related = ['order_events', 'order_images', 'order_factories', 'order_shipments', 'order_shipment_events'];
    if (!related.includes(table)) return this.all(table);
    const orderIds = new Set(this.visibleRows('orders', userId).map(order => order.id));
    if (table === 'order_shipment_events') {
      const shipmentIds = new Set(this.all('order_shipments').filter(row => orderIds.has(row.order_id)).map(row => row.id));
      return this.all(table).filter(row => shipmentIds.has(row.shipment_id));
    }
    return this.all(table).filter(row => orderIds.has(row.order_id));
  }

  canReadObject(userId, objectPath) {
    if (this.canReadAllOrders(userId)) return true;
    const references = this.all('order_images').filter(row => row.object_path === objectPath);
    if (references.length) {
      const orders = new Map(this.all('orders').map(order => [order.id, order]));
      return references.some(row => this.canReadOrder(userId, orders.get(row.order_id)));
    }
    // Resource-table illustrations remain shared reference material. Unknown
    // order files, orphan files and guessed order-id prefixes are denied.
    const actor = this.profile(userId);
    if (!actor || actor.disabled_at) return false;
    const referencesPath = value => {
      if (!value || typeof value !== 'object') return false;
      if (value.object_path === objectPath) return true;
      return Object.values(value).some(referencesPath);
    };
    return this.all('internal_resource_tables').some(referencesPath);
  }

  issueCanCreate(userId, order) {
    return Boolean(order && !order.deleted_at && this.ownsOrder(userId, order));
  }

  orderIssues(userId, input = {}) {
    const profile = this.profile(userId);
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    if (!profile) fail('请先登录', 401);
    const follower = this.isFollower(userId), action = input.action || 'summary';
    const orders = new Map(this.visibleRows('orders', userId).map(order => [order.id, order]));
    const visible = issue => orders.has(issue.order_id);
    const reads = new Map(this.all('order_issue_reads').filter(row => row.user_id === userId).map(row => [row.issue_id, row.sequence]));
    const decorate = issue => ({ ...issue, unread: (reads.get(issue.id) || 0) < issue.sequence && issue.messages.some(message => message.sequence > (reads.get(issue.id) || 0) && message.author_id !== userId), order_no: orders.get(issue.order_id)?.order_no || '', business_name: orders.get(issue.order_id)?.business_name || '', can_close: this.ownsOrder(userId, orders.get(issue.order_id)) && issue.status !== 'closed', can_reply: issue.status !== 'closed' && (follower || this.ownsOrder(userId, orders.get(issue.order_id))), can_remind: follower && issue.status === 'waiting_business' });
    const all = this.all('order_issues');
    if (action === 'summary') {
      const issues = all.filter(issue => visible(issue) && !orders.get(issue.order_id).deleted_at).map(decorate).filter(issue => issue.status !== 'closed' || issue.unread).sort((a,b) => b.updated_at.localeCompare(a.updated_at));
      return { total: issues.filter(issue => issue.status !== 'closed').length, issues: issues.map(({ messages, ...issue }) => ({ ...issue, subject: messages[0]?.body || '', preview: messages.filter(message => message.kind === 'message').at(-1)?.body || '' })) };
    }
    if (action === 'order') {
      const order = orders.get(input.order_id);
      if (!order || order.deleted_at) fail('订单不存在', 404);
      return { can_create: this.issueCanCreate(userId, order), issues: all.filter(issue => issue.order_id === order.id && visible(issue)).map(decorate).sort((a,b) => b.created_at.localeCompare(a.created_at)) };
    }
    const timestamp = now();
    const content = () => {
      if (typeof input.body !== 'string' || !input.body.trim() || input.body.trim().length > 5000) fail('请填写问题或回复内容，最多 5000 字');
      return input.body.trim();
    };
    if (action === 'create') {
      const order = orders.get(input.order_id);
      if (!this.issueCanCreate(userId, order)) fail('只能为自己负责的订单提交问题', 403);
      if (typeof input.request_id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.request_id)) fail('提交标识无效，请重试');
      const id = userId + ':' + input.request_id, existing = all.find(issue => issue.id === id);
      if (existing) { if (!visible(existing)) fail('问题不存在或无权访问', 404); return decorate(existing); }
      const body = content();
      const issue = { id, order_id: order.id, created_by: userId, creator_email: profile.email, status: 'waiting_follower', sequence: 1, created_at: timestamp, updated_at: timestamp, messages: [{ id: randomUUID(), sequence: 1, author_id: userId, author_email: profile.email, author_role: profile.role, kind: 'message', body, created_at: timestamp }] };
      this.put('order_issues', issue);
      return decorate(issue);
    }
    const issue = all.find(row => row.id === input.issue_id);
    if (!issue || !visible(issue)) fail('问题不存在或无权访问', 404);
    if (action === 'read') {
      const sequence = Number(input.sequence);
      if (!Number.isInteger(sequence) || sequence < 0 || sequence > issue.sequence) fail('已读位置无效');
      this.put('order_issue_reads', { id: userId + ':' + issue.id, user_id: userId, issue_id: issue.id, sequence: Math.max(reads.get(issue.id) || 0, sequence) });
      return { ok: true };
    }
    if (issue.status === 'closed') {
      if (action === 'close' && this.ownsOrder(userId, orders.get(issue.order_id))) return decorate(issue);
      fail('问题已结束，不能继续操作', 409);
    }
    if (orders.get(issue.order_id).deleted_at) fail('订单已删除，无法操作', 409);
    let body, status = issue.status, kind = 'message';
    if (action === 'reply') { body = content(); status = follower ? 'waiting_business' : 'waiting_follower'; }
    else if (action === 'close') {
      if (!this.ownsOrder(userId, orders.get(issue.order_id))) fail('只有当前负责该订单的业务员可以结束问题', 403);
      status = 'closed'; kind = 'closed'; body = '业务员已确认解决，结束问题';
    } else if (action === 'remind') {
      if (!follower || status !== 'waiting_business') fail('请先回复问题，再提醒业务员结束', 403);
      const previous = issue.messages.filter(message => message.kind === 'reminder').at(-1);
      if (previous && Date.now() - Date.parse(previous.created_at) < 60000) fail('提醒已发送，请稍后再试', 429);
      kind = 'reminder'; body = '问题如已解决，请点击“结束问题”；仍需处理请继续回复';
    } else fail('不支持的问题操作');
    const sequence = issue.sequence + 1;
    const updated = { ...issue, status, sequence, updated_at: timestamp, ...(status === 'closed' ? { closed_at: timestamp, closed_by: userId } : {}), messages: [...issue.messages, { id: randomUUID(), sequence, author_id: userId, author_email: profile.email, author_role: profile.role, kind, body, created_at: timestamp }] };
    this.put('order_issues', updated);
    return decorate(updated);
  }


  homeCoreSnapshot(userId) {
    const supervisor = this.isSupervisor(userId);
    return {
      profile: this.profile(userId) || null,
      orders: this.visibleRows('orders', userId),
      profiles: supervisor ? this.all('profiles') : this.all('profiles').filter(row => row.id === userId),
      partners: this.all('partners').filter(row => row.active !== false)
    };
  }

  homeRelationsSnapshot(userId) {
    return {
      images: this.visibleRows('order_images', userId).filter(row => String(row.object_path || '').includes('/delivery-proof-')),
      tracking_events: this.visibleRows('order_events', userId).filter(row => String(row.note || '').startsWith('tracking:')),
      active_events: this.visibleRows('order_events', userId).filter(row => !row.completed_at),
      factories: this.visibleRows('order_factories', userId),
      shipments: this.visibleRows('order_shipments', userId)
    };
  }

  homeSnapshot(userId) {
    return { ...this.homeCoreSnapshot(userId), ...this.homeRelationsSnapshot(userId) };
  }

  query(table, url, rangeHeader = '', sourceRows = this.all(table)) {
    const ignored = new Set(['select', 'order', 'limit', 'offset']);
    let rows = sourceRows.filter(row => [...url.searchParams].every(([key, value]) => ignored.has(key) || matches(row, key, value)));
    const order = url.searchParams.get('order');
    if (order) {
      const clauses = order.split(',').map(value => { const [field, direction = 'asc'] = value.split('.'); return { field, direction }; });
      rows.sort((a, b) => { for (const { field, direction } of clauses) { const cmp = String(a[field] ?? '').localeCompare(String(b[field] ?? '')); if (cmp) return direction === 'desc' ? -cmp : cmp; } return 0; });
    }
    const offset = Number(url.searchParams.get('offset') || 0);
    let limit = Number(url.searchParams.get('limit') || 0);
    const range = /^(\d+)-(\d+)$/.exec(rangeHeader || '');
    if (range) { rows = rows.slice(Number(range[1]), Number(range[2]) + 1); }
    else { if (offset) rows = rows.slice(offset); if (limit) rows = rows.slice(0, limit); }
    return rows.map(row => project(row, url.searchParams.get('select')));
  }

  mutate(table, method, url, body, userId, prefer = '', rangeHeader = '') {
    if (['order_issues', 'order_issue_reads'].includes(table)) throw Object.assign(Error('问题记录只能通过订单问题接口访问'), { status: 403 });
    if (RETIRED_FEATURE_TABLES.has(table)) throw Object.assign(Error('该历史功能已停用'), { status: 403 });
    if (method === 'GET') return this.query(table, url, rangeHeader, this.visibleRows(table, userId));
    const follower = this.isFollower(userId);
    const supervisor = this.isSupervisor(userId);
    const resourceEditor = table === 'internal_resource_tables' && this.internalResourcePermissions(userId).can_edit;
    if (method !== 'GET' && table === 'internal_resource_tables' && !resourceEditor) throw Object.assign(Error('没有修改权限'), { status: 403 });
    if (method !== 'GET' && !follower && !resourceEditor && !(table === 'profiles' && supervisor)) throw Object.assign(Error('没有修改权限'), { status: 403 });
    if (method !== 'GET' && table === 'profiles' && !supervisor) throw Object.assign(Error('仅主管可以修改账号权限'), { status: 403 });
    if (method === 'POST') {
      const input = Array.isArray(body) ? body : [body];
      const created = input.map(value => {
        const row = { ...value };
        if (!row.id && !['app_settings', 'internal_resource_tables'].includes(table)) row.id = randomUUID();
        if (!row.created_at) row.created_at = now();
        if (table === 'orders') {
          if (!row.created_by) row.created_by = userId;
          Object.assign(row, this.normalizeOrderOwner(this.normalizeOrderDestination(row, userId), value));
        }
        if (table === 'order_images' && !row.uploaded_by) row.uploaded_by = userId;
        return this.put(table, row);
      });
      return created;
    }
    // Mutations must operate on complete matched records. A projected row may
    // omit its identity, and unrelated absent keys must never compare equal.
    const mutationUrl = new URL(url);
    mutationUrl.searchParams.delete('select');
    let matchesRows = this.query(table, mutationUrl);
    if (method === 'PATCH') return matchesRows.map(row => {
      let next = { ...row, ...body };
      if (table === 'orders') next = this.normalizeOrderOwner(this.normalizeOrderDestination(next, userId, row), body);
      return project(this.put(table, next), url.searchParams.get('select'));
    });
    if (method === 'DELETE') { this.remove(table, matchesRows.map(row => row.id ?? row.key ?? row.resource_key)); return matchesRows.map(row => project(row, url.searchParams.get('select'))); }
    return matchesRows;
  }

  normalizeOrderDestination(row, userId, previous = null) {
    const destination = classifyDestination(row.destination_country);
    if (!destination.input) return row;
    if (destination.mainstream) return {
      ...row,
      destination_country: destination.canonical,
      destination_risk: 'mainstream',
      destination_risk_acknowledged: false,
      destination_risk_acknowledged_at: null,
      destination_risk_acknowledged_by: null
    };
    const acknowledged = row.destination_risk_acknowledged === true || String(row.destination_risk_acknowledged) === 'true';
    if (!acknowledged) throw Object.assign(Error('该目的地属于非主流地址，请核查运费、关税和清关信息并确认'), { status: 400 });
    const sameAcknowledgement = previous?.destination_risk_acknowledged === true &&
      normalizeDestination(previous.destination_country) === normalizeDestination(destination.input);
    return {
      ...row,
      destination_country: destination.input,
      destination_risk: 'non_mainstream',
      destination_risk_acknowledged: true,
      destination_risk_acknowledged_at: sameAcknowledgement ? previous.destination_risk_acknowledged_at : now(),
      destination_risk_acknowledged_by: sameAcknowledgement ? previous.destination_risk_acknowledged_by : this.accountById(userId)?.email || userId
    };
  }

  importRows(table, rows) {
    if (!TABLES.includes(table)) throw Error('不支持的数据表');
    this.db.exec('begin immediate');
    try {
      rows.forEach(row => {
        const id = String(row.id ?? row.key ?? row.resource_key);
        const existingRaw = this.db.prepare('select data from records where table_name=? and record_id=?').get(table, id)?.data;
        const existing = existingRaw ? JSON.parse(existingRaw) : null;
        const stamp = value => String(value?.updated_at || value?.completed_at || value?.created_at || '');
        if (!existing || stamp(row) >= stamp(existing)) this.put(table, row);
      });
      this.db.exec('commit');
    }
    catch (error) { this.db.exec('rollback'); throw error; }
  }
}

export function isPublicRequest(pathname) {
  return pathname.startsWith('/auth/v1/') || [...PUBLIC_RPC].some(name => pathname.endsWith(`/rpc/${name}`));
}

// Keep the public response aligned with supabase-customer-tracking.sql.
const ORDER_FIELDS = ['order_no', 'business_name', 'current_step', 'step_started_at', 'step_deadline', 'order_date', 'shipping_mode', 'sea_region', 'overseas_method', 'forwarder_name', 'tracking_no', 'blower_tracking_no', 'split_shipping'];
const SHIPMENT_FIELDS = ['batch_name', 'quantity', 'shipping_mode', 'forwarder_name', 'sea_region', 'overseas_method', 'tracking_no', 'ocean_tracking_no', 'last_mile_tracking_no', 'blower_tracking_no', 'current_step', 'step_started_at', 'step_deadline', 'shipped_at', 'completed_at'];
const pick = (row, fields) => Object.fromEntries(fields.map(field => [field, row[field] ?? null]));
const compare = (fields) => (a, b) => {
  for (const field of fields) {
    const result = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
    if (result) return result;
  }
  return 0;
};
const eventsFor = (rows) => rows.sort(compare(['started_at', 'created_at', 'id'])).map(row => ({
  ...pick(row, ['step_key', 'started_at', 'deadline_at', 'completed_at']),
  tracking_no: String(row.note || '').startsWith('tracking:') ? row.note.slice(9) : null
}));

export function lookupCustomerTracking(store, value) {
  const email = String(value ?? '').trim().toLowerCase();
  if (email.length < 5 || email.length > 254 || email.indexOf('@') <= 0) return { found: false };
  const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/g;
  const matches = store.all('orders').filter(row => !row.deleted_at &&
    (String(row.customer_info || '').toLowerCase().match(emailPattern) || []).includes(email));
  matches.sort((a, b) => compare(['order_date', 'created_at'])(b, a));
  const order = matches[0];
  if (!order) return { found: false };
  const shipmentEvents = store.all('order_shipment_events');
  return {
    found: true,
    order: {
      ...pick(order, ORDER_FIELDS),
      customer_info: String(order.customer_info || '').replace(/\+?[0-9][0-9\s().-]{6,}[0-9]/g, ' ')
    },
    events: eventsFor(store.all('order_events').filter(row => row.order_id === order.id)),
    shipments: store.all('order_shipments').filter(row => row.order_id === order.id)
      .sort(compare(['created_at', 'id'])).map(row => ({
        ...pick(row, SHIPMENT_FIELDS),
        events: eventsFor(shipmentEvents.filter(event => event.shipment_id === row.id))
      }))
  };
}
