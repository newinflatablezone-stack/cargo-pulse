import { backup, DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

const source = process.env.CARGO_PULSE_DB || '/var/lib/cargo-pulse/data/cargo-pulse.sqlite';
const uploads = process.env.CARGO_PULSE_UPLOAD_ROOT || '/var/lib/cargo-pulse/uploads';
const root = process.env.CARGO_PULSE_BACKUP_DIR || '/var/backups/cargo-pulse';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(root, stamp);
await mkdir(destination, { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, join(destination, 'cargo-pulse.sqlite')); } finally { db.close(); }
await cp(uploads, join(destination, 'uploads'), { recursive: true, force: false }).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
const folders = (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort().reverse();
for (const old of folders.slice(10)) await rm(join(root, old), { recursive: true, force: true });
console.log(`Cargo Pulse backup created: ${basename(destination)}`);
