import env from '../config/env.js';
import logger from '../common/utils/logger.js';

// WhatsApp adapters share one interface: sendAlert(to, title, body) -> Promise<void>.
// Business-initiated WhatsApp messages must use a pre-approved template. Create one in Meta Business Manager
// named WHATSAPP_TEMPLATE (default "colonyhub_alert") with two body variables, e.g.
//   "*{{1}}*\n{{2}}\n\n— ColonyHub"
const toWaNumber = (phone) => (phone.startsWith('+') ? phone.slice(1) : `91${phone.replace(/^0+/, '')}`);

const consoleWa = {
  name: 'console',
  async sendAlert(to, title, body) {
    logger.info({ to: toWaNumber(to), title, body }, 'WhatsApp (console provider — not actually sent)');
  },
};

const meta = {
  name: 'meta',
  async sendAlert(to, title, body) {
    const res = await fetch(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toWaNumber(to),
        type: 'template',
        template: {
          name: env.WHATSAPP_TEMPLATE,
          language: { code: env.WHATSAPP_LANG },
          components: [{ type: 'body', parameters: [{ type: 'text', text: title.slice(0, 60) }, { type: 'text', text: (body || '-').slice(0, 900) }] }],
        },
      }),
    });
    if (!res.ok) throw new Error(`WhatsApp send failed (${res.status})`);
  },
};

export const whatsapp = env.WHATSAPP_PROVIDER === 'meta' ? meta : consoleWa;

// Bypasses the society's WhatsApp mode and credits. Application code must send through
// modules/whatsapp/whatsapp.service.js sendWhatsApp() (or a notification with the 'whatsapp' channel) instead.
export function sendWhatsAppQuietly(to, title, body) {
  if (!to) return;
  whatsapp.sendAlert(to, title, body).catch((err) => logger.warn({ err: err.message, to }, 'WhatsApp delivery failed'));
}
