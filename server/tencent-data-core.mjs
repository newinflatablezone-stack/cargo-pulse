import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const TABLES = [
  'profiles', 'app_settings', 'partners', 'orders', 'order_events', 'order_images',
  'order_factories', 'order_shipments', 'order_shipment_events', 'internal_resource_tables'
];

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
    this.db.exec(`
      pragma journal_mode=WAL;
      pragma synchronous=NORMAL;
      pragma foreign_keys=ON;
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
    return this.db.prepare('select data from records where table_name=?').all(table).map(({ data }) => JSON.parse(data));
  }

  put(table, row) {
    const next = { ...row };
    if (!next.id && table !== 'app_settings' && table !== 'internal_resource_tables') next.id = randomUUID();
    const id = String(next.id ?? next.key ?? next.resource_key);
    if (!id || id === 'undefined') throw Error(`缺少 ${table} 主键`);
    this.db.prepare('insert into records(table_name,record_id,data) values(?,?,?) on conflict(table_name,record_id) do update set data=excluded.data')
      .run(table, id, json(next));
    return next;
  }

  remove(table, ids) {
    const del = this.db.prepare('delete from records where table_name=? and record_id=?');
    this.db.exec('begin immediate');
    try { ids.forEach(id => del.run(table, String(id))); this.db.exec('commit'); }
    catch (error) { this.db.exec('rollback'); throw error; }
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
    return row ? this.accountById(row.user_id) : null;
  }

  revokeUserSessions(userId) { this.db.prepare('delete from sessions where user_id=?').run(userId); }

  login(email, password) {
    const account = this.accountByEmail(email);
    if (!account || !passwordMatches(password, account.password_hash)) return null;
    return this.issueSession(account);
  }

  refresh(refreshToken) {
    const account = this.session(refreshToken, 'refresh');
    if (!account) return null;
    this.db.prepare('delete from sessions where token_hash=?').run(tokenHash(refreshToken));
    return this.issueSession(account);
  }

  profile(userId) { return this.all('profiles').find(row => row.id === userId); }
  isFollower(userId) { return this.profile(userId)?.role === 'follower'; }
  isSupervisor(userId) { return this.accountById(userId)?.email?.toLowerCase() === SUPERVISOR_EMAIL; }

  homeSnapshot(userId) {
    const supervisor = this.isSupervisor(userId);
    return {
      profile: this.profile(userId) || null,
      orders: this.all('orders').filter(row => supervisor || !row.deleted_at),
      profiles: this.all('profiles'),
      partners: this.all('partners').filter(row => row.active !== false),
      images: this.all('order_images').filter(row => String(row.object_path || '').includes('/delivery-proof-')),
      tracking_events: this.all('order_events').filter(row => String(row.note || '').startsWith('tracking:')),
      active_events: this.all('order_events').filter(row => !row.completed_at),
      factories: this.all('order_factories'),
      shipments: this.all('order_shipments')
    };
  }

  query(table, url, rangeHeader = '') {
    const ignored = new Set(['select', 'order', 'limit', 'offset']);
    let rows = this.all(table).filter(row => [...url.searchParams].every(([key, value]) => ignored.has(key) || matches(row, key, value)));
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

  mutate(table, method, url, body, userId, prefer = '') {
    const follower = this.isFollower(userId);
    const supervisor = this.isSupervisor(userId);
    if (method !== 'GET' && !follower && !(table === 'profiles' && supervisor)) throw Object.assign(Error('没有修改权限'), { status: 403 });
    if (method !== 'GET' && table === 'profiles' && !supervisor) throw Object.assign(Error('仅主管可以修改账号权限'), { status: 403 });
    if (method === 'POST') {
      const input = Array.isArray(body) ? body : [body];
      const created = input.map(value => {
        const row = { ...value };
        if (!row.id && !['app_settings', 'internal_resource_tables'].includes(table)) row.id = randomUUID();
        if (!row.created_at) row.created_at = now();
        if (table === 'orders' && !row.created_by) row.created_by = userId;
        if (table === 'order_images' && !row.uploaded_by) row.uploaded_by = userId;
        return this.put(table, row);
      });
      return created;
    }
    let matchesRows = this.query(table, url);
    if (method === 'GET' && table === 'orders' && !supervisor) matchesRows = matchesRows.filter(row => !row.deleted_at);
    if (method === 'PATCH') return matchesRows.map(row => this.put(table, { ...this.all(table).find(item => item.id === row.id || item.key === row.key || item.resource_key === row.resource_key), ...body }));
    if (method === 'DELETE') { this.remove(table, matchesRows.map(row => row.id ?? row.key ?? row.resource_key)); return matchesRows; }
    return matchesRows;
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
