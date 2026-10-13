import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const source = resolve(process.env.DATA_DIR ?? 'data', 'funding.sqlite');
const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/backup.mjs /absolute/path/funding-backup.sqlite');
const destination = resolve(target);
if (!existsSync(source)) throw new Error('Source database does not exist.');
if (existsSync(destination)) throw new Error('Refusing to overwrite an existing backup.');
mkdirSync(dirname(destination), {recursive:true, mode:0o700});
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.prepare('VACUUM INTO ?').run(destination);
  chmodSync(destination, 0o600);
} finally { db.close(); }
const check = new DatabaseSync(destination, {readOnly:true});
try {
  const rows = check.prepare('PRAGMA integrity_check').all();
  if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw new Error('Backup integrity check failed.');
  console.log(JSON.stringify({ status:'ok', backup: destination, note:'Keep ORDER_TOKEN_SECRET separately in secure backup.' }));
} finally { check.close(); }
