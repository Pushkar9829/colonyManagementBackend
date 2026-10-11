import rateLimit from 'express-rate-limit';
import env from '../../config/env.js';

const handler = (_req, res) =>
  res.status(429).json({ success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } });

export const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, handler, skip: () => env.isTest });
export const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, handler, skip: () => env.isTest });
