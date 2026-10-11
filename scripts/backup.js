// Logical backup of the whole database to one gzipped JSON-lines file per collection (Extended JSON keeps
// ObjectIds and dates intact). No MongoDB tools needed.
//   npm run backup                 -> backups/<db>-<timestamp>/
//   npm run backup -- --out D:\bk  -> custom folder
// Atlas also has automated snapshots; use this for portable copies or before risky migrations.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
const { EJSON } = mongoose.mongo.BSON; // bundled with mongoose — no extra dependency

const outArg = process.argv.indexOf('--out');
const conn = await connectDB();
const db = conn.db;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.resolve(outArg > -1 ? process.argv[outArg + 1] : `backups/${db.databaseName}-${stamp}`);
fs.mkdirSync(dir, { recursive: true });

const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith('system.'));
const manifest = { database: db.databaseName, createdAt: new Date().toISOString(), collections: {} };

for (const name of collections) {
  const cursor = db.collection(name).find({}, { batchSize: 1000 });
  let count = 0;
  async function* lines() {
    for await (const doc of cursor) {
      count += 1;
      yield `${EJSON.stringify(doc, { relaxed: false })}\n`;
    }
  }
  // eslint-disable-next-line no-await-in-loop
  await pipeline(Readable.from(lines()), zlib.createGzip(), fs.createWriteStream(path.join(dir, `${name}.jsonl.gz`)));
  // eslint-disable-next-line no-await-in-loop
  const indexes = await db.collection(name).indexes();
  manifest.collections[name] = { count, indexes };
  console.log(`  ${name}: ${count}`);
}

fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Backup written to ${dir}`);
await mongoose.disconnect();
