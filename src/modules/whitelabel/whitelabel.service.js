import crypto from 'node:crypto';
import Reseller from './reseller.model.js';
import LicenceKey from './licenceKey.model.js';
import ResellerInvoice from './resellerInvoice.model.js';
import Society from '../society/society.model.js';
import User from '../users/user.model.js';
import * as usersService from '../users/users.service.js';
import { applyPrepaidTerm } from '../subscriptions/subscriptions.service.js';
import { nextPlatformNumber } from '../subscriptions/platformCounter.model.js';
import { GST_RATE } from '../subscriptions/subscriptions.constants.js';
import * as audit from '../audit/audit.service.js';
import { keyedHash } from '../../common/utils/secretBox.js';
import { storage } from '../../integrations/storage.js';
import { setFromNameResolver } from '../../integrations/email.js';
import ApiError from '../../common/errors/ApiError.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';

// ---------- licence keys ----------
// 32 symbols without look-alikes (no 0/O, 1/I): 12 random symbols = 60 bits per key.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const randomGroup = () => Array.from(crypto.randomBytes(4), (b) => ALPHABET[b % 32]).join('');
export const newKey = () => `CH-${randomGroup()}-${randomGroup()}-${randomGroup()}`;
// Accepts what people type: any case, spaces or missing dashes.
export const normaliseKey = (raw) => {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = s.startsWith('CH') ? s.slice(2) : s;
  return body.length === 12 ? `CH-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}` : null;
};
export const hashKey = (key) => keyedHash(key, 'licence-key');

const DEFAULT_BRAND = Object.freeze({ appName: 'ColonyHub', logoUrl: null, primaryColor: null, supportEmail: null, supportPhone: null, slug: null, reseller: false });
const KEY_PUBLIC = 'last4 plan cycle validityMonths status batch activatedSociety activatedAt expiresAt revokedAt createdAt reseller invoice';

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'partner';
const cleanHost = (host) => (host ? String(host).toLowerCase().trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '') : '');

// ---------- branding ----------
function brandOf(reseller) {
  if (!reseller || reseller.status !== 'active') return { ...DEFAULT_BRAND };
  const b = reseller.brand || {};
  return {
    appName: b.appName || reseller.name,
    logoUrl: b.logoUrl || null,
    primaryColor: b.primaryColor || null,
    supportEmail: b.supportEmail || null,
    supportPhone: b.supportPhone || null,
    slug: reseller.slug,
    reseller: true,
  };
}

// Public: the brand for the login page, by custom domain host first, then ?brand=<slug>.
export async function brandingLookup({ host, slug }) {
  const h = cleanHost(host);
  let reseller = h ? await Reseller.findOne({ 'brand.customDomain': h, status: 'active' }).lean() : null;
  if (!reseller && slug) reseller = await Reseller.findOne({ slug: String(slug).toLowerCase(), status: 'active' }).lean();
  return brandOf(reseller);
}

// Short cache: the header and every outgoing email ask for the society's brand.
const brandCache = new Map();
const BRAND_CACHE_MS = 60 * 1000;
export async function brandForSociety(societyId) {
  const key = String(societyId);
  const hit = brandCache.get(key);
  if (hit && hit.until > Date.now()) return hit.brand;
  const society = await Society.findById(societyId).select('reseller').lean();
  const brand = brandOf(society?.reseller ? await Reseller.findById(society.reseller).lean() : null);
  brandCache.set(key, { brand, until: Date.now() + BRAND_CACHE_MS });
  return brand;
}
const clearBrandCache = () => brandCache.clear();

// Society emails go out under the reseller's app name.
setFromNameResolver(async (societyId) => {
  const brand = await brandForSociety(societyId);
  return brand.reseller ? brand.appName : null;
});

// ---------- resellers (platform console) ----------
async function uniqueSlug(base, excludeId) {
  let slug = slugify(base);
  for (let i = 2; await Reseller.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }); i += 1) slug = `${slugify(base).slice(0, 36)}-${i}`;
  return slug;
}

async function counts(resellerIds) {
  const rows = await LicenceKey.aggregate([{ $match: { reseller: { $in: resellerIds } } }, { $group: { _id: { r: '$reseller', s: '$status' }, n: { $sum: 1 } } }]);
  const out = {};
  for (const r of rows) {
    const k = String(r._id.r);
    out[k] ??= { unused: 0, active: 0, revoked: 0 };
    out[k][r._id.s] = r.n;
  }
  return (id) => out[String(id)] || { unused: 0, active: 0, revoked: 0 };
}

export async function listResellers(filters, pagination) {
  const filter = {};
  if (filters.search) filter.name = { $regex: escapeRegex(filters.search), $options: 'i' };
  if (filters.status) filter.status = filters.status;
  const { items, meta } = await paginate(Reseller, filter, pagination);
  const keysOf = await counts(items.map((r) => r._id));
  return { items: items.map((r) => ({ ...r, keys: keysOf(r._id) })), meta };
}

const assertDomainFree = async (domain, excludeId) => {
  if (domain && (await Reseller.exists({ 'brand.customDomain': domain, ...(excludeId ? { _id: { $ne: excludeId } } : {}) }))) throw ApiError.conflict('Another reseller already uses this domain');
};

export async function createReseller(platformUser, data) {
  const domain = cleanHost(data.brand?.customDomain) || undefined;
  await assertDomainFree(domain);
  const reseller = await Reseller.create({
    ...data,
    slug: await uniqueSlug(data.slug || data.name),
    brand: { ...data.brand, customDomain: domain },
    createdBy: platformUser._id,
  });
  clearBrandCache();
  return getReseller(reseller._id);
}

export async function getReseller(id) {
  const reseller = await Reseller.findById(id).lean();
  if (!reseller) throw ApiError.notFound('Reseller not found');
  const [keys, societies, admins] = await Promise.all([
    counts([reseller._id]),
    Society.find({ reseller: reseller._id }).select('name code city plan active createdAt').sort({ createdAt: -1 }).lean(),
    User.find({ reseller: reseller._id }).select('name email phone status lastLoginAt').lean(),
  ]);
  return { ...reseller, keys: keys(reseller._id), societies, admins };
}

export async function updateReseller(platformUser, id, data) {
  const reseller = await Reseller.findById(id).lean();
  if (!reseller) throw ApiError.notFound('Reseller not found');
  const set = {};
  for (const k of ['name', 'status', 'notes']) if (data[k] !== undefined) set[k] = data[k];
  if (data.slug) set.slug = await uniqueSlug(data.slug, id);
  for (const [k, v] of Object.entries(data.brand || {})) set[`brand.${k}`] = k === 'customDomain' ? cleanHost(v) || undefined : v;
  for (const [k, v] of Object.entries(data.contact || {})) set[`contact.${k}`] = v;
  if (set['brand.customDomain']) await assertDomainFree(set['brand.customDomain'], id);
  const unset = Object.fromEntries(Object.entries(set).filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => [k, 1]));
  for (const k of Object.keys(unset)) delete set[k];
  await Reseller.updateOne({ _id: id }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { runValidators: true });
  clearBrandCache();
  return getReseller(id);
}

// Detects the image type from the first bytes (the browser-declared type can be spoofed).
function sniffImage(buf) {
  if (buf?.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf?.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf?.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export async function uploadLogo(id, file) {
  if (!(await Reseller.exists({ _id: id }))) throw ApiError.notFound('Reseller not found');
  if (!file) throw ApiError.badRequest('Attach the logo in the "file" field');
  const mimetype = sniffImage(file.buffer);
  if (!mimetype) throw ApiError.badRequest('The logo must be a JPG, PNG or WEBP image');
  const stored = await storage.save({ buffer: file.buffer, mimetype, folder: `resellers/${id}` });
  await Reseller.updateOne({ _id: id }, { 'brand.logoUrl': stored.url });
  clearBrandCache();
  return getReseller(id);
}

// Reseller admins: logins limited to one reseller's console.
export async function addAdmin(platformUser, id, { name, email, phone, password }) {
  if (!(await Reseller.exists({ _id: id }))) throw ApiError.notFound('Reseller not found');
  const existing = await User.findOne({ email }).lean();
  if (existing) {
    if (existing.platformRole) throw ApiError.conflict('This person is on the platform team and cannot also be a reseller admin');
    if (existing.reseller && String(existing.reseller) !== String(id)) throw ApiError.conflict('This person already administers another reseller');
    await User.updateOne({ _id: existing._id }, { reseller: id });
  } else {
    if (!password) throw ApiError.badRequest('Set a password for the new login');
    await usersService.assertIdentifiersFree({ email, phone });
    await User.create({ name, email, phone, passwordHash: await User.hashPassword(password), reseller: id });
  }
  return getReseller(id);
}

export async function removeAdmin(platformUser, id, userId) {
  const res = await User.updateOne({ _id: userId, reseller: id }, { $unset: { reseller: 1 } });
  if (!res.matchedCount) throw ApiError.notFound('Admin not found');
  return getReseller(id);
}

// ---------- key packs ----------
// Generates `count` keys for the reseller. The full keys are returned once (and never again); a key-pack
// invoice is raised when pricePerKey > 0.
export async function generateKeys(platformUser, resellerId, { count, plan, cycle, validityMonths, pricePerKey = 0 }) {
  const reseller = await Reseller.findById(resellerId).lean();
  if (!reseller) throw ApiError.notFound('Reseller not found');
  if (reseller.status !== 'active') throw ApiError.conflict('This reseller is suspended');
  const batch = `B${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  let invoice = null;
  if (pricePerKey > 0) {
    const subtotal = pricePerKey * count;
    const gst = Math.round((subtotal * GST_RATE) / 100);
    invoice = await ResellerInvoice.create({
      reseller: resellerId,
      number: await nextPlatformNumber('platform_invoice', 'PINV'),
      batch,
      keys: count,
      plan,
      cycle,
      validityMonths: cycle === 'one_time' ? validityMonths || null : null,
      pricePerKey,
      subtotal,
      gstRate: GST_RATE,
      gst,
      total: subtotal + gst,
      createdBy: platformUser._id,
    });
  }
  const keys = [];
  while (keys.length < count) {
    const key = newKey();
    try {
      // eslint-disable-next-line no-await-in-loop
      await LicenceKey.create({
        reseller: resellerId,
        keyHash: hashKey(key),
        last4: key.slice(-4),
        plan,
        cycle,
        validityMonths: cycle === 'one_time' ? validityMonths || null : null,
        batch,
        invoice: invoice?._id,
        createdBy: platformUser._id,
      });
      keys.push(key);
    } catch (err) {
      if (err.code !== 11000) throw err; // a collision (astronomically rare): draw another
    }
  }
  await Reseller.updateOne({ _id: resellerId }, { $inc: { keysPurchased: count } });
  return { batch, keys, plan, cycle, validityMonths: cycle === 'one_time' ? validityMonths || null : null, invoice: invoice?.toObject() || null };
}

export function listKeys(resellerId, filters, pagination) {
  const filter = { reseller: resellerId };
  if (filters.status) filter.status = filters.status;
  if (filters.batch) filter.batch = filters.batch;
  return paginate(LicenceKey, filter, pagination, { select: KEY_PUBLIC, populate: { path: 'activatedSociety', select: 'name code city' } });
}

// Only unused keys can be revoked: an active key is a society's paid licence.
export async function revokeKey(actor, resellerId, keyId) {
  const key = await LicenceKey.findOneAndUpdate(
    { _id: keyId, reseller: resellerId, status: 'unused' },
    { status: 'revoked', revokedAt: new Date(), revokedBy: actor._id },
    { returnDocument: 'after' },
  ).select(KEY_PUBLIC).lean();
  if (!key) {
    if (await LicenceKey.exists({ _id: keyId, reseller: resellerId })) throw ApiError.conflict('Only unused keys can be revoked');
    throw ApiError.notFound('Key not found');
  }
  return key;
}

export const listInvoices = (resellerId, pagination) => paginate(ResellerInvoice, { reseller: resellerId }, pagination);

export async function markInvoicePaid(platformUser, invoiceId, { method, reference, paidAt }) {
  const invoice = await ResellerInvoice.findOneAndUpdate(
    { _id: invoiceId, status: 'unpaid' },
    { status: 'paid', method, reference, paidAt: paidAt || new Date(), recordedBy: platformUser._id },
    { returnDocument: 'after' },
  ).lean();
  if (!invoice) throw ApiError.conflict('Only unpaid invoices can be marked paid');
  return invoice;
}

// ---------- activation ----------
async function findUsable(raw) {
  const key = normaliseKey(raw);
  if (!key) throw ApiError.badRequest('A licence key looks like CH-XXXX-XXXX-XXXX');
  const doc = await LicenceKey.findOne({ keyHash: hashKey(key) }).lean();
  if (!doc) throw ApiError.notFound('This licence key is not valid');
  if (doc.status === 'active') throw ApiError.conflict('This licence key has already been used');
  if (doc.status === 'revoked') throw ApiError.conflict('This licence key has been revoked');
  const reseller = await Reseller.findById(doc.reseller).select('status').lean();
  if (reseller?.status !== 'active') throw ApiError.conflict('This licence key cannot be used right now. Contact your provider.');
  return { key, doc };
}

export async function assertKeyUsable(raw) {
  await findUsable(raw);
}

// Applies a key to the society: links it to the reseller, sets the plan and prepays the key's term.
export async function activateKey(ctx, raw) {
  const { doc } = await findUsable(raw);
  const society = await Society.findById(ctx.societyId).select('reseller').lean();
  if (!society) throw ApiError.notFound('Society not found');
  if (society.reseller && String(society.reseller) !== String(doc.reseller)) throw ApiError.conflict('Your society is linked to another provider; use a key from them');
  // Claim the key first so two societies can't both use it.
  const claimed = await LicenceKey.findOneAndUpdate(
    { _id: doc._id, status: 'unused' },
    { status: 'active', activatedSociety: ctx.societyId, activatedAt: new Date(), activatedBy: ctx.userId },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw ApiError.conflict('This licence key has already been used');
  await Society.updateOne({ _id: ctx.societyId }, { reseller: doc.reseller });
  clearBrandCache();
  const term = await applyPrepaidTerm(ctx.societyId, { plan: doc.plan, cycle: doc.cycle, validityMonths: doc.validityMonths, keyId: doc._id });
  await LicenceKey.updateOne({ _id: doc._id }, { expiresAt: term.paidUntil });
  audit.record(ctx, 'licence.activated', 'LicenceKey', doc._id, { last4: doc.last4, plan: doc.plan, cycle: doc.cycle, paidUntil: term.paidUntil });
  return { plan: doc.plan, cycle: doc.cycle, validityMonths: doc.validityMonths, last4: doc.last4, paidUntil: term.paidUntil, lifetime: term.lifetime, brand: await brandForSociety(ctx.societyId) };
}

// ---------- reseller console (scoped to the admin's own reseller) ----------
export async function resellerHome(resellerId) {
  const reseller = await Reseller.findById(resellerId).select('-notes -createdBy').lean();
  if (!reseller) throw ApiError.notFound('Reseller not found');
  const [keys, societies] = await Promise.all([counts([reseller._id]), Society.countDocuments({ reseller: reseller._id })]);
  return { reseller, brand: brandOf(reseller), keys: keys(reseller._id), societies };
}

export async function resellerSocieties(resellerId, pagination) {
  const { items, meta } = await paginate(Society, { reseller: resellerId }, pagination, { select: 'name code city plan active createdAt' });
  const keys = await LicenceKey.find({ activatedSociety: { $in: items.map((s) => s._id) }, reseller: resellerId }).select('activatedSociety last4 activatedAt expiresAt plan cycle').lean();
  return { items: items.map((s) => ({ ...s, keys: keys.filter((k) => String(k.activatedSociety) === String(s._id)) })), meta };
}
