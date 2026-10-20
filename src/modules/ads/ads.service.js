import mongoose from 'mongoose';
import ApiError from '../../common/errors/ApiError.js';
import { localDateString } from '../../common/utils/dates.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { storage } from '../../integrations/storage.js';
import { sniff } from '../uploads/uploads.service.js';
import Society from '../society/society.model.js';
import * as audit from '../audit/audit.service.js';
import Ad from './ad.model.js';
import AdStat from './adStat.model.js';
import AdSeen from './adSeen.model.js';
import AdMedia from './adMedia.model.js';
import AdSetting from './adSetting.model.js';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
const MAX_BANNERS = 3;
const MB = (n) => `${Math.round(n / 1024 / 1024)} MB`;

// ---------- media ----------
// Real type from the first bytes: MP4 has an "ftyp" box at offset 4; WebM is an EBML file whose doc type is "webm".
function sniffVideo(buf) {
  if (buf.length < 12) return null;
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3 && buf.subarray(0, 64).includes(Buffer.from('webm'))) return 'video/webm';
  return null;
}

export async function saveMedia(ctx, scope, file) {
  if (!file) throw ApiError.badRequest('Attach an image or video in the "file" field');
  const image = sniff(file.buffer);
  const mimetype = image && image !== 'application/pdf' ? image : sniffVideo(file.buffer);
  if (!mimetype) throw ApiError.badRequest('Only JPG, PNG or WEBP images and MP4 or WebM videos can be used in ads');
  const isVideo = mimetype.startsWith('video/');
  if (!isVideo && file.size > MAX_IMAGE_BYTES) throw ApiError.badRequest(`Images must be ${MB(MAX_IMAGE_BYTES)} or smaller`);
  if (isVideo && file.size > MAX_VIDEO_BYTES) throw ApiError.badRequest(`Videos must be ${MB(MAX_VIDEO_BYTES)} or smaller`);
  const folder = scope === 'platform' ? 'platform/ads' : `${ctx.societyId}/ads`;
  const stored = await storage.save({ buffer: file.buffer, mimetype, folder });
  const doc = await AdMedia.create({
    scope,
    society: scope === 'society' ? ctx.societyId : undefined,
    owner: ctx.userId,
    ...stored,
    mimetype,
    size: file.size,
    name: file.originalname?.slice(0, 120),
  });
  return { _id: doc._id, url: doc.url, mimetype, size: doc.size, name: doc.name };
}

// Only the uploader's own files of the same scope (and society) can be attached.
async function resolveMedia(ctx, scope, id) {
  const filter = { _id: id, owner: ctx.userId, scope };
  if (scope === 'society') filter.society = ctx.societyId;
  const m = await AdMedia.findOne(filter).lean();
  if (!m) throw ApiError.badRequest('The uploaded file was not found. Upload it again.');
  return { upload: m._id, url: m.url, mimetype: m.mimetype };
}

// ---------- management ----------
const scopeFilter = (ctx, scope) => (scope === 'platform' ? { scope: 'platform' } : { scope: 'society', society: ctx.societyId });

async function societyAdsAllowed(societyId) {
  const s = await AdSetting.findOne({ society: societyId }).select('allowSocietyAds').lean();
  return s?.allowSocietyAds !== false;
}

async function assertSocietiesExist(ids) {
  if (!ids?.length) return;
  const found = await Society.countDocuments({ _id: { $in: ids } });
  if (found !== new Set(ids.map(String)).size) throw ApiError.badRequest('One or more societies were not found');
}

// Builds the stored fields from a create / update body (media ids are resolved, audience is normalised).
async function buildFields(ctx, scope, data, existing) {
  const out = { ...data };
  delete out.mediaId;
  delete out.posterId;
  if (data.mediaId) {
    out.media = await resolveMedia(ctx, scope, data.mediaId);
    out.mediaType = out.media.mimetype.startsWith('video/') ? 'video' : 'image';
  }
  if (data.posterId !== undefined) {
    if (data.posterId === null) out.poster = undefined;
    else {
      out.poster = await resolveMedia(ctx, scope, data.posterId);
      if (!out.poster.mimetype.startsWith('image/')) throw ApiError.badRequest('The poster must be an image');
    }
  }
  if (data.audience) {
    const a = { ...(existing?.audience || {}), ...data.audience };
    if (scope === 'society') {
      out.audience = { allSocieties: false, societies: [], roles: a.roles || [], platform: false };
    } else {
      const allSocieties = a.allSocieties !== false;
      const societies = allSocieties ? [] : a.societies || [];
      await assertSocietiesExist(societies);
      if (!allSocieties && !societies.length && !a.platform) throw ApiError.badRequest('Choose at least one society, all societies, or the platform console');
      out.audience = { allSocieties, societies, roles: a.roles || [], platform: Boolean(a.platform) };
    }
  }
  const startAt = out.startAt || existing?.startAt;
  const endAt = out.endAt || existing?.endAt;
  if (startAt && endAt && new Date(endAt) <= new Date(startAt)) throw ApiError.badRequest('The end must be after the start');
  return out;
}

export async function create(ctx, scope, data) {
  if (scope === 'society' && !(await societyAdsAllowed(ctx.societyId))) {
    throw new ApiError(403, 'SOCIETY_ADS_DISABLED', 'Ads by the society are switched off for this society by the platform');
  }
  if (!data.mediaId) throw ApiError.badRequest('Upload an image or video for the ad');
  const fields = await buildFields(ctx, scope, { audience: {}, ...data });
  const ad = await Ad.create({ ...fields, scope, society: scope === 'society' ? ctx.societyId : undefined, createdBy: ctx.userId });
  if (scope === 'society') audit.record(ctx, 'ad.created', 'Ad', ad._id, { title: ad.title, placement: ad.placement });
  return withTotals(ad.toObject());
}

async function findOwn(ctx, scope, id) {
  const ad = await Ad.findOne({ _id: id, ...scopeFilter(ctx, scope) });
  if (!ad) throw ApiError.notFound('Ad not found');
  return ad;
}

export async function update(ctx, scope, id, data) {
  const ad = await findOwn(ctx, scope, id);
  const fields = await buildFields(ctx, scope, data, ad.toObject());
  ad.set({ ...fields, updatedBy: ctx.userId });
  if (fields.poster === undefined && data.posterId === null) ad.poster = undefined;
  await ad.save();
  if (scope === 'society') audit.record(ctx, 'ad.updated', 'Ad', ad._id, { fields: Object.keys(data) });
  return withTotals(ad.toObject());
}

export async function remove(ctx, scope, id) {
  const ad = await findOwn(ctx, scope, id);
  await Promise.all([ad.deleteOne(), AdStat.deleteMany({ ad: ad._id }), AdSeen.deleteMany({ ad: ad._id })]);
  if (scope === 'society') audit.record(ctx, 'ad.deleted', 'Ad', ad._id, { title: ad.title });
  return { deleted: true };
}

const ctr = (t) => (t.impressions ? Math.round((t.clicks / t.impressions) * 10000) / 100 : 0);
const zero = { impressions: 0, clicks: 0, dismissals: 0 };

async function totalsFor(ids) {
  if (!ids.length) return new Map();
  const rows = await AdStat.aggregate([
    { $match: { ad: { $in: ids } } },
    { $group: { _id: '$ad', impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, dismissals: { $sum: '$dismissals' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { impressions: r.impressions, clicks: r.clicks, dismissals: r.dismissals }]));
}

async function withTotals(ad) {
  const t = (await totalsFor([ad._id])).get(String(ad._id)) || zero;
  return { ...ad, stats: { ...t, ctr: ctr(t) } };
}

const statusOf = (ad, now = new Date()) => (!ad.active ? 'paused' : ad.startAt > now ? 'scheduled' : ad.endAt <= now ? 'ended' : 'live');

export async function list(ctx, scope, { status, search, society }, { page, limit, skip }) {
  const filter = scope === 'platform' && society ? { scope: 'society', society } : scopeFilter(ctx, scope);
  const now = new Date();
  if (status === 'live') Object.assign(filter, { active: true, startAt: { $lte: now }, endAt: { $gt: now } });
  if (status === 'scheduled') Object.assign(filter, { active: true, startAt: { $gt: now } });
  if (status === 'ended') Object.assign(filter, { endAt: { $lte: now } });
  if (status === 'paused') filter.active = false;
  if (search) filter.title = new RegExp(escapeRegex(search), 'i');
  const [items, total] = await Promise.all([
    Ad.find(filter).sort({ active: -1, priority: -1, createdAt: -1 }).skip(skip).limit(limit).populate('audience.societies', 'name').populate('createdBy', 'name').lean(),
    Ad.countDocuments(filter),
  ]);
  const totals = await totalsFor(items.map((a) => a._id));
  return {
    items: items.map((a) => {
      const t = totals.get(String(a._id)) || zero;
      return { ...a, status: statusOf(a, now), stats: { ...t, ctr: ctr(t) } };
    }),
    meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  };
}

export async function stats(ctx, scope, id, { days = 30 } = {}) {
  const filter = scope === 'platform' ? { _id: id } : { _id: id, ...scopeFilter(ctx, scope) };
  const ad = await Ad.findOne(filter).select('title').lean();
  if (!ad) throw ApiError.notFound('Ad not found');
  const from = localDateString(new Date(Date.now() - (days - 1) * 86400000));
  const rows = await AdStat.find({ ad: ad._id, day: { $gte: from } }).sort({ day: 1 }).lean();
  const all = (await totalsFor([ad._id])).get(String(ad._id)) || zero;
  return {
    ad: { _id: ad._id, title: ad.title },
    totals: { ...all, ctr: ctr(all) },
    days: rows.map((r) => ({ day: r.day, impressions: r.impressions, clicks: r.clicks, dismissals: r.dismissals, ctr: ctr(r) })),
  };
}

// ---------- society-ads switch ----------
export async function societySettings(ctx) {
  return { allowSocietyAds: await societyAdsAllowed(ctx.societyId) };
}

export async function platformSocieties({ search }, { page, limit, skip }) {
  const filter = search ? { name: new RegExp(escapeRegex(search), 'i') } : {};
  const [items, total] = await Promise.all([Society.find(filter).select('name city active').sort({ name: 1 }).skip(skip).limit(limit).lean(), Society.countDocuments(filter)]);
  const ids = items.map((s) => s._id);
  const [settings, counts] = await Promise.all([
    AdSetting.find({ society: { $in: ids } }).lean(),
    Ad.aggregate([{ $match: { scope: 'society', society: { $in: ids } } }, { $group: { _id: '$society', n: { $sum: 1 } } }]),
  ]);
  const allow = new Map(settings.map((s) => [String(s.society), s.allowSocietyAds !== false]));
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  return {
    items: items.map((s) => ({ ...s, allowSocietyAds: allow.get(String(s._id)) ?? true, societyAds: n.get(String(s._id)) || 0 })),
    meta: { page, limit, total, pages: Math.ceil(total / limit) || 1 },
  };
}

export async function setSocietySetting(ctx, societyId, allowSocietyAds) {
  if (!(await Society.exists({ _id: societyId }))) throw ApiError.notFound('Society not found');
  await AdSetting.updateOne({ society: societyId }, { $set: { allowSocietyAds, updatedBy: ctx.userId } }, { upsert: true });
  // The society's admins can see in their own audit log why their ads stopped.
  audit.record({ societyId, userId: ctx.userId, ip: ctx.ip }, allowSocietyAds ? 'ads.society_ads_allowed' : 'ads.society_ads_blocked', 'Society', societyId);
  return { society: societyId, allowSocietyAds };
}

// ---------- delivery ----------
// Ads this person may see right now, ignoring pop-up frequency.
async function visibleFilter(ctx, now = new Date()) {
  const base = { active: true, startAt: { $lte: now }, endAt: { $gt: now } };
  if (!ctx.societyId) return { ...base, scope: 'platform', 'audience.platform': true };
  const sources = [{ scope: 'platform', $or: [{ 'audience.allSocieties': true }, { 'audience.societies': ctx.societyId }] }];
  if (await societyAdsAllowed(ctx.societyId)) sources.push({ scope: 'society', society: ctx.societyId });
  return { ...base, $and: [{ $or: sources }, { $or: [{ 'audience.roles': { $size: 0 } }, { 'audience.roles': ctx.role }] }] };
}

const publicAd = (a) => ({
  _id: a._id,
  scope: a.scope,
  title: a.title,
  body: a.body,
  mediaType: a.mediaType,
  media: { url: a.media.url, mimetype: a.media.mimetype },
  poster: a.poster ? { url: a.poster.url, mimetype: a.poster.mimetype } : undefined,
  landingUrl: a.landingUrl,
  ctaLabel: a.ctaLabel,
  placement: a.placement,
  frequency: a.frequency,
});

const sameDay = (d, today) => d && localDateString(d) === today;

export function popupDue(ad, seen, now = new Date()) {
  if (ad.frequency === 'every_visit') return true;
  if (!seen?.lastSeenAt) return true;
  if (ad.frequency === 'once') return false;
  return !sameDay(seen.lastSeenAt, localDateString(now));
}

export async function active(ctx) {
  const now = new Date();
  const ads = await Ad.find(await visibleFilter(ctx, now)).sort({ priority: -1, startAt: -1, _id: -1 }).limit(30).lean();
  const seen = new Map((await AdSeen.find({ user: ctx.userId, ad: { $in: ads.map((a) => a._id) } }).lean()).map((s) => [String(s.ad), s]));
  const today = localDateString(now);
  const banners = ads.filter((a) => ['banner', 'both'].includes(a.placement) && !sameDay(seen.get(String(a._id))?.bannerDismissedAt, today)).slice(0, MAX_BANNERS);
  const popup = ads.find((a) => ['popup', 'both'].includes(a.placement) && popupDue(a, seen.get(String(a._id)), now));
  return { banners: banners.map(publicAd), popup: popup ? publicAd(popup) : null };
}

const COUNTER = { impression: 'impressions', click: 'clicks', dismiss: 'dismissals' };

// Counts a view / click / close. Calls made while logged in as someone else are not counted (they are not
// that person's views) and leave their pop-up state alone.
export async function event(ctx, id, type, placement) {
  if (ctx.user?.actingAs) return { counted: false };
  if (!mongoose.isValidObjectId(id) || !(await Ad.exists({ _id: id, ...(await visibleFilter(ctx)) }))) throw ApiError.notFound('Ad not found');
  await AdStat.updateOne({ ad: id, day: localDateString() }, { $inc: { [COUNTER[type]]: 1 } }, { upsert: true });
  if (type === 'impression' && placement === 'popup') await AdSeen.updateOne({ ad: id, user: ctx.userId }, { $set: { lastSeenAt: new Date() } }, { upsert: true });
  if (type === 'dismiss' && placement === 'banner') await AdSeen.updateOne({ ad: id, user: ctx.userId }, { $set: { bannerDismissedAt: new Date() } }, { upsert: true });
  return { counted: true };
}
