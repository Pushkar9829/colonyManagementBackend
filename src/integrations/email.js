import env from '../config/env.js';
import logger from '../common/utils/logger.js';

// Email adapters share one interface: send({ to, subject, text, html, attachments? }) -> Promise<void>.
// attachments: [{ filename, content: Buffer, type }]

const consoleEmail = {
  name: 'console',
  async send({ to, subject, text, attachments, fromName }) {
    logger.info({ to, fromName: fromName || env.EMAIL_FROM_NAME, subject, text: text?.slice(0, 500), attachments: attachments?.map((a) => a.filename) }, 'Email (console provider — not actually sent)');
  },
};

const sendgrid = {
  name: 'sendgrid',
  async send({ to, subject, text, html, attachments, fromName }) {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.SENDGRID_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: (Array.isArray(to) ? to : [to]).map((email) => ({ email })) }],
        from: { email: env.EMAIL_FROM, name: fromName || env.EMAIL_FROM_NAME },
        subject,
        content: [{ type: 'text/plain', value: text || '' }, ...(html ? [{ type: 'text/html', value: html }] : [])],
        ...(attachments?.length
          ? { attachments: attachments.map((a) => ({ filename: a.filename, type: a.type, content: Buffer.from(a.content).toString('base64'), disposition: 'attachment' })) }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`SendGrid email failed (${res.status})`);
  },
};

export const email = env.EMAIL_PROVIDER === 'sendgrid' ? sendgrid : consoleEmail;

// White label: a society linked to a reseller sends under the reseller's app name. The whitelabel module
// registers the lookup; `message.society` (optional) says which society an email is from.
let fromNameFor = null;
export const setFromNameResolver = (fn) => {
  fromNameFor = fn;
};

export function sendEmailQuietly(message) {
  if (!message.to || (Array.isArray(message.to) && !message.to.length)) return;
  const { society, ...rest } = message;
  Promise.resolve(rest.fromName || (society && fromNameFor ? fromNameFor(society) : null))
    .catch(() => null)
    .then((fromName) => email.send({ ...rest, ...(fromName ? { fromName } : {}) }))
    .catch((err) => logger.warn({ err: err.message, subject: message.subject }, 'Email delivery failed'));
}
