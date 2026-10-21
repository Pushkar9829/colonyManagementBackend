import Listing from './listing.model.js';
import ListingReport from './listingReport.model.js';
import Business from './business.model.js';
import User from '../users/user.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { notifyRoles, notifyUsers } from '../notifications/notifications.service.js';
import { invalidate } from '../../realtime/socket.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import * as chat from '../chat/chat.service.js';
import { isModerator, MODERATORS, memberSummaries, sameId } from '../directory/members.js';

const page = (items, total, { page: p, limit }) => ({ items, meta: { page: p, limit, total, pages: Math.ceil(total / limit) || 1 } });

// ---------------- listings ----------------

async function presentListings(ctx, rows) {
  const people = await memberSummaries(ctx.societyId, rows.map((r) => r.seller));
  // phone numbers only for sellers who opted in on that listing
  const phoneIds = rows.filter((r) => r.showPhone).map((r) => r.seller);
  const phones = new Map((phoneIds.length ? await User.find({ _id: { $in: phoneIds } }).select('phone').lean() : []).map((u) => [String(u._id), u.phone]));
  const reported = new Set(
    (await ListingReport.find({ society: ctx.societyId, reporter: ctx.userId, listing: { $in: rows.map((r) => r._id) } }).select('listing').lean()).map((r) => String(r.listing)),
  );
  return rows.map((r) => {
    const s = people.get(String(r.seller));
    const seller = { _id: r.seller, name: s?.name || 'Former member', units: s?.units || [] };
    if (r.showPhone && phones.get(String(r.seller))) seller.phone = phones.get(String(r.seller));
    const out = { ...r, seller, isMine: sameId(r.seller, ctx.userId), reportedByMe: reported.has(String(r._id)) };
    if (!isModerator(ctx) && !out.isMine) delete out.reportCount;
    return out;
  });
}

async function loadListing(ctx, id) {
  const listing = await Listing.findOne({ _id: id, society: ctx.societyId });
  // removed listings stay visible only to their seller and moderators
  if (!listing || (listing.status === 'removed' && !sameId(listing.seller, ctx.userId) && !isModerator(ctx))) throw ApiError.notFound('Listing not found');
  return listing;
}

const ownOnly = (ctx, listing) => {
  if (!sameId(listing.seller, ctx.userId)) throw ApiError.forbidden('Only the seller can change this listing');
};

export async function createListing(ctx, data) {
  const photos = await uploads.resolve(ctx, data.photos);
  if (photos.some((p) => !p.mimetype.startsWith('image/'))) throw ApiError.badRequest('Listing photos must be images');
  const listing = await Listing.create({
    ...data,
    price: data.type === 'free' ? 0 : data.price,
    photos,
    society: ctx.societyId,
    seller: ctx.userId,
    unit: ctx.unitId || undefined,
  });
  invalidate(ctx.societyId, ['marketplace']);
  return (await presentListings(ctx, [listing.toObject()]))[0];
}

export async function listListings(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.mine) {
    filter.seller = ctx.userId;
    if (filters.status) filter.status = filters.status;
  } else if (filters.status && isModerator(ctx)) {
    filter.status = filters.status;
  } else {
    filter.status = filters.status === 'sold' ? 'sold' : 'active';
  }
  if (filters.type) filter.type = filters.type;
  if (filters.category) filter.category = filters.category;
  if (filters.search) {
    const re = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ title: re }, { description: re }];
  }
  if (filters.maxPrice !== undefined) filter.price = { $lte: filters.maxPrice };
  const [rows, total] = await Promise.all([
    Listing.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    Listing.countDocuments(filter),
  ]);
  return page(await presentListings(ctx, rows), total, pagination);
}

export async function getListing(ctx, id) {
  const listing = await loadListing(ctx, id);
  return (await presentListings(ctx, [listing.toObject()]))[0];
}

export async function updateListing(ctx, id, data) {
  const listing = await loadListing(ctx, id);
  ownOnly(ctx, listing);
  if (listing.status === 'removed') throw ApiError.conflict('This listing was removed by the moderators');
  const { photos: photoIds, ...rest } = data;
  Object.assign(listing, rest);
  if (photoIds) {
    const photos = await uploads.resolve(ctx, photoIds);
    if (photos.some((p) => !p.mimetype.startsWith('image/'))) throw ApiError.badRequest('Listing photos must be images');
    listing.photos = [...listing.photos, ...photos].slice(0, 8);
  }
  if (data.removePhotos?.length) listing.photos = listing.photos.filter((p) => !data.removePhotos.includes(p.url));
  if (listing.type === 'free') listing.price = 0;
  await listing.save();
  return (await presentListings(ctx, [listing.toObject()]))[0];
}

// Seller lifecycle: active <-> sold / closed.
export async function setListingStatus(ctx, id, { status }) {
  const listing = await loadListing(ctx, id);
  ownOnly(ctx, listing);
  if (listing.status === 'removed') throw ApiError.conflict('This listing was removed by the moderators');
  if (listing.status === status) throw ApiError.conflict('Listing is already {status}', { params: { status } });
  listing.status = status;
  listing.soldAt = status === 'sold' ? new Date() : undefined;
  await listing.save();
  invalidate(ctx.societyId, ['marketplace']);
  return (await presentListings(ctx, [listing.toObject()]))[0];
}

export async function deleteListing(ctx, id, reason) {
  const listing = await loadListing(ctx, id);
  if (sameId(listing.seller, ctx.userId)) {
    await listing.deleteOne();
    await ListingReport.deleteMany({ society: ctx.societyId, listing: listing._id });
  } else if (isModerator(ctx)) {
    await removeByModerator(ctx, listing, reason || 'Removed by the moderators');
  } else {
    throw ApiError.forbidden();
  }
  invalidate(ctx.societyId, ['marketplace']);
}

async function removeByModerator(ctx, listing, reason) {
  listing.status = 'removed';
  listing.removedReason = reason;
  await listing.save();
  await ListingReport.updateMany({ society: ctx.societyId, listing: listing._id, status: 'open' }, { status: 'actioned', resolvedBy: ctx.userId, resolvedAt: new Date() });
  await notifyUsers(ctx.societyId, [listing.seller], { type: 'marketplace', title: `Your listing "${listing.title}" was removed`, body: reason, link: '/marketplace?mine=true' });
  audit.record(ctx, 'listing.removed', 'Listing', listing._id, { title: listing.title, reason });
}

export async function reportListing(ctx, id, { reason, note }) {
  const listing = await loadListing(ctx, id);
  if (sameId(listing.seller, ctx.userId)) throw ApiError.badRequest('You cannot report your own listing');
  try {
    await ListingReport.create({ society: ctx.societyId, listing: listing._id, reporter: ctx.userId, reason, note });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict('You already reported this listing');
    throw err;
  }
  const updated = await Listing.findOneAndUpdate({ _id: listing._id }, { $inc: { reportCount: 1 } }, { returnDocument: 'after' }).lean();
  if (updated.reportCount === 1) {
    await notifyRoles(ctx.societyId, MODERATORS, { type: 'marketplace', title: 'Marketplace listing reported', body: `"${listing.title}" · ${reason.replace('_', ' ')}`, link: '/marketplace?tab=moderation' });
  }
  return { reported: true };
}

export async function listReports(ctx, { status = 'open' }, pagination) {
  const filter = { society: ctx.societyId, status };
  const [rows, total] = await Promise.all([
    ListingReport.find(filter).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit).populate('listing', 'title type status seller photos price').lean(),
    ListingReport.countDocuments(filter),
  ]);
  const people = await memberSummaries(ctx.societyId, rows.flatMap((r) => [r.reporter, r.listing?.seller]));
  const items = rows.map((r) => ({
    ...r,
    reporter: people.get(String(r.reporter)) || { _id: r.reporter, name: 'Former member' },
    listing: r.listing ? { ...r.listing, seller: people.get(String(r.listing.seller)) || { _id: r.listing.seller, name: 'Former member' } } : null,
  }));
  return page(items, total, pagination);
}

export async function resolveReport(ctx, id, { action, reason }) {
  const report = await ListingReport.findOne({ _id: id, society: ctx.societyId });
  if (!report) throw ApiError.notFound('Report not found');
  if (report.status !== 'open') throw ApiError.conflict('This report was already handled');
  if (action === 'remove') {
    const listing = await Listing.findOne({ _id: report.listing, society: ctx.societyId });
    if (listing && listing.status !== 'removed') await removeByModerator(ctx, listing, reason || 'Removed after a report');
    else await ListingReport.updateMany({ society: ctx.societyId, listing: report.listing, status: 'open' }, { status: 'actioned', resolvedBy: ctx.userId, resolvedAt: new Date() });
  } else {
    report.status = 'dismissed';
    report.resolvedBy = ctx.userId;
    report.resolvedAt = new Date();
    await report.save();
    audit.record(ctx, 'listing.report_dismissed', 'ListingReport', report._id);
  }
  return ListingReport.findById(id).lean();
}

// "Is this still available?" — opens a chat with the seller with the listing attached.
export async function contactSeller(ctx, id, { message }) {
  const listing = await loadListing(ctx, id);
  if (listing.status !== 'active') throw ApiError.conflict('This listing is {status}', { params: { status: listing.status } });
  if (sameId(listing.seller, ctx.userId)) throw ApiError.badRequest('This is your own listing');
  return chat.contactAbout(ctx, listing.seller, message, { type: 'listing', id: listing._id, title: listing.title });
}

// ---------------- local businesses ----------------

async function presentBusinesses(ctx, rows) {
  const people = await memberSummaries(ctx.societyId, rows.map((r) => r.owner));
  return rows.map((b) => {
    const isMine = sameId(b.owner, ctx.userId);
    const out = { ...b, owner: people.get(String(b.owner)) || { _id: b.owner, name: 'Former member', units: [] }, isMine };
    if (!isMine && !isModerator(ctx)) {
      delete out.rejectReason;
      delete out.reviewedBy;
    }
    return out;
  });
}

async function loadBusiness(ctx, id) {
  const b = await Business.findOne({ _id: id, society: ctx.societyId });
  if (!b || (b.status !== 'approved' && !sameId(b.owner, ctx.userId) && !isModerator(ctx))) throw ApiError.notFound('Business not found');
  return b;
}

export async function createBusiness(ctx, data) {
  const photos = await uploads.resolve(ctx, data.photos);
  const business = await Business.create({ ...data, photos, society: ctx.societyId, owner: ctx.userId, status: 'pending' });
  await notifyRoles(ctx.societyId, ['admin'], { type: 'marketplace', title: 'Local business awaiting approval', body: `${business.name} (${business.category})`, link: '/marketplace?tab=businesses' });
  return (await presentBusinesses(ctx, [business.toObject()]))[0];
}

export async function listBusinesses(ctx, filters, pagination) {
  const filter = { society: ctx.societyId };
  if (filters.mine) filter.owner = ctx.userId;
  else if (ctx.role === 'admin' && filters.status) filter.status = filters.status;
  else filter.status = 'approved';
  if (filters.category) filter.category = filters.category;
  if (filters.search) {
    const re = new RegExp(escapeRegex(filters.search), 'i');
    filter.$or = [{ name: re }, { description: re }];
  }
  const [rows, total] = await Promise.all([
    Business.find(filter).sort({ status: 1, name: 1 }).skip(pagination.skip).limit(pagination.limit).lean(),
    Business.countDocuments(filter),
  ]);
  return page(await presentBusinesses(ctx, rows), total, pagination);
}

export async function updateBusiness(ctx, id, data) {
  const b = await loadBusiness(ctx, id);
  if (!sameId(b.owner, ctx.userId)) throw ApiError.forbidden('Only the owner can edit this business');
  const { photos: photoIds, ...rest } = data;
  Object.assign(b, rest);
  if (photoIds) b.photos = [...b.photos, ...(await uploads.resolve(ctx, photoIds))].slice(0, 6);
  // changed details need a fresh approval
  if (b.status !== 'pending') {
    b.status = 'pending';
    b.rejectReason = undefined;
    await notifyRoles(ctx.societyId, ['admin'], { type: 'marketplace', title: 'Local business updated — review needed', body: b.name, link: '/marketplace?tab=businesses' });
  }
  await b.save();
  return (await presentBusinesses(ctx, [b.toObject()]))[0];
}

export async function reviewBusiness(ctx, id, { status, reason }) {
  const b = await Business.findOne({ _id: id, society: ctx.societyId });
  if (!b) throw ApiError.notFound('Business not found');
  if (status === 'rejected' && !reason) throw ApiError.badRequest('Give a reason for rejecting');
  b.status = status;
  b.reviewedBy = ctx.userId;
  b.reviewedAt = new Date();
  b.rejectReason = status === 'rejected' ? reason : undefined;
  await b.save();
  await notifyUsers(ctx.societyId, [b.owner], {
    type: 'marketplace',
    title: status === 'approved' ? `${b.name} is now listed` : `${b.name} was not approved`,
    body: status === 'approved' ? 'Neighbours can now find your business in the marketplace.' : reason,
    link: '/marketplace?tab=businesses',
  });
  audit.record(ctx, `business.${status}`, 'Business', b._id, { name: b.name, reason });
  invalidate(ctx.societyId, ['marketplace']);
  return (await presentBusinesses(ctx, [b.toObject()]))[0];
}

export async function deleteBusiness(ctx, id) {
  const b = await loadBusiness(ctx, id);
  if (!sameId(b.owner, ctx.userId) && !isModerator(ctx)) throw ApiError.forbidden();
  await b.deleteOne();
  if (!sameId(b.owner, ctx.userId)) audit.record(ctx, 'business.deleted', 'Business', b._id, { name: b.name });
}

export async function contactBusiness(ctx, id, { message }) {
  const b = await loadBusiness(ctx, id);
  if (b.status !== 'approved') throw ApiError.conflict('This business is not listed yet');
  if (sameId(b.owner, ctx.userId)) throw ApiError.badRequest('This is your own business');
  return chat.contactAbout(ctx, b.owner, message, { type: 'business', id: b._id, title: b.name });
}
