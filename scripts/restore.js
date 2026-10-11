// Restores a folder written by scripts/backup.js into the database in MONGODB_URI.
//   npm run restore -- <backup-folder> --yes
// Replaces each backed-up collection completely, so it refuses to run without --yes,
// and refuses NODE_ENV=production unless --force-production is also given.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import mongoose from 'mongoose';
import env from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
const { EJSON } = mongoose.mongo.BSON; // bundled with mongoose — no extra dependency

const dir = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : null;
if (!dir || !fs.existsSync(path.join(dir, 'manifest.json'))) {
  console.error('Usage: npm run restore -- <backup-folder> --yes');
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  console.error('This replaces the collections in the target database. Re-run with --yes to confirm.');
  process.exit(1);
}
if (env.isProd && !process.argv.includes('--force-production')) {
  console.error('NODE_ENV=production: add --force-production if you really mean to restore over production.');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const conn = await connectDB();
const db = conn.db;
console.log(`Restoring ${manifest.database} (${manifest.createdAt}) into ${db.databaseName}`);

for (const [name, info] of Object.entries(manifest.collections)) {
  const col = db.collection(name);
  // eslint-disable-next-line no-await-in-loop
  await col.deleteMany({});
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, `${name}.jsonl.gz`)).pipe(zlib.createGunzip()) });
  let batch = [];
  let total = 0;
  // eslint-disable-next-line no-await-in-loop
  for await (const line of rl) {
    if (!line) continue;
    batch.push(EJSON.parse(line, { relaxed: false }));
    if (batch.length === 1000) {
      // eslint-disable-next-line no-await-in-loop
      await col.insertMany(batch, { ordered: false });
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    // eslint-disable-next-line no-await-in-loop
    await col.insertMany(batch, { ordered: false });
    total += batch.length;
  }
  for (const idx of info.indexes || []) {
    if (idx.name === '_id_') continue;
    const { key, name: idxName, v, ns, ...options } = idx;
    // eslint-disable-next-line no-await-in-loop
    await col.createIndex(key, { name: idxName, ...options }).catch((err) => console.warn(`  index ${idxName}: ${err.message}`));
  }
  console.log(`  ${name}: ${total}/${info.count}`);
}
console.log('Restore complete');
await mongoose.disconnect();
