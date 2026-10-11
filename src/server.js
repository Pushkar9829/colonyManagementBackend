import http from 'node:http';
import env from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createApp } from './app.js';
import logger from './common/utils/logger.js';
import { reportError } from './common/utils/errorReporter.js';
import { attachRealtime, closeRealtime } from './realtime/socket.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

async function start() {
  await connectDB();
  const server = http.createServer(createApp());
  attachRealtime(server);
  if (env.ENABLE_JOBS) startScheduler();
  server.listen(env.PORT, () => logger.info(`API listening on http://localhost:${env.PORT}/api/v1`));

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    server.close(async () => {
      await closeRealtime();
      await disconnectDB();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

process.on('unhandledRejection', (err) => reportError(err, { source: 'unhandledRejection' }));

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
