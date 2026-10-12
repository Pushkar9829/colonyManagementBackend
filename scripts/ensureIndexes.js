// Builds every collection's indexes (unique keys included) in the database in MONGODB_URI.
// Run once after pointing at a new database: npm run db:indexes
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { createApp } from '../src/app.js';

createApp(); // loads every module, so every model is registered
await connectDB();
const models = Object.values(mongoose.models);
for (const model of models) {
  // eslint-disable-next-line no-await-in-loop
  await model.createIndexes();
}
console.log(`Indexes ready for ${models.length} collections in "${mongoose.connection.name}"`);
await mongoose.disconnect();
