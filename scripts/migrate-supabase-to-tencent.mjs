const required = name => {
  const value = process.env[name];
  if (!value) throw Error(`缺少环境变量 ${name}`);
  return value;
};

const source = required('LEGACY_SUPABASE_URL').replace(/\/$/, '');
const key = required('LEGACY_SUPABASE_KEY');
const email = required('MIGRATION_EMAIL');
const password = required('MIGRATION_PASSWORD');
const target = (process.env.TENCENT_DATA_URL || 'http://127.0.0.1:8788').replace(/\/$/, '');
const secret = required('CARGO_PULSE_IMPORT_SECRET');
const tables = [
  'profiles', 'app_settings', 'partners', 'orders', 'order_events', 'order_images',
  'order_factories', 'order_shipments', 'order_shipment_events', 'internal_resource_tables'
];

async function checked(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(body.message || body.error_description || body.error || `${response.status} ${url}`);
  return body;
}

const login = await checked(`${source}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
});
const auth = { apikey: key, Authorization: `Bearer ${login.access_token}` };

async function readTable(table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${source}/rest/v1/${table}?select=*`, { headers: { ...auth, Range: `${offset}-${offset + 999}`, 'Range-Unit': 'items' } });
    if (response.status === 404) return [];
    const page = await response.json().catch(() => []);
    if (!response.ok) throw Error(page.message || `读取 ${table} 失败`);
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

const counts = {};
let imageRows = [];
for (const table of tables) {
  const rows = await readTable(table);
  if (table === 'order_images') imageRows = rows;
  await checked(`${target}/admin/import`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Import-Secret': secret }, body: JSON.stringify({ tables: { [table]: rows } })
  });
  counts[table] = rows.length;
  process.stdout.write(`${table}: ${rows.length}\n`);
}

let copiedImages = 0;
for (const row of imageRows) {
  if (!row.object_path || row.object_path.startsWith('tencent:')) continue;
  const encoded = row.object_path.split('/').map(encodeURIComponent).join('/');
  const signed = await checked(`${source}/storage/v1/object/sign/order-images/${encoded}`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 3600 })
  });
  const imageResponse = await fetch(`${source}/storage/v1${signed.signedURL}`);
  if (!imageResponse.ok) throw Error(`图片读取失败：${row.object_path}`);
  const upload = await fetch(`${target}/admin/import-object/${encoded}`, {
    method: 'POST', headers: { 'X-Import-Secret': secret, 'Content-Type': imageResponse.headers.get('content-type') || 'application/octet-stream' }, body: await imageResponse.arrayBuffer()
  });
  if (!upload.ok) throw Error(`图片写入失败：${row.object_path}`);
  copiedImages += 1;
}

const health = await checked(`${target}/health`);
if (Number(health.orders) !== Number(counts.orders)) throw Error(`订单数量校验失败：源端 ${counts.orders}，腾讯云 ${health.orders}`);
process.stdout.write(`迁移校验完成：${counts.orders} 个订单，${copiedImages} 张历史图片。\n`);
