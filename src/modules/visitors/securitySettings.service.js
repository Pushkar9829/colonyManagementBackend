import SecuritySettings from './securitySettings.model.js';
import * as audit from '../audit/audit.service.js';

export const SETTING_FIELDS = [
  'escalationSeconds',
  'parcelReminderHours',
  'patrolGraceMinutes',
  'visitorParkingOverstayGraceMinutes',
  'childAlertEscalationMinutes',
  'allowUnknownExit',
];
const DEFAULTS = Object.fromEntries(SETTING_FIELDS.map((f) => [f, SecuritySettings.schema.path(f).defaultValue]));
const merge = (doc) => ({ ...DEFAULTS, ...Object.fromEntries(SETTING_FIELDS.filter((f) => doc?.[f] !== undefined).map((f) => [f, doc[f]])) });

// Settings with defaults filled in; reading never creates a document.
export async function getSettings(societyId) {
  return merge(await SecuritySettings.findOne({ society: societyId }).lean());
}

// Lookup function over many societies at once (used by scheduled jobs).
export async function settingsLookup(societyIds) {
  const docs = await SecuritySettings.find({ society: { $in: societyIds } }).lean();
  const bySociety = new Map(docs.map((d) => [String(d.society), d]));
  return (id) => merge(bySociety.get(String(id)));
}

export async function updateSettings(ctx, data) {
  await SecuritySettings.updateOne({ society: ctx.societyId }, { $set: data }, { upsert: true, runValidators: true });
  audit.record(ctx, 'security.settings_updated', 'SecuritySettings', ctx.societyId, data);
  return getSettings(ctx.societyId);
}
