import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const mode = process.argv[2];
const supabaseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');
const driveFolderId = requireEnv('GOOGLE_DRIVE_FOLDER_ID');
const credentials = JSON.parse(requireEnv('GOOGLE_SERVICE_ACCOUNT_JSON'));
const outputDir = path.resolve('backup-output');
const tables = ['profiles', 'app_settings', 'partners', 'orders', 'order_events', 'order_images'];

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
      const objectPath = safeObjectPath(row.object_path);
      const response = await checkedFetch(
        `${supabaseUrl}/storage/v1/object/authenticated/order-images/${encodedObjectPath(objectPath)}`,
        { headers: apiHeaders() },
      );
      const target = path.join(outputDir, 'storage', 'order-images', ...objectPath.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
      downloaded += 1;
    } catch (error) {
      warnings.push(`Image ${row.object_path} failed: ${error.message}`);
    }
  }
  return downloaded;
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
  for (const table of tables) {
    const rows = await exportTable(table);
    counts[table] = rows.length;
    if (table === 'order_images') imageRows = rows;
  }
  counts.auth_users = await exportAuthUsers(warnings);
  counts.downloaded_images = await downloadImages(imageRows, warnings);
  const schemaFiles = await copySchemaFiles();
  const manifest = {
    created_at: new Date().toISOString(),
    source: supabaseUrl,
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

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function getDriveToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/drive.file',
    aud: credentials.token_uri || 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), credentials.private_key).toString('base64url');
  const assertion = `${unsigned}.${signature}`;
  const response = await checkedFetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  return (await response.json()).access_token;
}

async function uploadToDrive(zipPath) {
  const token = await getDriveToken();
  const zip = await fs.readFile(zipPath);
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const name = `cargo-pulse-backup-${timestamp}.zip`;
  const boundary = `cargo-pulse-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name,
    parents: [driveFolderId],
    description: 'Cargo Pulse weekly automated backup',
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await checkedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,createdTime', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const uploaded = await response.json();
  console.log(`Uploaded ${uploaded.name} (${uploaded.id})`);
  await pruneOldBackups(token);
}

async function pruneOldBackups(token) {
  const q = `'${driveFolderId}' in parents and trashed = false and name contains 'cargo-pulse-backup-'`;
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('q', q);
  url.searchParams.set('fields', 'files(id,name,createdTime)');
  url.searchParams.set('orderBy', 'createdTime desc');
  url.searchParams.set('pageSize', '100');
  const response = await checkedFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const files = (await response.json()).files ?? [];
  for (const file of files.slice(12)) {
    await checkedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`Deleted old backup ${file.name}`);
  }
}

if (mode === 'export') {
  await exportBackup();
} else if (mode === 'upload') {
  const zipPath = process.argv[3];
  if (!zipPath) throw new Error('Usage: node backup-to-google-drive.mjs upload <zip-file>');
  await uploadToDrive(zipPath);
} else {
  throw new Error('Usage: node backup-to-google-drive.mjs <export|upload>');
}

