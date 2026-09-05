import fs from 'node:fs/promises';
import path from 'node:path';

const mode = process.argv[2];
const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');
const outputDir = path.resolve('backup-output');
const requiredTables = [
  'profiles',
  'app_settings',
  'partners',
  'orders',
  'order_events',
  'order_images',
  'order_factories',
  'order_shipments',
  'order_shipment_events',
  'internal_resource_tables',
  'shipments',
];

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function apiHeaders(extra = {}) {
  return { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, ...extra };
}

async function checkedFetch(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 1000)}`);
  }
  return response;
}

async function exportTable(table) {
  const all = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${supabaseUrl}/rest/v1/${encodeURIComponent(table)}?select=*`;
    const response = await checkedFetch(url, {
      headers: apiHeaders({ Range: `${offset}-${offset + pageSize - 1}`, Prefer: 'count=exact' }),
    });
    const rows = await response.json();
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  await fs.writeFile(path.join(outputDir, 'data', `${table}.json`), JSON.stringify(all, null, 2));
  return all;
}

async function discoverPublicTables(warnings) {
  try {
    const response = await checkedFetch(`${supabaseUrl}/rest/v1/`, {
      headers: apiHeaders({ Accept: 'application/openapi+json' }),
    });
    const specification = await response.json();
    const discovered = Object.keys(specification.definitions ?? {})
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
    if (!discovered.length) {
      warnings.push('No public tables were discovered from the REST schema; using the required table list.');
    }
    return [...new Set([...requiredTables, ...discovered])].sort();
  } catch (error) {
    warnings.push(`Public table discovery failed; using the required table list: ${error.message}`);
    return [...requiredTables];
  }
}

async function exportAuthUsers(warnings) {
  const all = [];
  try {
    for (let page = 1; ; page += 1) {
      const response = await checkedFetch(`${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=1000`, {
        headers: apiHeaders(),
      });
      const result = await response.json();
      const users = Array.isArray(result) ? result : (result.users ?? []);
      all.push(...users);
      if (users.length < 1000) break;
    }
    await fs.writeFile(path.join(outputDir, 'data', 'auth_users.json'), JSON.stringify(all, null, 2));
  } catch (error) {
    warnings.push(`Auth users export failed: ${error.message}`);
  }
  return all.length;
}

function safeObjectPath(objectPath) {
  return String(objectPath)
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function encodedObjectPath(objectPath) {
  return safeObjectPath(objectPath).split('/').map(encodeURIComponent).join('/');
}

async function downloadImages(rows, warnings) {
  let downloaded = 0;
  for (const row of rows) {
    if (!row.object_path) continue;
    try {
      const isTencent = String(row.object_path).startsWith('tencent:');
      const objectPath = safeObjectPath(isTencent ? String(row.object_path).slice(8) : row.object_path);
      const response = isTencent
        ? await checkedFetch(`https://kis.net/uploads/${encodedObjectPath(objectPath)}`)
        : await checkedFetch(
          `${supabaseUrl}/storage/v1/object/authenticated/order-images/${encodedObjectPath(objectPath)}`,
          { headers: apiHeaders() },
        );
      const target = path.join(outputDir, 'storage', isTencent ? 'tencent' : 'order-images', ...objectPath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
      downloaded += 1;
    } catch (error) {
      warnings.push(`Image ${row.object_path} failed: ${error.message}`);
    }
  }
  return downloaded;
}

function resourceImageRows(rows) {
  const images = [];
  for (const resource of rows) {
    for (const value of Array.isArray(resource.rows) ? resource.rows : []) {
      if (!value || Array.isArray(value) || value.__cargo_pulse_resource_meta__ !== 1) continue;
      for (const image of Array.isArray(value.images) ? value.images : []) {
        if (image?.object_path) images.push({ object_path: image.object_path });
      }
    }
  }
  return images;
}

async function copySchemaFiles() {
  const names = await fs.readdir('.');
  const sqlFiles = names.filter((name) => name.toLowerCase().endsWith('.sql'));
  await fs.mkdir(path.join(outputDir, 'schema'), { recursive: true });
  for (const name of sqlFiles) {
    await fs.copyFile(name, path.join(outputDir, 'schema', name));
  }
  return sqlFiles;
}

async function exportBackup() {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outputDir, 'data'), { recursive: true });
  const warnings = [];
  const counts = {};
  let imageRows = [];
  let internalResourceImageRows = [];
  const tables = await discoverPublicTables(warnings);
  for (const table of tables) {
    const rows = await exportTable(table);
    counts[table] = rows.length;
    if (table === 'order_images') imageRows = rows;
    if (table === 'internal_resource_tables') internalResourceImageRows = resourceImageRows(rows);
  }
  counts.auth_users = await exportAuthUsers(warnings);
  const storageRows = [...new Map([...imageRows, ...internalResourceImageRows].map(row => [row.object_path, row])).values()];
  counts.downloaded_images = await downloadImages(storageRows, warnings);
  const schemaFiles = await copySchemaFiles();
  const manifest = {
    created_at: new Date().toISOString(),
    source: supabaseUrl,
    source_revision: process.env.GITHUB_SHA ?? null,
    tables,
    counts,
    schema_files: schemaFiles,
    warnings,
    complete: warnings.length === 0,
  };
  await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (warnings.length) {
    await fs.writeFile(path.join(outputDir, 'WARNINGS.json'), JSON.stringify(warnings, null, 2));
  }
  console.log(`Exported backup: ${JSON.stringify(counts)}`);
  if (warnings.length) console.warn(`Backup completed with ${warnings.length} warning(s).`);
}

if (mode === 'export') {
  await exportBackup();
} else {
  throw new Error('Usage: node backup-to-google-drive.mjs export');
}

