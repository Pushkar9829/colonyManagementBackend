import env from '../../config/env.js';
import logger from './logger.js';

// Unexpected errors are logged and, when ERROR_WEBHOOK_URL is set, posted to a chat webhook
// (Slack / Discord / Teams incoming webhook or any JSON endpoint). The same error is reported at most
// once every 10 minutes so an outage doesn't flood the channel.
const WINDOW_MS = 10 * 60 * 1000;
const lastSent = new Map();

export function reportError(err, context = {}) {
  const message = err?.message || String(err);
  logger.error({ err, ...context }, 'Unexpected error');
  if (!env.ERROR_WEBHOOK_URL || env.isTest) return;

  const key = `${context.source || 'server'}:${message}`.slice(0, 300);
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < WINDOW_MS) return;
  lastSent.set(key, now);
  if (lastSent.size > 500) lastSent.clear();

  const text = [
    `*ColonyHub ${env.NODE_ENV} error* (${context.source || 'server'})`,
    message,
    context.path ? `Path: ${context.method || ''} ${context.path}` : null,
    context.user ? `User: ${context.user}` : null,
    err?.stack ? `\`\`\`${String(err.stack).split('\n').slice(0, 6).join('\n')}\`\`\`` : null,
  ]
    .filter(Boolean)
    .join('\n');

  // `text` for Slack/Teams, `content` for Discord.
  fetch(env.ERROR_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text.slice(0, 1900) }) }).catch(() => {});
}
