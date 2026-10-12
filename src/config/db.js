import mongoose from 'mongoose';
import env from './env.js';
import logger from '../common/utils/logger.js';

mongoose.set('strictQuery', true);

export async function connectDB(uri = env.MONGODB_URI) {
  // Production builds indexes deliberately (they can be slow on big collections); demos build them on start-up.
  await mongoose.connect(uri, { autoIndex: !env.isProd || env.DEMO_MODE, serverSelectionTimeoutMS: 10000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
