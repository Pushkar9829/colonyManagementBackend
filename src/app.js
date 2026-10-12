import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';
import env from './config/env.js';
import logger from './common/utils/logger.js';
import routes from './routes.js';
import paymentWebhooks from './modules/payments/webhook.routes.js';
import { UPLOAD_DIR } from './integrations/storage.js';
import { sanitize } from './common/middleware/sanitize.js';
import { globalLimiter } from './common/middleware/rateLimit.js';
import { errorHandler, notFound } from './common/middleware/errorHandler.js';

export function createApp() {
  const app = express();

  // Render terminates TLS at a proxy; trust it so req.ip and rate limiting see the real client.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Allow non-browser clients (no Origin), any site when CORS_ORIGINS='*', or the configured frontends.
        if (!origin || env.allowAllOrigins || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Key'],
      exposedHeaders: ['Content-Disposition'], // lets the web app read download file names
      maxAge: 600,
    }),
  );
  // Payment webhooks verify a signature over the raw body, so they are mounted before the JSON parser.
  app.use('/api/v1/payments/webhook', paymentWebhooks);
  app.use(express.json({ limit: '1mb' }));
  app.use(sanitize);
  if (!env.isTest) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url.endsWith('/health') } }));
  app.use('/api', globalLimiter);

  // Locally stored uploads (dev). Allow the separate frontend origin to embed them.
  if (env.STORAGE_PROVIDER === 'local') {
    app.use(
      '/uploads',
      (_req, res, next) => {
        res.set('Cross-Origin-Resource-Policy', 'cross-origin');
        next();
      },
      express.static(UPLOAD_DIR, { index: false, maxAge: '7d', dotfiles: 'deny' }),
    );
  }

  app.get('/', (_req, res) => res.json({ name: 'Colony Management API', docs: '/api/v1/health' }));
  app.use('/api/v1', routes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
