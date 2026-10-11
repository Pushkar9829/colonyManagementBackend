import env from '../config/env.js';
import logger from '../common/utils/logger.js';

// SMS adapters share one interface: send(to, text) -> Promise<void>.
// India numbers without a country code get +91.
const e164 = (phone) => (phone.startsWith('+') ? phone : `+91${phone.replace(/^0+/, '')}`);

const consoleSms = {
  name: 'console',
  async send(to, text) {
    logger.info({ to: e164(to), text }, 'SMS (console provider — not actually sent)');
  },
};

const twilio = {
  name: 'twilio',
  async send(to, text) {
    const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: e164(to), From: env.TWILIO_FROM, Body: text }),
    });
    if (!res.ok) throw new Error(`Twilio SMS failed (${res.status})`);
  },
};

export const sms = env.SMS_PROVIDER === 'twilio' ? twilio : consoleSms;

// Fire-and-forget variant for notifications: a failed SMS must not break the action.
export function sendSmsQuietly(to, text) {
  if (!to) return;
  sms.send(to, text).catch((err) => logger.warn({ err, to }, 'SMS delivery failed'));
}
