import ApiError from '../../common/errors/ApiError.js';
import Society from '../society/society.model.js';
import Reseller from '../whitelabel/reseller.model.js';
import * as whitelabel from '../whitelabel/whitelabel.service.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { invalidate } from '../../realtime/socket.js';
import { SocietyAppearance, TemplatePlanRule, TemplateSetting } from './appearance.model.js';
import { resolvePalette } from './palette.js';
import {
  CATALOGUE_VERSION,
  DEFAULT_PLAN_TEMPLATES,
  DEFAULT_TEMPLATE,
  FONTS,
  PLAN_ORDER,
  RADII,
  RULE_PLANS,
  TEMPLATES,
  TEMPLATE_KEYS,
  templateByKey,
} from './templates.catalogue.js';

const RESELLER_FIELDS = 'name status brand templates';

// ---------- platform-wide settings ----------
async function loadSettings() {
  const doc = await TemplateSetting.findOne({ key: 'global' }).lean();
  const disabled = (doc?.disabled || []).filter((k) => TEMPLATE_KEYS.includes(k));
  const defaultTemplate = templateByKey(doc?.defaultTemplate) && !disabled.includes(doc.defaultTemplate) ? doc.defaultTemplate : DEFAULT_TEMPLATE;
  return { disabled, defaultTemplate, enabled: TEMPLATE_KEYS.filter((k) => !disabled.includes(k)) };
}

async function loadPlanRules() {
  const rows = await TemplatePlanRule.find({}).lean();
  const rules = Object.fromEntries(RULE_PLANS.map((p) => [p, [...DEFAULT_PLAN_TEMPLATES[p]]]));
  for (const r of rows) if (RULE_PLANS.includes(r.plan)) rules[r.plan] = r.templates.filter((k) => TEMPLATE_KEYS.includes(k));
  return rules;
}

// Same rule as modules/features: an expired trial behaves as the free plan.
function planOf(society) {
  const plan = society?.plan?.name || 'free';
  if (plan === 'trial' && society.plan?.validUntil && new Date(society.plan.validUntil) < new Date()) return 'free';
  return plan;
}

// ---------- the one place a society's choice is worked out ----------
// offered = templates the colony admin sees (enabled platform-wide and inside the partner's subset);
// allowed = the offered ones its plan (or the platform's per-colony override) includes.
function choiceFor({ society, appearance, reseller, settings, rules }) {
  const plan = planOf(society);
  const partner = reseller?.status === 'active' && reseller.templates?.allowed?.length ? reseller.templates.allowed : null;
  const offered = settings.enabled.filter((k) => !partner || partner.includes(k));
  const override = appearance?.allowedTemplates?.length ? appearance.allowedTemplates : null;
  const base = override || rules[plan] || [];
  const allowed = offered.filter((k) => base.includes(k));
  const stored = appearance?.template && templateByKey(appearance.template) ? appearance.template : null;
  let active;
  if (stored && (appearance.forced || allowed.includes(stored))) active = stored;
  else if (allowed.includes(settings.defaultTemplate)) active = settings.defaultTemplate;
  else active = allowed[0] || DEFAULT_TEMPLATE;
  // "Available on Premium": the cheapest plan that includes a locked template (not when the platform set a
  // per-colony list — then the plan is not what limits it).
  const availableOn = (key) => (override ? null : PLAN_ORDER.find((p) => PLAN_ORDER.indexOf(p) > PLAN_ORDER.indexOf(plan === 'trial' ? 'premium' : plan) && rules[p]?.includes(key)) || null);
  return { plan, offered, allowed, active, availableOn, override, adminMayChange: appearance ? appearance.adminMayChange !== false : true, forced: Boolean(appearance?.forced && stored) };
}

async function loadFor(societyId) {
  const society = await Society.findById(societyId).select('name code plan reseller').lean();
  if (!society) throw ApiError.notFound('Society not found');
  const [appearance, reseller, settings, rules] = await Promise.all([
    SocietyAppearance.findOne({ society: societyId }).lean(),
    society.reseller ? Reseller.findById(society.reseller).select(RESELLER_FIELDS).lean() : null,
    loadSettings(),
    loadPlanRules(),
  ]);
  const state = { society, appearance, reseller, settings, rules };
  return { ...state, choice: choiceFor(state) };
}

// Everything the browser needs to draw a template (frontend/src/lib/template.js applies it).
export function present(key, reseller, opts) {
  const t = templateByKey(key) || templateByKey(DEFAULT_TEMPLATE);
  return {
    key: t.key,
    version: t.version,
    catalogueVersion: CATALOGUE_VERSION,
    name: t.name,
    description: t.description,
    tags: t.tags,
    darkFirst: t.darkFirst,
    font: t.font,
    fonts: FONTS[t.font],
    radius: t.radius,
    radii: RADII[t.radius],
    shadow: t.shadow,
    header: t.header,
    sidebar: t.sidebar,
    login: t.login,
    home: t.home,
    buttons: t.buttons,
    icons: t.icons,
    preview: t.preview,
    previewPhone: t.previewPhone,
    palette: resolvePalette(t, reseller, opts),
  };
}

const summary = (t) => ({ key: t.key, name: t.name, description: t.description, tags: t.tags, preview: t.preview, previewPhone: t.previewPhone, darkFirst: t.darkFirst, home: t.home, login: t.login, swatch: t.palette.brand['600'], accent: t.palette.accent });

const mediaOf = (appearance) => ({ logoUrl: appearance?.logoUrl || null, coverUrl: appearance?.coverUrl || null });

// ---------- members ----------
export async function forMember(societyId) {
  const s = await loadFor(societyId);
  return {
    template: present(s.choice.active, s.reseller),
    ...mediaOf(s.appearance),
    society: { _id: s.society._id, name: s.society.name, code: s.society.code },
    adminMayChange: s.choice.adminMayChange,
    updatedAt: s.appearance?.updatedAt || null,
  };
}

// Public, for the login page: a society's look when reached through its link (?society=DEMO01), the white-label
// partner's otherwise (custom domain or ?brand=<slug>), else the platform default.
export async function forPublic({ society: code, slug, host }) {
  if (code) {
    const society = await Society.findOne({ code: String(code).toUpperCase().trim() }).select('_id name code').lean();
    if (society) {
      const s = await loadFor(society._id);
      return {
        template: present(s.choice.active, s.reseller),
        society: { name: society.name, code: society.code, ...mediaOf(s.appearance) },
        brand: await whitelabel.brandForSociety(society._id),
      };
    }
  }
  const brand = await whitelabel.brandingLookup({ host, slug });
  const settings = await loadSettings();
  let reseller = null;
  let key = settings.defaultTemplate;
  if (brand.reseller) {
    reseller = await Reseller.findOne({ slug: brand.slug, status: 'active' }).select(RESELLER_FIELDS).lean();
    const subset = reseller?.templates?.allowed?.filter((k) => settings.enabled.includes(k));
    if (subset?.length && !subset.includes(key)) [key] = subset;
  }
  return { template: present(key, reseller, { loginWithoutSociety: true }), society: null, brand };
}

// ---------- colony admin (Settings → Appearance) ----------
export async function options(ctx) {
  const s = await loadFor(ctx.societyId);
  const { choice } = s;
  return {
    current: choice.active,
    plan: choice.plan,
    adminMayChange: choice.adminMayChange,
    forced: choice.forced,
    ...mediaOf(s.appearance),
    templates: TEMPLATES.filter((t) => choice.offered.includes(t.key)).map((t) => ({
      ...summary(t),
      allowed: choice.allowed.includes(t.key),
      availableOn: choice.allowed.includes(t.key) ? null : choice.availableOn(t.key),
    })),
  };
}

// "Try it": the full template (with the partner's colour rules) without saving anything.
export async function preview(ctx, key) {
  const s = await loadFor(ctx.societyId);
  if (!s.choice.offered.includes(key)) throw ApiError.notFound('Template not found');
  return present(key, s.reseller);
}

export async function apply(ctx, key) {
  const s = await loadFor(ctx.societyId);
  if (!s.choice.adminMayChange) throw new ApiError(403, 'APPEARANCE_LOCKED', 'ColonyHub has set this colony’s template; it cannot be changed here');
  if (!s.choice.allowed.includes(key)) {
    throw new ApiError(403, 'TEMPLATE_NOT_ALLOWED', '{template} is not included in your plan', { params: { template: templateByKey(key)?.name || key } });
  }
  await SocietyAppearance.updateOne({ society: ctx.societyId }, { $set: { template: key, forced: false, updatedBy: ctx.userId } }, { upsert: true });
  audit.record(ctx, 'appearance.template_applied', 'Society', ctx.societyId, { from: s.choice.active, to: key });
  invalidate(ctx.societyId, ['appearance']);
  return forMember(ctx.societyId);
}

// logo / cover: an upload id from POST /uploads (folder "appearance"), or null to remove.
export async function setMedia(ctx, { logo, cover }) {
  const set = {};
  const unset = {};
  for (const [field, id] of [['logoUrl', logo], ['coverUrl', cover]]) {
    if (id === undefined) continue;
    if (id === null) {
      unset[field] = 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const [file] = await uploads.resolve(ctx, [id]);
    if (!file.mimetype.startsWith('image/')) throw ApiError.badRequest('Use a JPG, PNG or WEBP image');
    set[field] = file.url;
  }
  await SocietyAppearance.updateOne(
    { society: ctx.societyId },
    { $set: { ...set, updatedBy: ctx.userId }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    { upsert: true },
  );
  audit.record(ctx, 'appearance.media_updated', 'Society', ctx.societyId, { logo: logo === undefined ? undefined : logo ? 'changed' : 'removed', cover: cover === undefined ? undefined : cover ? 'changed' : 'removed' });
  invalidate(ctx.societyId, ['appearance']);
  return forMember(ctx.societyId);
}

// ---------- platform console ----------
async function usageCounts(settings, rules) {
  const [societies, rows, resellers] = await Promise.all([
    Society.find({}).select('plan reseller').lean(),
    SocietyAppearance.find({}).lean(),
    Reseller.find({}).select(RESELLER_FIELDS).lean(),
  ]);
  const byId = (list, field) => new Map(list.map((d) => [String(d[field]), d]));
  const appearances = byId(rows, 'society');
  const partners = byId(resellers, '_id');
  const usage = Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, 0]));
  for (const society of societies) {
    const { active } = choiceFor({ society, appearance: appearances.get(String(society._id)), reseller: society.reseller ? partners.get(String(society.reseller)) : null, settings, rules });
    usage[active] += 1;
  }
  return usage;
}

export async function platformOverview() {
  const [settings, rules] = await Promise.all([loadSettings(), loadPlanRules()]);
  const usage = await usageCounts(settings, rules);
  return {
    version: CATALOGUE_VERSION,
    defaultTemplate: settings.defaultTemplate,
    plans: RULE_PLANS,
    planRules: rules,
    templates: TEMPLATES.map((t) => ({
      ...summary(t),
      font: t.font,
      radius: t.radius,
      header: t.header,
      sidebar: t.sidebar,
      buttons: t.buttons,
      icons: t.icons,
      enabled: settings.enabled.includes(t.key),
      isDefault: t.key === settings.defaultTemplate,
      usage: usage[t.key],
      plans: RULE_PLANS.filter((p) => rules[p].includes(t.key)),
    })),
  };
}

const assertKey = (key) => {
  if (!templateByKey(key)) throw ApiError.badRequest('Unknown template "{key}"', { params: { key } });
};

export async function setEnabled(user, key, enabled) {
  assertKey(key);
  const settings = await loadSettings();
  if (!enabled && key === settings.defaultTemplate) throw ApiError.conflict('Choose another default template before switching this one off');
  await TemplateSetting.updateOne({ key: 'global' }, { [enabled ? '$pull' : '$addToSet']: { disabled: key }, $set: { updatedBy: user._id } }, { upsert: true });
  return platformOverview();
}

export async function setDefault(user, key) {
  assertKey(key);
  const settings = await loadSettings();
  if (settings.disabled.includes(key)) throw ApiError.conflict('Switch this template on before making it the default');
  await TemplateSetting.updateOne({ key: 'global' }, { $set: { defaultTemplate: key, updatedBy: user._id } }, { upsert: true });
  return platformOverview();
}

export async function setPlanRule(user, plan, templates) {
  if (!RULE_PLANS.includes(plan)) throw ApiError.badRequest('Unknown plan "{plan}"', { params: { plan } });
  templates.forEach(assertKey);
  await TemplatePlanRule.updateOne({ plan }, { $set: { templates: [...new Set(templates)], updatedBy: user._id } }, { upsert: true });
  return platformOverview();
}

export async function forPlatformSociety(societyId) {
  const s = await loadFor(societyId);
  const { choice } = s;
  return {
    society: { _id: s.society._id, name: s.society.name, code: s.society.code },
    plan: choice.plan,
    current: choice.active,
    forced: choice.forced,
    adminMayChange: choice.adminMayChange,
    allowedTemplates: choice.override || [], // the per-colony override; empty = plan
    planTemplates: s.rules[choice.plan] || [],
    allowed: choice.allowed,
    offered: choice.offered,
    reseller: s.reseller ? { _id: s.reseller._id, name: s.reseller.name, allowed: s.reseller.templates?.allowed || [], brandOverridesTemplate: Boolean(s.reseller.templates?.brandOverridesTemplate) } : null,
    ...mediaOf(s.appearance),
    templates: TEMPLATES.map(summary),
    updatedAt: s.appearance?.updatedAt || null,
  };
}

// { allowedTemplates?: [keys] ([] = back to the plan), adminMayChange?: bool, forceTemplate?: key | null }
export async function updatePlatformSociety(user, societyId, data) {
  if (!(await Society.exists({ _id: societyId }))) throw ApiError.notFound('Society not found');
  const set = { updatedBy: user._id };
  if (data.allowedTemplates !== undefined) {
    data.allowedTemplates.forEach(assertKey);
    set.allowedTemplates = [...new Set(data.allowedTemplates)];
  }
  if (data.adminMayChange !== undefined) set.adminMayChange = data.adminMayChange;
  if (data.forceTemplate) {
    assertKey(data.forceTemplate);
    Object.assign(set, { template: data.forceTemplate, forced: true });
  } else if (data.forceTemplate === null) set.forced = false;
  await SocietyAppearance.updateOne({ society: societyId }, { $set: set }, { upsert: true });
  // The colony's own audit log shows what the platform changed.
  audit.record({ societyId, userId: user._id }, 'platform.appearance_updated', 'Society', societyId, data);
  invalidate(societyId, ['appearance']);
  return forPlatformSociety(societyId);
}

export async function forPlatformReseller(id) {
  const reseller = await Reseller.findById(id).select(RESELLER_FIELDS).lean();
  if (!reseller) throw ApiError.notFound('Reseller not found');
  return {
    _id: reseller._id,
    name: reseller.name,
    primaryColor: reseller.brand?.primaryColor || null,
    allowedTemplates: reseller.templates?.allowed || [],
    brandOverridesTemplate: Boolean(reseller.templates?.brandOverridesTemplate),
    templates: TEMPLATES.map(summary),
  };
}

export async function updatePlatformReseller(user, id, data) {
  if (!(await Reseller.exists({ _id: id }))) throw ApiError.notFound('Reseller not found');
  const set = {};
  if (data.allowedTemplates !== undefined) {
    data.allowedTemplates.forEach(assertKey);
    set['templates.allowed'] = [...new Set(data.allowedTemplates)];
  }
  if (data.brandOverridesTemplate !== undefined) set['templates.brandOverridesTemplate'] = data.brandOverridesTemplate;
  await Reseller.updateOne({ _id: id }, { $set: set });
  const societies = await Society.find({ reseller: id }).select('_id').lean();
  for (const s of societies) invalidate(s._id, ['appearance']);
  return forPlatformReseller(id);
}
