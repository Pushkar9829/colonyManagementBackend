import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { validate } from '../../common/middleware/validate.js';
import { reportError } from '../../common/utils/errorReporter.js';

// Browser crash reports from the web app's error boundary. Public (errors happen before login too),
// so it is size-limited and rate-limited, and nothing is stored beyond the log line.
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const schema = z.object({
  message: z.string().max(1000),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500).optional(),
  userAgent: z.string().max(300).optional(),
  release: z.string().max(50).optional(),
});

const router = Router();
router.post('/', limiter, validate({ body: schema }), (req, res) => {
  const err = new Error(req.body.message);
  err.stack = req.body.stack || err.message;
  reportError(err, { source: 'browser', path: req.body.url, method: '' });
  res.status(204).end();
});

export default router;
