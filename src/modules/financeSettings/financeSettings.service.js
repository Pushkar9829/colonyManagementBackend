import FinanceSettings, { ACCOUNTS, DEFAULT_HEAD_ACCOUNTS } from './financeSettings.model.js';
import * as audit from '../audit/audit.service.js';

export { ACCOUNTS };

const DEFAULTS = {
  gstin: '',
  gstEnabled: false,
  gstDefaultRate: 18,
  gstExemptUpTo: 0,
  headGst: [],
  headAccounts: DEFAULT_HEAD_ACCOUNTS,
  nonOccupancy: { percent: 0, appliesTo: ['rented'] },
  chequeBounceCharge: 0,
  waiverApprovalRequired: true,
  restrictAmenityForDefaulters: false,
  autopayEnabled: false,
};

// Settings for a society, falling back to defaults when none were saved. Never creates a document.
export async function forSociety(societyId) {
  const doc = await FinanceSettings.findOne({ society: societyId }).lean();
  return { ...DEFAULTS, ...(doc || {}), nonOccupancy: { ...DEFAULTS.nonOccupancy, ...(doc?.nonOccupancy || {}) } };
}

export const get = (ctx) => forSociety(ctx.societyId);

export async function update(ctx, data) {
  const set = { updatedBy: ctx.userId };
  for (const [k, v] of Object.entries(data)) {
    if (k === 'nonOccupancy') for (const [nk, nv] of Object.entries(v)) set[`nonOccupancy.${nk}`] = nv;
    else set[k] = v;
  }
  await FinanceSettings.findOneAndUpdate({ society: ctx.societyId }, { $set: set, $setOnInsert: { society: ctx.societyId } }, { upsert: true, runValidators: true });
  audit.record(ctx, 'finance.settings_updated', 'FinanceSettings', undefined, { fields: Object.keys(data) });
  return forSociety(ctx.societyId);
}

const norm = (s) => String(s || '').trim().toLowerCase();

// Chart code for a charge head ("Sinking fund" → 3100). Unmapped heads use `fallback` (maintenance income).
export function accountFor(settings, headKey, fallback = ACCOUNTS.MAINTENANCE) {
  const hit = (settings.headAccounts || []).find((h) => norm(h.head) === norm(headKey));
  return hit?.account || fallback;
}

// GST percent for a charge head when GST is on; per-head overrides win over the default rate.
export function gstRateFor(settings, headKey) {
  if (!settings.gstEnabled) return 0;
  const hit = (settings.headGst || []).find((h) => norm(h.head) === norm(headKey));
  return hit ? hit.rate : settings.gstDefaultRate;
}
