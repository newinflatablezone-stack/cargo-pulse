import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Keep the data service self-contained: the live deployer copies this file
// into the runtime and does not copy newly added helper modules. The browser
// copy lives in server/customer-info.mjs and must stay behavior-identical.
function customerEmailPattern() {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
}
function customerPhonePattern() {
  return /(?:\+|00)?\d[\d\s().-]{5,}\d/g;
}
export function extractCustomerContacts(value) {
  const text = String(value || '');
  const emails = [...new Set((text.match(customerEmailPattern()) || []).map(item => item.toLowerCase()))];
  const phones = new Set();
  for (const raw of text.match(customerPhonePattern()) || []) {
    let digits = raw.replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.length < 7 || digits.length > 15) continue;
    phones.add(digits);
    if (digits.length === 13 && digits.startsWith('86')) phones.add(digits.slice(2));
    if (digits.length === 11 && digits.startsWith('1')) phones.add(digits.slice(1));
  }
  return { emails, phones: [...phones] };
}
const CUSTOMER_STREET = /\b(?:st|street|rd|ave|road|blvd|dr|drive|lane|apt|unit|zip)\b|po\s*box|路|街|道|号|巷|弄|区|市|省|县|镇|村|大厦|室|座/i;
function customerAddressRemainder(value) {
  return String(value || '').replace(customerEmailPattern(), ' ').replace(customerPhonePattern(), ' ').replace(/\s+/g, ' ').trim();
}
export function customerInfoReminder(value) {
  const contact = extractCustomerContacts(value);
  const remainder = customerAddressRemainder(value);
  const address = remainder.length >= 4 && (/\d/.test(remainder) || /[\u3400-\u9fff]/.test(remainder) || CUSTOMER_STREET.test(remainder));
  const missing = [];
  if (!address) missing.push('地址');
  if (!contact.emails.length) missing.push('邮箱');
  if (!contact.phones.length) missing.push('电话');
  return missing.length ? `客户信息还缺少：${missing.join('、')}` : '';
}

// Browser copy lives in product-name.mjs and must stay behavior-identical.
// The live deployer installs this core file directly and does not copy that module.
const PRODUCT_NAME_HAN_ONLY = /^[\u3400-\u9fff\s]+$/;
export const PRODUCT_NAME_RULE = '产品名称必须为中文';
export function productNameReminder(value) {
  const name = String(value ?? '').trim();
  if (!PRODUCT_NAME_HAN_ONLY.test(name)) return PRODUCT_NAME_RULE;
  return '';
}

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
  'shopify_order_intake', 'order_factories', 'order_shipments', 'order_shipment_events', 'internal_resource_tables',
  'tickets', 'ticket_messages', 'ticket_attachments', 'ticket_history',
  'ticket_notifications', 'ticket_reminder_logs', 'push_subscriptions', 'push_delivery_logs'
];

// Retain historical rows for backup/recovery, but expose no application API.
const RETIRED_FEATURE_TABLES = new Set(['tickets', 'ticket_messages', 'ticket_attachments', 'ticket_history', 'ticket_notifications', 'ticket_reminder_logs', 'push_subscriptions', 'push_delivery_logs']);

const PUBLIC_RPC = new Set(['lookup_customer_tracking']);
const SUPERVISOR_EMAIL = '505863160@qq.com';
const orderNumberKey = value => String(value || '').trim().replace(/^#\s*/, '').toLowerCase();
// Beijing time 2026-11-21 00:00. General sync stays on this instant.
// #9050 was created at 2026-11-20T15:55:03Z, five minutes earlier, and is the
// only order pulled in addition to the window.
export const SHOPIFY_IMPORT_START = '2026-11-20T16:00:00Z';
export const SHOPIFY_EXPLICIT_ORDER_NUMBERS = ['9050'];

export function shopifySyncEligible(order) {
  const number = orderNumberKey(order?.name ?? order?.order_no);
  if (SHOPIFY_EXPLICIT_ORDER_NUMBERS.includes(number)) return true;
  const created = Date.parse(order?.createdAt);
  return Number.isFinite(created) && created >= Date.parse(SHOPIFY_IMPORT_START);
}
const SALES_SUPPLEMENT = 'sales_supplement';
const FOLLOWER_CREATE = 'follower_create';
const BUILTIN_FOLLOWER_FACTORIES = new Set(['库存', '海外仓']);
const SALESPERSON_DRAFT = 'salesperson_draft';
const SALESPERSON_NAMES = ['Ella', 'Sherry', 'Demi', 'Rayna'];
const SALES_SHIPPING = new Set(['domestic_sea', 'domestic_express', 'other']);
const ORDER_SHIPPING_MODES = new Set(['domestic_sea', 'domestic_express', 'domestic_sea_port', 'air_freight', 'overseas_warehouse']);
const present = value => Array.isArray(value) ? value.length > 0 : typeof value === 'number' ? Number.isFinite(value) : value != null && String(value).trim() !== '';
const httpsUrls = value => {
  const list = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  const urls = [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))];
  if (urls.length > 100 || urls.some(url => { try { return new URL(url).protocol !== 'https:'; } catch { return true; } })) return null;
  return urls;
};

function productOrderSummary(products) {
  const joined = key => [...new Set(products.map(product=>product[key]).filter(Boolean))].join(' / ');
  const quantity = products.reduce((sum,product)=>sum+(product.quantity || 0),0);
  return {
    products, product_name:joined('product_name'), size:joined('size'), quantity:quantity || null,
    blower:joined('blower'), shopify_image_urls:[...new Set(products.flatMap(product=>product.image_urls || []))]
  };
}

export function shopifyLineSummary(items) {
  const names = [];
  let quantity = 0;
  let counted = false;
  for (const item of Array.isArray(items) ? items : []) {
    const name = String(item?.name || '').trim();
    if (name && !names.includes(name)) names.push(name);
    if (Number.isSafeInteger(item?.quantity) && item.quantity > 0) {
      quantity += item.quantity;
      counted = true;
    }
  }
  return { product_name: names.join(' / '), quantity: counted && Number.isSafeInteger(quantity) ? quantity : null };
}

export function shopifyShippingChoice(text) {
  const value = String(text || '');
  // Whole words, so "overseas" or "season" is not 海运. Both words together,
  // such as "Sea Express", stay empty instead of inventing another mode.
  const sea = /\bsea\b/i.test(value), express = /\bexpress\b/i.test(value);
  if (sea === express) return '';
  return sea ? 'domestic_sea' : 'domestic_express';
}

const BLOWER_WORD = /\bblower\b|风机/i;
const PUMP_WORD = /\bpump\b|气泵/i;

function equipmentKinds(text) {
  const value = String(text || '');
  const kinds = [];
  if (BLOWER_WORD.test(value)) kinds.push('blower');
  if (PUMP_WORD.test(value)) kinds.push('pump');
  return kinds;
}

function equipmentExcluded(text, kind) {
  const word = kind === 'blower' ? '(?:blower|风机)' : '(?:pump|气泵)';
  const value = String(text || '');
  return new RegExp(`\\b(?:without|no|not)\\b[\\s\\S]{0,40}${word}`, 'i').test(value)
    || new RegExp(`(?:不包含|不含有|不含|不带|不包|没有|无)\\s*${kind === 'blower' ? '风机' : '气泵'}`).test(value);
}

export const BLOWER_OPTIONS = ['包风机', '包气泵', '不包风机', '不包气泵'];
const BLOWER_ALIASES = { '风机': '包风机', '气泵': '包气泵' };

// A custom salesperson order number is invalid when, after trim and after
// removing one leading "#", only digits remain. 9052 and #9052 are both
// rejected. Shopify's 后台订单号 does not use this rule.
export const CUSTOM_ORDER_NUMBER_RULE = '不能是纯数字，也不能是纯 # 加数字';

export function isPurelyNumericOrderNumber(value) {
  return /^\d+$/.test(String(value ?? '').trim().replace(/^#/, ''));
}

export function normalizeBlowerChoice(value) {
  const text = String(value || '').trim();
  if (BLOWER_OPTIONS.includes(text)) return text;
  return BLOWER_ALIASES[text] || '';
}

export function shopifyBlowerChoice(text) {
  const kinds = equipmentKinds(text);
  // One order field cannot represent both a blower and a pump.
  if (kinds.length !== 1) return '';
  const excluded = equipmentExcluded(text, kinds[0]);
  if (kinds[0] === 'blower') return excluded ? '不包风机' : '包风机';
  return excluded ? '不包气泵' : '包气泵';
}

function optionLabel(option) {
  return [option?.name, option?.value].map(part => String(part || '').trim()).filter(Boolean).join(' ');
}

// Checkout shipping is often only "Free Shipping". Sea/express and blower/pump
// are read from the line-item name and variantTitle, which order access can
// already see. selectedOptions are used only when a caller already has them.
export function shopifyVariantChoices(order, items = []) {
  const shippingParts = [];
  const equipmentParts = [];
  const lines = order?.shippingLines?.nodes || order?.shipping_lines || [];
  for (const line of lines) shippingParts.push([line?.title, line?.code].filter(Boolean).join(' '));
  for (const item of items || []) {
    const options = item?.variant?.selectedOptions || item?.selectedOptions || [];
    for (const option of options) {
      const text = optionLabel(option);
      if (/ship|运输|freight|delivery/i.test(String(option?.name || ''))) shippingParts.push(text);
      if (equipmentKinds(text).length) equipmentParts.push(text);
    }
    const title = [item?.variantTitle, item?.variant?.title, item?.name].map(part => String(part || '').trim()).filter(Boolean).join(' ');
    if (/\bsea\b|\bexpress\b/i.test(title)) shippingParts.push(title);
    if (equipmentKinds(title).length) equipmentParts.push(title);
  }
  const blowers = [...new Set(equipmentParts.map(part => shopifyBlowerChoice(part)).filter(Boolean))];
  return {
    shipping_mode: shopifyShippingChoice(shippingParts.join('\n')),
    blower: blowers.length === 1 ? blowers[0] : ''
  };
}

export function shopifyGraphqlErrorDetail(errors) {
  const list = Array.isArray(errors) ? errors : [];
  return list.slice(0, 5).map(error => {
    const code = typeof error?.extensions?.code === 'string' ? error.extensions.code : '';
    const path = Array.isArray(error?.path) ? error.path.map(part => String(part)).join('.') : '';
    const message = String(error?.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return [code, path, message].filter(Boolean).join(' ');
  }).filter(Boolean).join('; ');
}

export function shopifyCustomerInfo(parts = {}) {
  return ['name', 'address', 'email', 'phone'].map(key => String(parts[key] || '').trim()).filter(Boolean).join('\n');
}

// China Standard Time, UTC+8. Asia/Shanghai does not observe daylight saving.
export function beijingOrderDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

// Weekly reports stay in this file. The live deployer copies tencent-data-core.mjs
// and would crash if this module imported a new helper that it does not install.
const WEEKLY_REPORTS = 'weekly_reports';
// Kept out of TABLES on purpose. visibleRows() would otherwise hand every
// account every other account's notifications. Read and write go through
// userNotifications() and createNotifications().
const USER_NOTIFICATIONS = 'user_notifications';
const WEEKLY_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKLY_NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
export const EMPTY_WEEKLY_REPORT_MESSAGE = '请先填写周报内容，再保存';

function weeklyCalendarUtc(iso) {
  if (!WEEKLY_DATE.test(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return utc;
}

export function addCalendarDays(iso, days) {
  const utc = weeklyCalendarUtc(iso);
  if (!utc || !Number.isInteger(days)) return '';
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

// Beijing weeks run Thursday through Wednesday. week_start is the Thursday.
export function beijingWeekRange(value = new Date()) {
  const today = typeof value === 'string' ? value : beijingOrderDate(value);
  const utc = weeklyCalendarUtc(today);
  if (!utc) throw Object.assign(Error('日期无效'), { status: 400 });
  const weekStart = addCalendarDays(today, -((utc.getUTCDay() + 7 - 4) % 7));
  return { week_start: weekStart, week_end: addCalendarDays(weekStart, 6) };
}

function weeklyThursday(iso) {
  const utc = weeklyCalendarUtc(iso);
  if (!utc || utc.getUTCDay() !== 4) throw Object.assign(Error('周报周期必须是北京时间周四至周三，week_start 请填周四'), { status: 400 });
  return { week_start: iso, week_end: addCalendarDays(iso, 6) };
}

function parseWeeklyStoredNumber(value, integer, label) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!WEEKLY_NUMBER.test(text) || text.length > 16) throw Object.assign(Error(`请填写有效的${label}`), { status: 400 });
  if (integer && text.includes('.')) throw Object.assign(Error(`${label}请填写整数`), { status: 400 });
  return text.includes('.') ? text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : text;
}

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

  issueAiReadKey(userId) {
    const key = 'cp_read_' + randomBytes(32).toString('base64url');
    const keyId = tokenHash(key);
    const expiresAt = Math.floor(Date.now() / 1000) + 30 * 86400;
    this.db.prepare('insert into sessions(token_hash,user_id,kind,expires_at) values(?,?,?,?)')
      .run(keyId, userId, 'ai_read', expiresAt);
    return { key, key_id: keyId, expires_at: new Date(expiresAt * 1000).toISOString() };
  }

  aiReadKeys(userId) {
    return this.db.prepare("select token_hash as key_id, expires_at from sessions where user_id=? and kind='ai_read' and expires_at>? order by expires_at")
      .all(userId, Math.floor(Date.now() / 1000))
      .map(row => ({ ...row, expires_at: new Date(row.expires_at * 1000).toISOString() }));
  }

  revokeAiReadKey(userId, keyId) {
    this.db.prepare("delete from sessions where user_id=? and kind='ai_read' and token_hash=?").run(userId, keyId);
  }

  aiReadPage(table, after, limit) {
    const rows = this.db.prepare('select record_id, data from records where table_name=? and record_id>? order by record_id limit ?')
      .all(table, after, limit + 1);
    return {
      data: rows.slice(0, limit).map(row => JSON.parse(row.data)),
      next_cursor: rows.length > limit ? rows[limit - 1].record_id : null
    };
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

  canEditSalespersonProductImages(userId, order) {
    const actor = this.profile(userId);
    if (!actor || actor.disabled_at || actor.role !== 'business') return false;
    if (!order || order.deleted_at) return false;
    if (order.current_step === SALES_SUPPLEMENT && order.shopify_order_id) return true;
    if (order.current_step === SALESPERSON_DRAFT && order.salesperson_draft === true && order.created_by === userId) return true;
    return this.ownsOrder(userId, order) && this.salespersonCanRevise(order);
  }

  canUploadShopifyProductImage(userId, objectPath) {
    const path = String(objectPath || '');
    const orderId = /^([^/]+)\/product-image-[A-Za-z0-9._-]+$/.exec(path)?.[1];
    if (!orderId) return false;
    return this.canEditSalespersonProductImages(userId, this.all('orders').find(row => row.id === orderId));
  }

  shopifyProductImagePost(userId, body) {
    const rows = Array.isArray(body) ? body : [body];
    return rows.length > 0 && rows.every(row => {
      const path = String(row?.object_path || '');
      return this.canUploadShopifyProductImage(userId, path) && String(row?.order_id || '') === path.split('/')[0];
    });
  }

  canReadOrder(userId, order) {
    if (!userId || !order || (order.deleted_at && !this.isSupervisor(userId))) return false;
    // An unsubmitted 新建下单 draft is not an order yet.
    if (order.current_step === SALESPERSON_DRAFT) return false;
    if (this.canReadAllOrders(userId) || this.ownsOrder(userId, order)) return true;
    // Manual 新建下单 waits at 待跟单创建订单 where every active account can see it.
    // Shopify orders at the same step keep ordinary salesperson ownership.
    if (order.current_step === FOLLOWER_CREATE && order.salesperson_shared === true && !order.shopify_order_id) {
      const actor = this.profile(userId);
      return Boolean(actor && !actor.disabled_at);
    }
    // Only the pre-salesperson stage is visible to every active account.
    // After 下单, normal salesperson ownership applies again.
    if (order.current_step !== SALES_SUPPLEMENT || !order.shopify_order_id) return false;
    const actor = this.profile(userId);
    return Boolean(actor && !actor.disabled_at);
  }

  preserveShopifyIdentity(next, previous = null) {
    delete next.shopify_shared;
    if (previous?.shopify_order_id) next.shopify_order_id = previous.shopify_order_id;
    else delete next.shopify_order_id;
    if (previous?.shopify_product_name) next.shopify_product_name = previous.shopify_product_name;
    else delete next.shopify_product_name;
    return next;
  }

  assertShopifyHandoffWritable(existing, body) {
    const locked = existing && [SALES_SUPPLEMENT, FOLLOWER_CREATE, SALESPERSON_DRAFT].includes(existing.current_step);
    const requested = body && [SALES_SUPPLEMENT, FOLLOWER_CREATE, SALESPERSON_DRAFT].includes(body.current_step);
    if (locked || requested) throw Object.assign(Error('请通过订单交接完成这一步'), { status: 403 });
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

  issueDisplayName(userId, historicalEmail = '', role = 'business') {
    const profile = this.profile(userId);
    const email = String(profile?.email || historicalEmail).trim().toLowerCase();
    const names = {
      'sales@inflatable-zone.com': 'Ella', 'sherry@inflatable-zone.com': 'Sherry',
      'demi@inflatable-zone.com': 'Demi', 'rayna@inflatable-zone.com': 'Rayna',
      '2548462886@qq.com': 'ICEY', '1544264271@qq.com': '秦枝',
      [SUPERVISOR_EMAIL]: '主管'
    };
    if (names[email]) return names[email];
    const name = [profile?.display_name, profile?.name, profile?.business_name]
      .find(value => typeof value === 'string' && value.trim() && !value.includes('@'));
    return name?.trim() || ((profile?.role || role) === 'follower' ? '跟单' : '业务员');
  }

  hasShopifyOrder(number) {
    const key = orderNumberKey(number);
    return !key || ['orders','shopify_order_intake'].some(table =>
      this.all(table).some(row => orderNumberKey(row.order_no) === key));
  }

  hasShopifyOrderId(id) {
    const sourceId = String(id || '');
    if (!sourceId) return false;
    return this.all('shopify_order_intake').some(row => row.id === sourceId) ||
      this.all('orders').some(row => row.shopify_order_id === sourceId || row.id === sourceId);
  }

  findShopifyOrder(number, id) {
    const key = orderNumberKey(number);
    const sourceId = String(id || '');
    return this.all('orders').find(order => (key && orderNumberKey(order.order_no) === key) || (sourceId && (order.shopify_order_id === sourceId || order.id === sourceId))) || null;
  }

  shopifyOrderNeedsRefresh(number, id, includeProducts = false) {
    const order = this.findShopifyOrder(number, id);
    if (order) {
      if (order.deleted_at || order.current_step !== SALES_SUPPLEMENT) return false;
      // One later pass fills 运输方式 and 风机/气泵 from variant options on
      // orders whose first import only saw "Free Shipping".
      return (includeProducts && !Array.isArray(order.products)) || !order.shopify_source_refreshed_at || !order.shopify_variant_mapped_at;
    }
    return Boolean(orderNumberKey(number) || String(id || ''));
  }

  readOrderProducts(order, input, fail) {
    if (input.products == null) return null;
    if (!Array.isArray(input.products) || !input.products.length || input.products.length > 100) fail('请添加 1 至 100 个产品');
    const imported = Boolean(order.shopify_order_id);
    const uploads = new Set(this.all('order_images').filter(image => image.order_id === order.id &&
      String(image.object_path || '').includes('/product-image-')).map(image => image.object_path));
    return input.products.map((item, index) => {
      if (!item || typeof item !== 'object') fail('产品资料无效');
      const value = key => typeof item[key] === 'string' ? item[key].trim() : '';
      const name = value('product_name'), size = value('size'), requirements = value('requirements');
      const quantity = item.quantity == null || item.quantity === '' ? null : Number(item.quantity);
      const blower = normalizeBlowerChoice(value('blower'));
      const imageUrls = httpsUrls(item.image_urls || []);
      const paths = item.image_paths || [];
      if (!imageUrls || !Array.isArray(paths) || paths.length > 100 || paths.some(path => !uploads.has(path))) fail('第 '+(index+1)+' 行图片无效');
      if ((name || !imported) && productNameReminder(name)) fail('第 '+(index+1)+' 行：'+PRODUCT_NAME_RULE);
      if ((quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 1)) ||
          (!imported && (quantity === null || !blower || (!imageUrls.length && !paths.length)))) fail('请补齐第 '+(index+1)+' 行的数量、风机／气泵和图片');
      if (value('blower') && !blower) fail('风机／气泵选项无效');
      return {product_name:name,size,quantity,requirements,blower,image_urls:imageUrls,image_paths:[...new Set(paths)]};
    });
  }

  shopifyDraft(row, timestamp = now()) {
    const quantity = Number(row?.quantity);
    const sourceImages = Array.isArray(row?.shopify_image_urls) ? row.shopify_image_urls : row?.image_urls;
    const images = httpsUrls((Array.isArray(sourceImages) ? sourceImages : []).filter(url => typeof url === 'string' && url.startsWith('https://'))) || [];
    const note = String(row?.abnormal_note || row?.requirements || '').trim();
    const country = classifyDestination(row?.destination_country || row?.country);
    return {
      order_no: String(row?.order_no || '').trim(),
      order_date: typeof row?.order_date === 'string' ? row.order_date : '',
      product_name: String(row?.product_name || '').trim(),
      shopify_product_name: String(row?.product_name || '').trim(),
      quantity: Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : null,
      size: String(row?.size || '').trim(),
      customer_info: String(row?.customer_info || '').trim(),
      requirements: note,
      abnormal_note: note,
      blower: normalizeBlowerChoice(row?.blower),
      shipping_mode: SALES_SHIPPING.has(row?.shipping_mode) ? row.shipping_mode : null,
      shopify_image_urls: images,
      ...(Array.isArray(row.products) && row.products.length ? {products:row.products} : {}),
      shopify_order_id: String(row?.shopify_order_id || row?.id || '') || null,
      destination_country: country.mainstream ? country.canonical : '',
      ...(country.mainstream ? { destination_risk: 'mainstream', destination_risk_acknowledged: false, destination_risk_acknowledged_at: null, destination_risk_acknowledged_by: null } : {}),
      business_id: null,
      business_user_id: null,
      business_name: '',
      created_by: null,
      inventory_mode: 'production',
      status: 'active',
      current_step: SALES_SUPPLEMENT,
      step_started_at: timestamp,
      step_deadline: null,
      created_at: timestamp,
      updated_at: timestamp
    };
  }

  applyLiveShopifyFields(order, draft) {
    const next = { ...order };
    for (const key of ['order_no', 'order_date', 'product_name', 'shopify_product_name', 'size', 'customer_info', 'requirements', 'abnormal_note', 'blower', 'shipping_mode', 'destination_country']) {
      if (present(draft[key])) next[key] = draft[key];
    }
    if (present(draft.quantity)) next.quantity = draft.quantity;
    if (Array.isArray(draft.products)) {
      const dismissed = new Set(order.dismissed_shopify_image_urls || []);
      next.products = draft.products.map(product=>({...product,image_urls:(product.image_urls||[]).filter(url=>!dismissed.has(url))}));
    }
    if (present(draft.shopify_image_urls)) {
      const dismissed = new Set((Array.isArray(order.dismissed_shopify_image_urls) ? order.dismissed_shopify_image_urls : []).filter(url => typeof url === 'string'));
      next.shopify_image_urls = dismissed.size ? draft.shopify_image_urls.filter(url => !dismissed.has(url)) : draft.shopify_image_urls;
    }
    if (draft.destination_risk === 'mainstream' && present(draft.destination_country)) {
      next.destination_risk = 'mainstream';
      next.destination_risk_acknowledged = false;
      next.destination_risk_acknowledged_at = null;
      next.destination_risk_acknowledged_by = null;
    }
    if (!next.shopify_order_id && draft.shopify_order_id) next.shopify_order_id = draft.shopify_order_id;
    return next;
  }

  closeOpenShopifyIntake(number, id, orderId, timestamp) {
    const key = orderNumberKey(number);
    const sourceId = String(id || '');
    for (const row of this.all('shopify_order_intake')) {
      if (row.submitted_at) continue;
      if (!((sourceId && row.id === sourceId) || (key && orderNumberKey(row.order_no) === key))) continue;
      this.put('shopify_order_intake', { ...row, submitted_at: timestamp, promoted_order_id: orderId });
    }
  }

  importShopifyOrder(row, options = {}) {
    const live = options.live !== false;
    this.db.exec('begin immediate');
    try {
      if (!row || !orderNumberKey(row.order_no)) {
        this.db.exec('commit');
        return null;
      }
      const existing = this.findShopifyOrder(row.order_no, row.shopify_order_id || row.id);
      const timestamp = now();
      if (existing) {
        if (existing.deleted_at || existing.current_step !== SALES_SUPPLEMENT) {
          this.db.exec('commit');
          return null;
        }
        const draft = this.shopifyDraft(row, timestamp);
        if (!existing.shopify_source_refreshed_at) {
          const next = this.applyLiveShopifyFields(existing, draft);
          next.updated_at = timestamp;
          if (live) {
            next.shopify_source_refreshed_at = timestamp;
            next.shopify_variant_mapped_at = timestamp;
          }
          const saved = this.put('orders', next);
          this.closeOpenShopifyIntake(saved.order_no, saved.shopify_order_id, saved.id, timestamp);
          this.db.exec('commit');
          return saved;
        }
        if (!existing.shopify_variant_mapped_at || (!existing.products && draft.products)) {
          const next = { ...existing, updated_at: timestamp };
          if (!existing.products && draft.products) {
            const dismissed = new Set(existing.dismissed_shopify_image_urls || []);
            next.products = draft.products.map(product=>({...product,image_urls:product.image_urls.filter(url=>!dismissed.has(url))}));
          }
          if (draft.shipping_mode) next.shipping_mode = draft.shipping_mode;
          if (draft.blower) next.blower = draft.blower;
          if (live) next.shopify_variant_mapped_at = timestamp;
          const saved = this.put('orders', next);
          this.db.exec('commit');
          return saved;
        }
        this.db.exec('commit');
        return null;
      }
      const draft = this.shopifyDraft(row, timestamp);
      if (live) {
        draft.shopify_source_refreshed_at = timestamp;
        draft.shopify_variant_mapped_at = timestamp;
      }
      const order = this.put('orders', draft);
      this.put('order_events', { order_id: order.id, step_key: SALES_SUPPLEMENT, started_at: timestamp, created_at: timestamp });
      this.closeOpenShopifyIntake(order.order_no, order.shopify_order_id, order.id, timestamp);
      this.db.exec('commit');
      return order;
    } catch (error) {
      this.db.exec('rollback');
      for (const table of ['orders', 'order_events', 'shopify_order_intake']) this.tableCache.delete(table);
      throw error;
    }
  }

  // Turns every intake row that was never submitted into 待业务员补充信息.
  // A claim no longer keeps the order off the salesperson list. Rows that
  // already have an orders record are only linked, not rewritten or deleted.
  promoteOpenShopifyIntake() {
    const result = { converted: [], already_present: [], skipped: [] };
    this.db.exec('begin immediate');
    try {
      const open = this.all('shopify_order_intake').filter(row => !row.submitted_at);
      for (const row of open) {
        const key = orderNumberKey(row.order_no);
        if (!key) {
          result.skipped.push({ id: row.id, reason: 'missing_order_no' });
          continue;
        }
        const existing = this.findShopifyOrder(row.order_no, row.id);
        const timestamp = now();
        if (existing) {
          this.put('shopify_order_intake', { ...row, submitted_at: timestamp, promoted_order_id: existing.id });
          result.already_present.push({ id: existing.id, order_no: existing.order_no, intake_id: row.id });
          continue;
        }
        const order = this.put('orders', this.shopifyDraft(row, timestamp));
        this.put('order_events', { order_id: order.id, step_key: SALES_SUPPLEMENT, started_at: timestamp, created_at: timestamp });
        this.put('shopify_order_intake', { ...row, submitted_at: timestamp, promoted_order_id: order.id });
        result.converted.push({ id: order.id, order_no: order.order_no, intake_id: row.id });
      }
      this.db.exec('commit');
      return result;
    } catch (error) {
      this.db.exec('rollback');
      for (const table of ['orders', 'order_events', 'shopify_order_intake']) this.tableCache.delete(table);
      throw error;
    }
  }

  salespersonOrder(userId, input = {}) {
    const profile = this.profile(userId);
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    if (!profile || profile.disabled_at) fail('请先登录', 401);
    if (profile.role !== 'business') fail('仅业务员可以新建下单', 403);
    if (input.action === 'draft') return this.draftSalespersonOrder(profile);
    if (input.action === 'discard') return this.discardSalespersonOrder(profile, input, fail);
    if (input.action === 'place') return this.placeSalespersonOrder(profile, input, fail);
    fail('不支持的操作');
  }

  draftSalespersonOrder(profile) {
    const timestamp = now();
    const saved = this.put('orders', {
      created_by: profile.id,
      current_step: SALESPERSON_DRAFT,
      salesperson_draft: true,
      status: 'active',
      inventory_mode: 'production',
      order_no: '',
      product_name: '',
      business_name: '',
      step_started_at: timestamp,
      step_deadline: null,
      created_at: timestamp,
      updated_at: timestamp
    });
    return { id: saved.id };
  }

  discardSalespersonOrder(profile, input, fail) {
    const order = this.all('orders').find(row => row.id === input.id);
    if (!order || order.deleted_at || order.current_step !== SALESPERSON_DRAFT || order.created_by !== profile.id) fail('草稿不存在', 404);
    this.remove('order_images', this.all('order_images').filter(row => row.order_id === order.id).map(row => row.id));
    this.remove('order_events', this.all('order_events').filter(row => row.order_id === order.id).map(row => row.id));
    this.remove('orders', [order.id]);
    return { id: order.id, discarded: true };
  }

  placeSalespersonOrder(profile, input, fail) {
    const order = this.all('orders').find(row => row.id === input.id);
    if (!order || order.deleted_at || order.current_step !== SALESPERSON_DRAFT || order.salesperson_draft !== true || order.created_by !== profile.id) fail('请重新打开新建下单', 409);
    const products = this.readOrderProducts(order,input,fail);
    const value = key => typeof input[key] === 'string' ? input[key].trim() : '';
    const orderNo = value('order_no');
    const product = value('product_name');
    const quantity = Number(input.quantity);
    const businessName = value('business_name');
    const shipping = value('shipping_mode');
    const blower = normalizeBlowerChoice(value('blower'));
    const customer = value('customer_info');
    const note = value('abnormal_note');
    const hasUploadedImage = this.all('order_images').some(row => row.order_id === order.id && String(row.object_path || '').includes('/product-image-'));
    if (isPurelyNumericOrderNumber(orderNo)) fail('自定义订单号' + CUSTOM_ORDER_NUMBER_RULE);
    if (customer && customerInfoReminder(customer)) fail(customerInfoReminder(customer), 400);
    const nameReminder = productNameReminder(product);
    if (!products && nameReminder) fail(nameReminder, 400);
    if (!orderNo || !orderNo.replace(/^#/, '') || (!products && (!product || !hasUploadedImage || !Number.isSafeInteger(quantity) || quantity < 1)) || !SALESPERSON_NAMES.includes(businessName) || !SALES_SHIPPING.has(shipping) || (!products && !blower) || !customer || !note) {
      fail('请补齐自定义订单号、产品名称、图片、数量、业务员、运输方式、包风机或包气泵、客户信息和订单备注');
    }
    if (this.all('orders').some(row => row.id !== order.id && orderNumberKey(row.order_no) === orderNumberKey(orderNo))) fail('订单号已存在', 409);
    const owners = this.businessOwnersForName(businessName);
    const timestamp = now();
    const next = {
      ...order,
      order_no: orderNo,
      product_name: product,
      quantity,
      size: value('size'),
      customer_info: customer,
      abnormal_note: note,
      requirements: note,
      blower,
      shipping_mode: shipping,
      business_name: businessName,
      business_id: owners.length === 1 ? owners[0].id : null,
      business_user_id: null,
      current_step: FOLLOWER_CREATE,
      salesperson_draft: false,
      salesperson_shared: true,
      step_started_at: timestamp,
      step_deadline: null,
      updated_at: timestamp,
      status: 'active',
      inventory_mode: 'production',
      created_by: profile.id
    };
    // 新建下单 matches salesperson 下单: it does not stamp 后台下单时间.
    delete next.order_date;
    delete next.shopify_order_id;
    delete next.shopify_shared;
    delete next.shopify_image_urls;
    if (products) Object.assign(next,productOrderSummary(products));
    this.db.exec('begin immediate');
    try {
      const saved = this.put('orders', next);
      for (const event of this.all('order_events').filter(row => row.order_id === order.id && !row.completed_at)) {
        this.put('order_events', { ...event, completed_at: timestamp, completed_by: profile.id });
      }
      this.put('order_events', { order_id: saved.id, step_key: FOLLOWER_CREATE, started_at: timestamp, created_at: timestamp });
      this.db.exec('commit');
      return { id: saved.id, current_step: saved.current_step };
    } catch (error) {
      this.db.exec('rollback');
      for (const table of ['orders', 'order_events']) this.tableCache.delete(table);
      throw error;
    }
  }

  shopifyHandoff(userId, input = {}) {
    const profile = this.profile(userId);
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    if (!profile || profile.disabled_at) fail('请先登录', 401);
    const order = this.all('orders').find(row => row.id === input.id);
    if (!order || order.deleted_at) fail('订单不存在', 404);
    if (input.action === 'assign_factory') return this.assignFollowerFactory(userId, order, input, fail);
    if (input.action === 'place') return this.placeShopifyOrder(profile, order, input, fail);
    if (input.action === 'create') return this.createShopifyOrder(userId, profile, order, input, fail);
    fail('不支持的操作');
  }

  assignFollowerFactory(userId, order, input, fail) {
    if (!this.isSupervisor(userId)) fail('仅主管可以选择并保存工厂', 403);
    if (order.current_step !== FOLLOWER_CREATE) fail('订单已不在待跟单创建订单', 409);
    const factory = typeof input.factory_name === 'string' ? input.factory_name.trim() : '';
    if (!factory || factory.length > 120) fail('请选择工厂', 400);
    const known = BUILTIN_FOLLOWER_FACTORIES.has(factory) || this.all('partners').some(partner => partner.kind === 'factory' && partner.active !== false && String(partner.name || '').trim() === factory);
    if (!known) fail('请选择已有工厂', 400);
    const saved = this.put('orders', { ...order, factory_name: factory, updated_at: now() });
    return { id: saved.id, factory_name: saved.factory_name, current_step: saved.current_step };
  }

  placeShopifyOrder(profile, order, input, fail) {
    if (profile.role !== 'business') fail('仅业务员可以下单', 403);
    if (order.current_step !== SALES_SUPPLEMENT) fail('订单已不在待业务员补充信息', 409);
    const products = this.readOrderProducts(order,input,fail);
    const value = key => typeof input[key] === 'string' ? input[key].trim() : '';
    const orderNo = value('order_no') || String(order.order_no || '').trim();
    const product = value('product_name');
    const quantity = Number(input.quantity);
    const businessName = value('business_name');
    const shipping = value('shipping_mode');
    const blower = normalizeBlowerChoice(value('blower'));
    const customer = value('customer_info');
    const note = value('abnormal_note');
    const suppliedImages = input.image_urls != null || input.shopify_image_urls != null;
    const urls = suppliedImages ? httpsUrls(input.image_urls ?? input.shopify_image_urls) : (httpsUrls(order.shopify_image_urls) || []);
    const hasUploadedImage = this.all('order_images').some(row => row.order_id === order.id && String(row.object_path || '').includes('/product-image-'));
    if (suppliedImages && urls === null) fail('图片地址须为 HTTPS 链接');
    if (customer && customerInfoReminder(customer)) fail(customerInfoReminder(customer), 400);
    const importedName = String(order.shopify_product_name || order.product_name || '').trim();
    const nameReminder = productNameReminder(product);
    if (!products && nameReminder) fail(nameReminder, 400);
    if (!orderNo || !SALESPERSON_NAMES.includes(businessName) || (products ? Boolean(shipping && !SALES_SHIPPING.has(shipping)) : (!product || !(urls?.length || hasUploadedImage) || !Number.isSafeInteger(quantity) || quantity < 1 || !SALES_SHIPPING.has(shipping) || !blower || !customer || !note))) {
      fail('请补齐订单号、产品名称、图片、数量、业务员、运输方式、包风机或包气泵、客户信息和订单备注');
    }
    if (this.all('orders').some(row => row.id !== order.id && orderNumberKey(row.order_no) === orderNumberKey(orderNo))) fail('订单号已存在', 409);
    const owners = this.businessOwnersForName(businessName);
    const timestamp = now();
    this.db.exec('begin immediate');
    try {
      const saved = this.put('orders', {
        ...order,
        order_no: orderNo,
        product_name: product,
        shopify_product_name: importedName,
        quantity,
        size: value('size') || order.size || '',
        customer_info: customer,
        abnormal_note: note,
        requirements: note,
        blower,
        shipping_mode: shipping,
        shopify_image_urls: urls || [],
        business_name: businessName,
        business_id: owners.length === 1 ? owners[0].id : null,
        business_user_id: null,
        current_step: FOLLOWER_CREATE,
        step_started_at: timestamp,
        step_deadline: null,
        updated_at: timestamp,
        ...(products ? productOrderSummary(products) : {})
      });
      for (const event of this.all('order_events').filter(row => row.order_id === order.id && !row.completed_at)) {
        this.put('order_events', { ...event, completed_at: timestamp, completed_by: profile.id });
      }
      this.put('order_events', { order_id: saved.id, step_key: FOLLOWER_CREATE, started_at: timestamp, created_at: timestamp });
      this.db.exec('commit');
      return { id: saved.id, current_step: saved.current_step };
    } catch (error) {
      this.db.exec('rollback');
      for (const table of ['orders', 'order_events']) this.tableCache.delete(table);
      throw error;
    }
  }

  createShopifyOrder(userId, profile, order, input, fail) {
    if (profile.role !== 'follower') fail('仅跟单可以创建订单', 403);
    if (order.current_step !== FOLLOWER_CREATE) fail('订单已不在待跟单创建订单', 409);
    const assignedFactory = String(order.factory_name || '').trim();
    if (!assignedFactory) fail('主管须先选择工厂并保存后，跟单才能创建订单。', 400);
    const value = key => typeof input[key] === 'string' ? input[key].trim() : '';
    const requestedFactory = value('factory_name');
    if (requestedFactory && requestedFactory !== assignedFactory) fail('工厂已由主管保存，不能在创建订单时修改', 400);
    const orderNo = value('order_no');
    const products = Array.isArray(order.products) && order.products.length ? order.products : null;
    const summary = products ? productOrderSummary(products) : null;
    const product = summary ? summary.product_name : value('product_name');
    const size = summary ? summary.size : value('size');
    const customer = value('customer_info');
    const businessName = value('business_name');
    const quantity = summary ? summary.quantity : Number(input.quantity);
    if (customer && customerInfoReminder(customer)) fail(customerInfoReminder(customer), 400);
    if (!orderNo || (!products && (!product || !size || !Number.isSafeInteger(quantity) || quantity < 1)) || !customer || !SALESPERSON_NAMES.includes(businessName) || !value('destination_country')) {
      fail('请按新建订单补齐订单号、产品名称、尺寸、数量、客户信息、目的国家和负责业务员');
    }
    if (this.all('orders').some(row => row.id !== order.id && orderNumberKey(row.order_no) === orderNumberKey(orderNo))) fail('订单号已存在', 409);
    const shipping = value('shipping_mode');
    if (shipping && shipping !== 'other' && !ORDER_SHIPPING_MODES.has(shipping)) fail('发货方式不正确');
    const inventory = value('inventory_mode') === 'stock' ? 'stock' : 'production';
    const needsRendering = input.needs_rendering === true || input.needs_rendering === 'true';
    const expectedStep = inventory === 'stock' ? 'shipping_selection' : needsRendering ? 'rendering' : 'production';
    if (input.current_step !== expectedStep) fail('下一阶段不正确，请刷新订单', 409);
    // Official 后台下单时间 is this click, in Beijing time. Shopify's created
    // date, the import date, and the salesperson 下单 click are not used.
    const timestamp = now();
    const orderDate = beijingOrderDate(new Date(timestamp));
    const stepDays = inventory === 'stock' ? 1 : needsRendering ? 3 : 10;
    const stepDeadline = new Date(Date.parse(timestamp) + stepDays * 86400000).toISOString();
    const names = [...new Set([assignedFactory, ...(Array.isArray(input.factory_names) ? input.factory_names : []), requestedFactory].map(name => String(name || '').trim()).filter(Boolean))];
    let next = {
      ...order,
      order_no: orderNo,
      order_date: orderDate,
      product_name: product,
      size,
      quantity,
      customer_info: customer,
      blower: summary ? summary.blower : value('blower'),
      requirements: value('requirements'),
      business_name: businessName,
      inventory_mode: inventory,
      needs_rendering: needsRendering,
      split_shipping: input.split_shipping === true || input.split_shipping === 'true',
      shipping_mode: !shipping || shipping === 'other' ? null : shipping,
      sea_region: value('sea_region') || null,
      overseas_method: value('overseas_method') || null,
      factory_name: names[0] || null,
      destination_country: value('destination_country'),
      destination_risk: input.destination_risk,
      destination_risk_acknowledged: input.destination_risk_acknowledged === true || input.destination_risk_acknowledged === 'true',
      destination_risk_acknowledged_at: input.destination_risk_acknowledged_at || null,
      destination_risk_acknowledged_by: input.destination_risk_acknowledged_by || null,
      current_step: expectedStep,
      step_started_at: timestamp,
      step_deadline: stepDeadline,
      created_by: userId,
      updated_at: timestamp,
      status: 'active'
    };
    if (Object.hasOwn(input, 'duty_prepaid')) {
      next.duty_prepaid = input.duty_prepaid === true || input.duty_prepaid === 'true';
      next.duty_prepaid_note = value('duty_prepaid_note') || null;
    }
    next = this.normalizeOrderOwner(this.normalizeOrderDestination(next, userId, order), { business_name: businessName });
    if (order.shopify_order_id) next.shopify_order_id = order.shopify_order_id;
    else delete next.shopify_order_id;
    if (order.shopify_image_urls) next.shopify_image_urls = order.shopify_image_urls;
    else delete next.shopify_image_urls;
    this.db.exec('begin immediate');
    try {
      const saved = this.put('orders', next);
      for (const event of this.all('order_events').filter(row => row.order_id === order.id && !row.completed_at)) {
        this.put('order_events', { ...event, completed_at: timestamp, completed_by: userId });
      }
      this.put('order_events', { order_id: saved.id, step_key: expectedStep, started_at: saved.step_started_at, deadline_at: saved.step_deadline, created_at: timestamp });
      if (inventory !== 'stock') {
        const active = expectedStep === 'production';
        for (const factory_name of names) {
          this.put('order_factories', { order_id: saved.id, factory_name, started_at: active ? saved.step_started_at : null, deadline_at: active ? saved.step_deadline : null });
        }
      }
      this.db.exec('commit');
      return { id: saved.id, current_step: saved.current_step };
    } catch (error) {
      this.db.exec('rollback');
      for (const table of ['orders', 'order_events', 'order_factories']) this.tableCache.delete(table);
      throw error;
    }
  }

  salespersonCanRevise(order) {
    return Boolean(order && !order.deleted_at && order.current_step !== SALES_SUPPLEMENT && order.current_step !== SALESPERSON_DRAFT);
  }

  // Removes one product image the salesperson can already add: an uploaded
  // /product-image- file, or one Shopify https URL. The order step is unchanged
  // and merchandisers are not notified. Dismissed Shopify URLs stay off the
  // order even when a later sales_supplement refresh sends them again.
  removeSalespersonProductImage(userId, input = {}) {
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    const profile = this.profile(userId);
    if (!profile || profile.disabled_at) fail('请先登录', 401);
    const order = this.all('orders').find(row => row.id === input.id);
    if (!order || order.deleted_at) fail('订单不存在', 404);
    if (!this.canEditSalespersonProductImages(userId, order)) fail('仅能删除自己可补充订单上的产品图片', 403);
    const objectPath = typeof input.object_path === 'string' ? input.object_path.trim() : '';
    const imageUrl = typeof input.image_url === 'string' ? input.image_url.trim() : '';
    if (Boolean(objectPath) === Boolean(imageUrl)) fail('请指定要删除的产品图片');
    if (objectPath) {
      if (!this.canUploadShopifyProductImage(userId, objectPath) || objectPath.split('/')[0] !== String(order.id)) fail('不能删除这张产品图片', 403);
      const rows = this.all('order_images').filter(row => row.order_id === order.id && row.object_path === objectPath && String(row.object_path).includes('/product-image-'));
      if (!rows.length) fail('图片不存在', 404);
      this.remove('order_images', rows.map(row => row.id));
      return { id: order.id, object_path: objectPath, removed: true };
    }
    let parsed;
    try { parsed = new URL(imageUrl); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:') fail('图片地址须为 HTTPS 链接');
    const urls = Array.isArray(order.shopify_image_urls) ? order.shopify_image_urls : [];
    const legacy = Array.isArray(order.image_urls) ? order.image_urls : [];
    if (!urls.includes(imageUrl) && !legacy.includes(imageUrl)) fail('图片不存在', 404);
    const dismissed = [...new Set([...(Array.isArray(order.dismissed_shopify_image_urls) ? order.dismissed_shopify_image_urls : []), imageUrl])];
    const next = {
      ...order,
      shopify_image_urls: urls.filter(url => url !== imageUrl),
      dismissed_shopify_image_urls: dismissed,
      updated_at: now()
    };
    if (Array.isArray(order.image_urls)) next.image_urls = legacy.filter(url => url !== imageUrl);
    const saved = this.put('orders', next);
    return { id: saved.id, image_url: imageUrl, shopify_image_urls: saved.shopify_image_urls, removed: true };
  }

  // The order's own salesperson can change the same fields they filled at 下单,
  // both while the order waits at 待跟单创建订单 and after 创建订单.
  updateSalespersonSupplement(userId, input = {}) {
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    const profile = this.profile(userId);
    if (!profile || profile.disabled_at) fail('请先登录', 401);
    const order = this.all('orders').find(row => row.id === input.id);
    if (!order || order.deleted_at) fail('订单不存在', 404);
    if (!this.salespersonCanRevise(order)) fail('请先完成下单', 409);
    if (profile.role !== 'business' || !this.ownsOrder(userId, order)) fail('仅订单业务员可以修改补充信息', 403);
    const products = this.readOrderProducts(order,input,fail);
    const value = key => typeof input[key] === 'string' ? input[key].trim() : '';
    const orderNo = value('order_no') || String(order.order_no || '').trim();
    const product = value('product_name');
    const quantity = Number(input.quantity);
    const businessName = value('business_name');
    const shipping = value('shipping_mode');
    const blower = normalizeBlowerChoice(value('blower'));
    const customer = value('customer_info');
    const note = value('abnormal_note');
    const shippingAllowed = SALES_SHIPPING.has(shipping) || (shipping && shipping === String(order.shipping_mode || '') && ORDER_SHIPPING_MODES.has(shipping));
    if (order.salesperson_shared === true && !order.shopify_order_id && isPurelyNumericOrderNumber(orderNo)) fail('自定义订单号' + CUSTOM_ORDER_NUMBER_RULE);
    if (customer && customerInfoReminder(customer)) fail(customerInfoReminder(customer), 400);
    const nameReminder = productNameReminder(product);
    if (!products && nameReminder) fail(nameReminder, 400);
    if (!orderNo || !SALESPERSON_NAMES.includes(businessName) || (products ? (order.shopify_order_id ? Boolean(shipping && !shippingAllowed) : (!shippingAllowed || !customer || !note)) : (!product || !Number.isSafeInteger(quantity) || quantity < 1 || !shippingAllowed || !blower || !customer || !note))) {
      fail('请补齐订单号、产品名称、数量、业务员、运输方式、包风机或包气泵、客户信息和订单备注');
    }
    if (this.all('orders').some(row => row.id !== order.id && orderNumberKey(row.order_no) === orderNumberKey(orderNo))) fail('订单号已存在', 409);
    const owners = this.businessOwnersForName(businessName);
    const timestamp = now();
    const next = {
      ...order,
      order_no: orderNo,
      product_name: product,
      quantity,
      size: value('size'),
      customer_info: customer,
      abnormal_note: note,
      blower,
      shipping_mode: shipping,
      business_name: businessName,
      business_id: owners.length === 1 ? owners[0].id : null,
      business_user_id: null,
      updated_at: timestamp
    };
    if (products) Object.assign(next,productOrderSummary(products));
    if (order.current_step === FOLLOWER_CREATE || order.requirements === order.abnormal_note) next.requirements = note;
    this.db.exec('begin immediate');
    try {
      const saved = this.put('orders', next);
      this.notifyOrderSupplement(saved, order);
      this.db.exec('commit');
      return { id: saved.id, current_step: saved.current_step };
    } catch (error) {
      this.db.exec('rollback');
      for (const table of ['orders', USER_NOTIFICATIONS]) this.tableCache.delete(table);
      throw error;
    }
  }

  // Salesperson 修改/补充信息 still notifies merchandisers. A changed 订单号 is
  // the same event, except the supervisor is not a recipient for that change.
  notifyOrderSupplement(order, previous = null) {
    const orderNumberChanged = previous != null && orderNumberKey(previous.order_no) !== orderNumberKey(order.order_no);
    const recipients = this.all('profiles').filter(row => row.role === 'follower' && !row.disabled_at && !(orderNumberChanged && this.isSupervisor(row.id))).map(row => row.id);
    if (!recipients.length) return { notifications: [] };
    const orderNo = String(order.order_no || '').trim() || '未编号';
    const title = '订单信息更新';
    const body = `订单 ${orderNo} 的补充信息已更新，请查看。`;
    const contact = extractCustomerContacts(order.customer_info);
    const leaked = contact.emails.some(email => body.toLowerCase().includes(email) || title.toLowerCase().includes(email))
      || contact.phones.some(phone => phone.length >= 7 && (body.includes(phone) || title.includes(phone)));
    if (leaked) throw Object.assign(Error('通知不能包含客户联系方式'), { status: 400 });
    return this.createNotifications({
      user_ids: recipients,
      title,
      body,
      kind: 'order_info_update',
      order_id: order.id
    });
  }

  shopifyIntake(userId, input) {
    const profile = this.profile(userId);
    const fail = (message, status = 400) => { throw Object.assign(Error(message), {status}); };
    if (profile?.role !== 'business' || profile.disabled_at) fail('仅业务员可以处理导入订单',403);
    const table = 'shopify_order_intake';
    const records = this.all(table);
    if (input.action === 'list') return {orders:records
      .filter(row=>!row.submitted_at && (!row.claimed_by || row.claimed_by === userId))
      .map(({claimed_by,...row})=>({...row,claimed:claimed_by===userId}))
      .sort((a,b)=>b.order_date.localeCompare(a.order_date))};
    if (!['claim','submit'].includes(input.action)) fail('不支持的操作');
    this.db.exec('begin immediate');
    try {
      const row = this.all(table).find(record=>record.id===input.id);
      if (!row || row.submitted_at || (row.claimed_by && row.claimed_by !== userId)) fail('订单已被其他业务员认领或提交',409);
      if (input.action === 'claim') {
        const claimed = this.put(table,{...row,claimed_by:userId});
        this.db.exec('commit');
        return {...claimed,claimed:true};
      }
      if (row.claimed_by !== userId) fail('请先认领订单',403);
      if (this.all('orders').some(order=>orderNumberKey(order.order_no)===orderNumberKey(row.order_no))) fail('订单号已存在',409);
      const value = key => typeof input[key]==='string' ? input[key].trim() : '';
      const orderDate=value('order_date'), quantity=Number(input.quantity);
      const shippingMode=value('shipping_mode'), blower=value('blower');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate) || !Number.isFinite(Date.parse(orderDate)) ||
        new Date(orderDate).toISOString().slice(0,10)!==orderDate || !Number.isSafeInteger(quantity) || quantity<1 ||
        !value('product_name') || !value('size') || !value('customer_info') ||
        !['包含','不包含'].includes(blower) || !['domestic_sea','domestic_express'].includes(shippingMode)) {
        fail('请补齐日期、产品名称、数量、尺寸、客户地址、风机和运输方式');
      }
      const urls=value('image_urls').split(/\s+/).filter(Boolean);
      if (urls.length>100 || urls.some(url=>{try{return new URL(url).protocol!=='https:'}catch{return true}})) fail('图片地址须为 HTTPS 链接');
      const timestamp=now();
      const order=this.put('orders',{
        order_no:row.order_no,order_date:orderDate,product_name:value('product_name'),quantity,size:value('size'),
        customer_info:value('customer_info'),requirements:value('requirements'),blower,shipping_mode:shippingMode,
        shopify_image_urls:[...new Set(urls)],created_by:userId,business_id:userId,
        business_name:this.issueDisplayName(userId,profile.email),created_at:timestamp,updated_at:timestamp,
        current_step:'business_placed',step_started_at:timestamp,step_deadline:null,inventory_mode:'production',status:'active'
      });
      this.put('order_events',{order_id:order.id,step_key:'business_placed',started_at:timestamp,created_at:timestamp});
      this.put(table,{...row,submitted_at:timestamp});
      this.db.exec('commit');
      return {id:order.id};
    } catch(error) {
      this.db.exec('rollback');
      for (const name of [table,'orders','order_events']) this.tableCache.delete(name);
      throw error;
    }
  }

  orderIssues(userId, input = {}) {
    const profile = this.profile(userId);
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    if (!profile) fail('请先登录', 401);
    const follower = this.isFollower(userId), action = input.action || 'summary';
    const orders = new Map(this.visibleRows('orders', userId).map(order => [order.id, order]));
    const visible = issue => orders.has(issue.order_id);
    const reads = new Map(this.all('order_issue_reads').filter(row => row.user_id === userId).map(row => [row.issue_id, row.sequence]));
    const decorate = issue => ({ ...issue, creator_name: this.issueDisplayName(issue.created_by, issue.creator_email), messages: issue.messages.map(message => ({ ...message, author_name: this.issueDisplayName(message.author_id, message.author_email, message.author_role) })), unread: (reads.get(issue.id) || 0) < issue.sequence && issue.messages.some(message => message.sequence > (reads.get(issue.id) || 0) && message.author_id !== userId), order_no: orders.get(issue.order_id)?.order_no || '', business_name: orders.get(issue.order_id)?.business_name || '', can_close: this.ownsOrder(userId, orders.get(issue.order_id)) && issue.status !== 'closed', can_reply: issue.status !== 'closed' && (follower || this.ownsOrder(userId, orders.get(issue.order_id))), can_remind: follower && issue.status === 'waiting_business' });
    const afterSales = input.category === 'after_sales';
    if (input.category && !afterSales) fail('不支持的问题分类');
    const all = this.all('order_issues').filter(issue => (issue.category === 'after_sales') === afterSales);
    if (action === 'eligible_orders' && afterSales) {
      const factories = [...new Set(this.all('partners')
        .filter(partner => partner.kind === 'factory' && partner.active !== false)
        .map(partner => String(partner.name || '').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
      return { factories, orders: [...orders.values()]
        .filter(order => this.issueCanCreate(userId, order))
        .sort((a, b) => String(b.order_date || '').localeCompare(String(a.order_date || '')))
        .map(order => ({ id: order.id, order_no: order.order_no, product_name: order.product_name })) };
    }
    if (action === 'summary') {
      const summaryRows = !afterSales && input.include_after_sales === true
        ? this.all('order_issues').filter(issue => issue.category !== 'after_sales' || issue.status !== 'closed')
        : all;
      const issues = summaryRows.filter(issue => visible(issue) && !orders.get(issue.order_id).deleted_at).map(decorate).filter(issue => afterSales || issue.status !== 'closed' || issue.unread).sort((a,b) => b.updated_at.localeCompare(a.updated_at));
      return { ...(afterSales ? { can_create: profile.role === 'business' } : {}), total: issues.filter(issue => issue.status !== 'closed').length, issues: issues.map(({ messages, ...issue }) => ({ ...issue, subject: messages[0]?.body || '', preview: messages.filter(message => message.kind === 'message').at(-1)?.body || '' })) };
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
      const id = userId + (afterSales ? ':after_sales:' : ':') + input.request_id, existing = all.find(issue => issue.id === id);
      if (existing) { if (!visible(existing)) fail('问题不存在或无权访问', 404); return decorate(existing); }
      const body = content();
      const factory = typeof input.factory === 'string' ? input.factory.trim() : '';
      if (afterSales && (!factory || factory.length > 120)) fail('请填写工厂名称，最多 120 字');
      const issue = { id, ...(afterSales ? { category: 'after_sales', factory } : {}), order_id: order.id, created_by: userId, creator_email: profile.email, status: 'waiting_follower', sequence: 1, created_at: timestamp, updated_at: timestamp, messages: [{ id: randomUUID(), sequence: 1, author_id: userId, author_email: profile.email, author_role: profile.role, kind: 'message', body, created_at: timestamp }] };
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
      status = 'closed'; kind = 'closed'; body = afterSales ? '业务员已确认售后解决' : '业务员已确认解决，结束问题';
    } else if (action === 'remind') {
      if (!follower || status !== 'waiting_business') fail('请先回复问题，再提醒业务员结束', 403);
      const previous = issue.messages.filter(message => message.kind === 'reminder').at(-1);
      if (previous && Date.now() - Date.parse(previous.created_at) < 60000) fail('提醒已发送，请稍后再试', 429);
      kind = 'reminder'; body = afterSales ? '售后如已解决，请点击“确认解决”；仍需处理请继续回复' : '问题如已解决，请点击“结束问题”；仍需处理请继续回复';
    } else fail('不支持的问题操作');
    const sequence = issue.sequence + 1;
    const updated = { ...issue, status, sequence, updated_at: timestamp, ...(status === 'closed' ? { closed_at: timestamp, closed_by: userId } : {}), messages: [...issue.messages, { id: randomUUID(), sequence, author_id: userId, author_email: profile.email, author_role: profile.role, kind, body, created_at: timestamp }] };
    this.put('order_issues', updated);
    return decorate(updated);
  }


  weeklyReportAccess(userId) {
    const profile = this.profile(userId);
    if (!profile || profile.disabled_at) return null;
    if (this.isSupervisor(userId)) return 'view';
    if (profile.role !== 'business') return null;
    if (this.isWeeklyReportElla(userId)) return 'view';
    return 'submit';
  }

  isWeeklyReportElla(userId) {
    const profile = this.profile(userId);
    const email = String(this.accountById(userId)?.email || profile?.email || '').trim().toLowerCase();
    const aliases = {
      'sales@inflatable-zone.com': 'Ella',
      'sherry@inflatable-zone.com': 'Sherry',
      'demi@inflatable-zone.com': 'Demi',
      'rayna@inflatable-zone.com': 'Rayna'
    };
    if (email === 'sales@inflatable-zone.com') return true;
    return [aliases[email], profile?.business_name, profile?.display_name, profile?.name]
      .filter(value => typeof value === 'string' && value.trim())
      .some(value => value.trim().toLowerCase() === 'ella');
  }

  weeklyReportView(row) {
    return {
      id: row.id,
      user_id: row.user_id,
      salesperson_name: row.salesperson_name || this.issueDisplayName(row.user_id),
      week_start: row.week_start,
      week_end: row.week_end,
      inquiries: row.inquiries ?? null,
      calls: row.calls ?? null,
      unpaid_orders: row.unpaid_orders ?? null,
      performance: row.performance ?? null,
      body: String(row.body || ''),
      note: String(row.note || ''),
      updated_at: row.updated_at || null
    };
  }

  listWeeklyReports(userId, access) {
    const visible = this.all(WEEKLY_REPORTS).filter(row => row?.week_start && (access === 'view' || row.user_id === userId));
    const reports = visible.map(row => this.weeklyReportView(row)).sort((a, b) => a.week_start.localeCompare(b.week_start) || String(a.salesperson_name).localeCompare(String(b.salesperson_name), 'zh-CN'));
    return { access, week: beijingWeekRange(new Date()), viewer_id: userId, reports };
  }

  saveWeeklyReport(userId, access, body) {
    if (access !== 'submit') throw Object.assign(Error('只能查看周报，不能保存'), { status: 403 });
    const week = String(body?.week_start || '').trim() ? weeklyThursday(String(body.week_start).trim()) : beijingWeekRange(new Date());
    const inquiries = parseWeeklyStoredNumber(body?.inquiries, true, '询盘');
    const calls = parseWeeklyStoredNumber(body?.calls, true, '电话');
    const unpaidOrders = parseWeeklyStoredNumber(body?.unpaid_orders, true, '下单未付');
    const performance = parseWeeklyStoredNumber(body?.performance, false, '业绩');
    const text = String(body?.body ?? '').trim();
    if (text.length > 8000) throw Object.assign(Error('周报内容过长'), { status: 400 });
    if (inquiries == null && calls == null && unpaidOrders == null && performance == null && !text) {
      throw Object.assign(Error(EMPTY_WEEKLY_REPORT_MESSAGE), { status: 400 });
    }
    const id = `${userId}:${week.week_start}`;
    const existing = this.all(WEEKLY_REPORTS).find(row => row.id === id);
    const saved = this.put(WEEKLY_REPORTS, {
      id,
      user_id: userId,
      salesperson_name: this.issueDisplayName(userId),
      week_start: week.week_start,
      week_end: week.week_end,
      inquiries,
      calls,
      unpaid_orders: unpaidOrders,
      performance,
      body: text,
      note: typeof existing?.note === 'string' ? existing.note : '',
      created_at: existing?.created_at || now(),
      updated_at: now()
    });
    return { access, report: this.weeklyReportView(saved) };
  }

  weeklyReport(userId, body = {}) {
    const access = this.weeklyReportAccess(userId);
    if (!access) throw Object.assign(Error('没有周报权限'), { status: 403 });
    const action = String(body?.action || '');
    if (action === 'list') return this.listWeeklyReports(userId, access);
    if (action === 'save') return this.saveWeeklyReport(userId, access, body);
    throw Object.assign(Error('不支持的周报操作'), { status: 400 });
  }

  // Write API for in-process features (order supplements today, weekly-report
  // reminders later). There is no browser route for this method.
  //
  // store.createNotifications({
  //   user_ids: [id, ...],   // or user_id: id. One row is stored per user.
  //   title,                  // required
  //   body,                   // required. content is accepted as an alias.
  //   kind,                   // optional type string. type is accepted as an alias.
  //   order_id,               // optional. Omit it for notifications that are not about an order.
  //   unread                  // optional, defaults to true. read:true stores it already read.
  // })
  // Callers must not put phone numbers, email addresses, or other customer
  // contact details in title or body. Returns { notifications }.
  createNotifications(input = {}) {
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    const rawIds = Array.isArray(input.user_ids) ? input.user_ids : input.user_id != null ? [input.user_id] : [];
    const userIds = [...new Set(rawIds.map(id => String(id ?? '').trim()).filter(Boolean))];
    if (!userIds.length) fail('请指定通知接收人');
    const title = String(input.title ?? '').trim();
    const body = String(input.body ?? input.content ?? '').trim();
    if (!title) fail('请填写通知标题');
    if (!body) fail('请填写通知内容');
    if (title.length > 80) fail('通知标题过长');
    if (body.length > 500) fail('通知内容过长');
    const kind = String(input.kind ?? input.type ?? '').trim();
    if (kind.length > 40) fail('通知类型过长');
    const orderId = input.order_id == null || String(input.order_id).trim() === '' ? null : String(input.order_id).trim();
    const unread = !(input.unread === false || input.read === true);
    for (const id of userIds) if (!this.profile(id)) fail('通知接收人不存在', 404);
    const timestamp = now();
    const created = [];
    // A savepoint works both on its own and inside the supplement transaction.
    this.db.exec('savepoint user_notifications');
    try {
      for (const user_id of userIds) {
        created.push(this.put(USER_NOTIFICATIONS, {
          user_id, title, body, kind: kind || null, order_id: orderId, unread,
          read_at: unread ? null : timestamp, created_at: timestamp
        }));
      }
      this.db.exec('release user_notifications');
    } catch (error) {
      this.db.exec('rollback to user_notifications');
      this.db.exec('release user_notifications');
      this.tableCache.delete(USER_NOTIFICATIONS);
      throw error;
    }
    return { notifications: created };
  }

  userNotifications(userId, input = {}) {
    const fail = (message, status = 400) => { throw Object.assign(Error(message), { status }); };
    const profile = this.profile(userId);
    if (!profile || profile.disabled_at) fail('请先登录', 401);
    const action = String(input.action || 'list');
    const mine = () => this.all(USER_NOTIFICATIONS).filter(row => row.user_id === userId);
    const newest = (rows) => rows.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
    const unreadCount = rows => rows.filter(row => row.unread !== false).length;
    if (action === 'list') {
      const sorted = newest(mine());
      const unread = sorted.filter(row => row.unread !== false);
      const recentRead = sorted.filter(row => row.unread === false).slice(0, 30);
      const notifications = newest([...unread, ...recentRead]);
      return { unread_count: unread.length, notifications };
    }
    if (action === 'mark_read') {
      const ids = new Set((Array.isArray(input.ids) ? input.ids : input.id ? [input.id] : []).map(id => String(id)));
      const orderId = input.order_id ? String(input.order_id) : '';
      const timestamp = now();
      let updated = 0;
      for (const row of mine()) {
        if (row.unread === false) continue;
        if (!ids.has(String(row.id)) && !(orderId && String(row.order_id) === orderId)) continue;
        this.put(USER_NOTIFICATIONS, { ...row, unread: false, read_at: timestamp });
        updated += 1;
      }
      return { updated, unread_count: unreadCount(mine()) };
    }
    if (action === 'create') fail('通知只能由服务端功能创建', 403);
    fail('不支持的操作');
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
    if (table === 'shopify_order_intake') throw Object.assign(Error('请通过 Shopify 订单认领接口操作'), {status:403});
    if (['order_issues', 'order_issue_reads'].includes(table)) throw Object.assign(Error('问题记录只能通过订单问题接口访问'), { status: 403 });
    if (RETIRED_FEATURE_TABLES.has(table)) throw Object.assign(Error('该历史功能已停用'), { status: 403 });
    if (method === 'GET') return this.query(table, url, rangeHeader, this.visibleRows(table, userId));
    const follower = this.isFollower(userId);
    const supervisor = this.isSupervisor(userId);
    const resourceEditor = table === 'internal_resource_tables' && this.internalResourcePermissions(userId).can_edit;
    const shopifyProductImage = method === 'POST' && table === 'order_images' && this.shopifyProductImagePost(userId, body);
    if (method !== 'GET' && table === 'internal_resource_tables' && !resourceEditor) throw Object.assign(Error('没有修改权限'), { status: 403 });
    if (method !== 'GET' && !follower && !resourceEditor && !(table === 'profiles' && supervisor) && !shopifyProductImage) throw Object.assign(Error('没有修改权限'), { status: 403 });
    if (method !== 'GET' && table === 'profiles' && !supervisor) throw Object.assign(Error('仅主管可以修改账号权限'), { status: 403 });
    if (method === 'POST' && table === 'internal_resource_tables') {
      if (!['inventory', 'logistics'].includes(body?.resource_key)) {
        throw Object.assign(Error('Invalid workbook key'), { status: 400 });
      }
      const row = { ...body, created_at: body.created_at || now() };
      const result = this.db.prepare(
        'insert into records(table_name,record_id,data) values(?,?,?) on conflict(table_name,record_id) do nothing'
      ).run(table, row.resource_key, json(row));
      if (result.changes === 0) {
        throw Object.assign(Error('Workbook already exists. Reopen it before saving.'), { status: 409 });
      }
      this.tableCache.delete(table);
      return [row];
    }
    if (method === 'POST') {
      const input = Array.isArray(body) ? body : [body];
      const created = input.map(value => {
        const row = { ...value };
        if (!row.id && !['app_settings', 'internal_resource_tables'].includes(table)) row.id = randomUUID();
        if (!row.created_at) row.created_at = now();
        if (table === 'orders') {
          this.assertShopifyHandoffWritable(null, row);
          if (!row.created_by) row.created_by = userId;
          const normalized = this.preserveShopifyIdentity(this.normalizeOrderOwner(this.normalizeOrderDestination(row, userId), value));
          const reminder = customerInfoReminder(normalized.customer_info);
          if (reminder) throw Object.assign(Error(reminder), { status: 400 });
          if (normalized !== row) {
            for (const key of Object.keys(row)) delete row[key];
            Object.assign(row, normalized);
          }
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
      if (table === 'orders') this.assertShopifyHandoffWritable(row, body);
      let next = { ...row, ...body };
      if (table === 'orders') next = this.preserveShopifyIdentity(this.normalizeOrderOwner(this.normalizeOrderDestination(next, userId, row), body), row);
      return project(this.put(table, next), url.searchParams.get('select'));
    });
    if (method === 'DELETE') {
      if (table === 'orders') matchesRows.forEach(row => this.assertShopifyHandoffWritable(row, null));
      this.remove(table, matchesRows.map(row => row.id ?? row.key ?? row.resource_key));
      return matchesRows.map(row => project(row, url.searchParams.get('select')));
    }
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
  const matches = store.all('orders').filter(row => !row.deleted_at && !['sales_supplement', 'follower_create'].includes(row.current_step) &&
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
