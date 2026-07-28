#!/usr/bin/env node
// Applies the SQL files in api/_lib/migrations, in filename order, exactly once.
//
//   DATABASE_URL=postgres://… node scripts/migrate.mjs
//   DATABASE_URL=postgres://… node scripts/migrate.mjs --status
//
// Each file runs inside its own transaction, so a migration either lands whole or
// not at all. Applied files are recorded with a checksum: editing a migration that
// has already run is an error, because the database and the file would disagree
// with no way to tell from the outside.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', '_lib', 'migrations');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Set DATABASE_URL before running migrations.');
  process.exit(1);
}

let pg;
try {
  pg = require('pg');
} catch (error) {
  console.error('The "pg" package is not installed. Run: npm install');
  process.exit(1);
}

const statusOnly = process.argv.includes('--status');
const client = new pg.Client({ connectionString });

function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter(name => name.endsWith('.sql'))
    .sort()
    .map(name => {
      const sql = readFileSync(join(migrationsDir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) };
    });
}

async function main() {
  await client.connect();
  await client.query(`
    create table if not exists schema_migrations (
      name        text primary key,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )
  `);

  const { rows } = await client.query('select name, checksum from schema_migrations');
  const applied = new Map(rows.map(row => [row.name, row.checksum]));
  const files = migrationFiles();

  for (const file of files) {
    const previous = applied.get(file.name);
    if (previous && previous !== file.checksum) {
      throw new Error(
        `${file.name} was already applied with a different checksum. ` +
        'Add a new migration instead of editing one that has run.'
      );
    }
  }

  if (statusOnly) {
    for (const file of files) {
      console.log(`${applied.has(file.name) ? 'applied' : 'pending'}  ${file.name}`);
    }
    return;
  }

  let count = 0;
  for (const file of files) {
    if (applied.has(file.name)) continue;
    process.stdout.write(`applying ${file.name} … `);
    try {
      await client.query('BEGIN');
      await client.query(file.sql);
      await client.query(
        'insert into schema_migrations (name, checksum) values ($1, $2)',
        [file.name, file.checksum]
      );
      await client.query('COMMIT');
      count += 1;
      console.log('ok');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.log('failed');
      throw error;
    }
  }
  console.log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
