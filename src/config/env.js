import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load backend/.env regardless of the working directory (real env vars still win, e.g. on Render).
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env'), quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  MONGODB_URI: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  // Public base URL of this API (used for locally stored upload links)
  PUBLIC_URL: z.string().default('http://localhost:5000'),
  ENABLE_JOBS: z.stringbool().default(true),
  // SMS: console (logs to server output) | twilio
  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_FROM: z.string().optional().default(''),
  // File storage: local (backend/uploads — dev only, Render's disk is wiped on deploy) | cloudinary
  STORAGE_PROVIDER: z.enum(['local', 'cloudinary']).default('local'),
  CLOUDINARY_CLOUD_NAME: z.string().optional().default(''),
  CLOUDINARY_API_KEY: z.string().optional().default(''),
  CLOUDINARY_API_SECRET: z.string().optional().default(''),
  // Optional chat webhook that receives unexpected server/browser errors
  ERROR_WEBHOOK_URL: z.string().optional().default(''),
  // Email: console (prints to server log) | sendgrid
  EMAIL_PROVIDER: z.enum(['console', 'sendgrid']).default('console'),
  SENDGRID_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('no-reply@colonyhub.local'),
  EMAIL_FROM_NAME: z.string().default('ColonyHub'),
  // Public URL of the web app (links in emails, e.g. password reset)
  APP_URL: z.string().default('http://localhost:5173'),
  // WhatsApp: console (prints to server log) | meta (WhatsApp Cloud API, needs an approved template)
  WHATSAPP_PROVIDER: z.enum(['console', 'meta']).default('console'),
  WHATSAPP_TOKEN: z.string().optional().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_TEMPLATE: z.string().default('colonyhub_alert'),
  WHATSAPP_LANG: z.string().default('en'),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
  // Web push (generate with: npx web-push generate-vapid-keys). Push is off when unset.
  VAPID_PUBLIC_KEY: z.string().optional().default(''),
  VAPID_PRIVATE_KEY: z.string().optional().default(''),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;

if (env.PAYMENT_PROVIDER === 'razorpay' && (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)) {
  console.error('PAYMENT_PROVIDER=razorpay requires RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET');
  process.exit(1);
}

const missing = (keys) => keys.filter((k) => !env[k]);
const requireKeys = (when, keys) => {
  const m = when ? missing(keys) : [];
  if (m.length) {
    console.error(`Missing environment variables: ${m.join(', ')}`);
    process.exit(1);
  }
};
requireKeys(env.SMS_PROVIDER === 'twilio', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']);
requireKeys(env.EMAIL_PROVIDER === 'sendgrid', ['SENDGRID_API_KEY', 'EMAIL_FROM']);
requireKeys(env.WHATSAPP_PROVIDER === 'meta', ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID']);
requireKeys(env.STORAGE_PROVIDER === 'cloudinary', ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']);

export default {
  ...env,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  corsOrigins: env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
};
