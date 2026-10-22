import SocietyFeatures from './societyFeatures.model.js';
import Society from '../society/society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import * as audit from '../audit/audit.service.js';
import { FEATURES, FEATURE_KEYS, PLAN_FEATURES } from './features.catalogue.js';

// Short per-process cache: requireFeature runs on every gated request. A change made on another
// instance shows up here within CACHE_MS; changes made on this instance apply immediately.
const CACHE_MS = 30 * 1000;
const cache = new Map();

export const clearCache = (societyId) => (societyId ? cache.delete(String(societyId)) : cache.clear());

function resolve(plan, overrides) {
  const base = new Set(PLAN_FEATURES[plan] || []);
  const byKey = Object.fromEntries((overrides || []).map((o) => [o.key, o]));
  return FEATURES.map((f) => {
    const o = byKey[f.key];
    const inPlan = base.has(f.key);
    return { ...f, inPlan, override: o ? o.enabled : null, enabled: o ? o.enabled : inPlan, source: o ? 'override' : 'plan', overriddenAt: o?.at, note: o?.note };
  });
}

async function load(societyId) {
  const [society, doc] = await Promise.all([Society.findById(societyId).select('plan').lean(), SocietyFeatures.findOne({ society: societyId }).lean()]);
  if (!society) throw ApiError.notFound('Society not found');
  let plan = society.plan?.name || 'free';
  // an expired trial falls back to the free plan until the society subscribes
  if (plan === 'trial' && society.plan?.validUntil && new Date(society.plan.validUntil) < new Date()) plan = 'free';
  return { plan, features: resolve(plan, doc?.overrides) };
}

export async function enabledKeys(societyId) {
  const key = String(societyId);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.keys;
  const { features } = await load(societyId);
  const keys = new Set(features.filter((f) => f.enabled).map((f) => f.key));
  cache.set(key, { keys, until: Date.now() + CACHE_MS });
  return keys;
}

export const isEnabled = async (societyId, key) => (await enabledKeys(societyId)).has(key);

// What the signed-in member's society can use.
export async function forMember(ctx) {
  const { plan, features } = await load(ctx.societyId);
  return { plan, enabled: features.filter((f) => f.enabled).map((f) => f.key), features };
}

export const catalogue = () => ({ features: FEATURES, plans: PLAN_FEATURES });

export const forSociety = (societyId) => load(societyId);

// overrides: { key: true | false | null } — null removes the override (back to the plan default).
export async function setOverrides(platformUser, societyId, overrides, note) {
  if (!(await Society.exists({ _id: societyId }))) throw ApiError.notFound('Society not found');
  const doc = (await SocietyFeatures.findOne({ society: societyId })) || new SocietyFeatures({ society: societyId });
  for (const [key, value] of Object.entries(overrides)) {
    if (!FEATURE_KEYS.includes(key)) throw ApiError.badRequest('Unknown feature "{feature}"', { params: { feature: key } });
    doc.overrides = doc.overrides.filter((o) => o.key !== key);
    if (value !== null) doc.overrides.push({ key, enabled: value, by: platformUser._id, at: new Date(), note });
  }
  await doc.save();
  clearCache(societyId);
  audit.record({ societyId, userId: platformUser._id }, 'platform.features_updated', 'Society', societyId, { overrides, note });
  return load(societyId);
}
