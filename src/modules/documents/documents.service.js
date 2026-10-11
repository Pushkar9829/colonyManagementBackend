import LibraryDocument from './document.model.js';
import DocumentFolder, { DEFAULT_FOLDERS } from './documentFolder.model.js';
import DocumentDownload from './documentDownload.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { ROLES } from '../../common/constants/index.js';
import { paginate } from '../../common/utils/pagination.js';
import { escapeRegex } from '../../common/utils/strings.js';
import { addDays, localDateString } from '../../common/utils/dates.js';
import * as uploads from '../uploads/uploads.service.js';
import * as audit from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { canManage, managerUserIds } from '../committee/committee.service.js';
import Society from '../society/society.model.js';

const slugify = (name) => name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ---- visibility ----

async function visibilityFilter(ctx, manage) {
  if (ctx.role === ROLES.ADMIN) return {};
  const or = [{ 'visibility.type': 'all' }, { 'visibility.type': 'roles', 'visibility.roles': ctx.role }];
  if (manage) or.push({ 'visibility.type': 'committee' });
  return { $or: or };
}

const daysUntil = (iso) => (iso ? Math.round((new Date(`${iso}T00:00:00Z`) - new Date(`${localDateString()}T00:00:00Z`)) / 86400000) : null);

// File links are never listed; they are handed out by download() so every download is recorded.
function present(doc, manage) {
  const d = doc.toObject ? doc.toObject() : doc;
  const current = d.versions?.find((v) => v.version === d.currentVersion);
  const left = daysUntil(d.expiryDate);
  return {
    ...d,
    versions: (d.versions || []).map(({ url, ...v }) => v).sort((a, b) => b.version - a.version),
    file: current ? { name: current.name, mimetype: current.mimetype, uploadedAt: current.uploadedAt } : null,
    daysToExpiry: left,
    expiryState: left === null ? null : left < 0 ? 'expired' : left <= d.remindDaysBefore ? 'expiring' : 'valid',
    downloads: manage ? d.downloads : undefined,
    lastReminderAt: manage ? d.lastReminderAt : undefined,
  };
}

// ---- folders ----

async function ensureFolders(societyId) {
  if (await DocumentFolder.exists({ society: societyId, system: true })) return;
  await DocumentFolder.bulkWrite(
    DEFAULT_FOLDERS.map((name, order) => ({
      updateOne: { filter: { society: societyId, slug: slugify(name) }, update: { $setOnInsert: { name, system: true, order } }, upsert: true },
    })),
  );
}

export async function listFolders(ctx) {
  await ensureFolders(ctx.societyId);
  const manage = await canManage(ctx);
  const [folders, counts] = await Promise.all([
    DocumentFolder.find({ society: ctx.societyId }).sort({ order: 1, name: 1 }).lean(),
    LibraryDocument.aggregate([
      { $match: { society: ctx.societyId, archived: false, ...(await visibilityFilter(ctx, manage)) } },
      { $group: { _id: '$folder', n: { $sum: 1 } } },
    ]),
  ]);
  const byFolder = new Map(counts.map((c) => [String(c._id), c.n]));
  return folders.map((f) => ({ ...f, documents: byFolder.get(String(f._id)) || 0 }));
}

export async function createFolder(ctx, { name }) {
  await ensureFolders(ctx.societyId);
  const slug = slugify(name);
  if (!slug) throw ApiError.badRequest('Folder name needs letters or numbers');
  try {
    const folder = await DocumentFolder.create({ society: ctx.societyId, name, slug });
    return { ...folder.toObject(), documents: 0 };
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('A folder with this name already exists');
    throw err;
  }
}

export async function renameFolder(ctx, id, { name }) {
  const folder = await DocumentFolder.findOne({ _id: id, society: ctx.societyId });
  if (!folder) throw ApiError.notFound('Folder not found');
  folder.name = name;
  if (!folder.system) folder.slug = slugify(name);
  try {
    await folder.save();
  } catch (err) {
    if (err?.code === 11000) throw ApiError.conflict('A folder with this name already exists');
    throw err;
  }
  return folder.toObject();
}

export async function removeFolder(ctx, id) {
  const folder = await DocumentFolder.findOne({ _id: id, society: ctx.societyId });
  if (!folder) throw ApiError.notFound('Folder not found');
  if (folder.system) throw ApiError.conflict('Default folders cannot be deleted');
  if (await LibraryDocument.exists({ society: ctx.societyId, folder: folder._id, archived: false })) throw ApiError.conflict('Move or archive the documents in this folder first');
  await folder.deleteOne();
}

async function assertFolder(ctx, id) {
  if (!(await DocumentFolder.exists({ _id: id, society: ctx.societyId }))) throw ApiError.badRequest('Folder not found');
}

// ---- documents ----

export async function list(ctx, filters, pagination) {
  const manage = await canManage(ctx);
  const filter = { society: ctx.societyId, archived: Boolean(manage && filters.archived), ...(await visibilityFilter(ctx, manage)) };
  if (filters.folder) filter.folder = filters.folder;
  if (filters.tag) filter.tags = filters.tag.toLowerCase();
  if (filters.q) {
    const rx = { $regex: escapeRegex(filters.q), $options: 'i' };
    filter.$and = [{ $or: [{ title: rx }, { description: rx }, { tags: rx }] }];
  }
  if (filters.expiring) {
    filter.expiryDate = { $ne: null, $lte: localDateString(addDays(new Date(), 60)) };
  }
  const result = await paginate(LibraryDocument, filter, pagination, {
    sort: filters.expiring ? { expiryDate: 1 } : { updatedAt: -1 },
    populate: { path: 'folder', select: 'name' },
  });
  result.items = result.items.map((d) => present(d, manage));
  return result;
}

export async function tags(ctx) {
  const manage = await canManage(ctx);
  const rows = await LibraryDocument.aggregate([
    { $match: { society: ctx.societyId, archived: false, ...(await visibilityFilter(ctx, manage)) } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', n: { $sum: 1 } } },
    { $sort: { n: -1, _id: 1 } },
    { $limit: 50 },
  ]);
  return rows.map((r) => ({ tag: r._id, count: r.n }));
}

async function loadVisible(ctx, id, manage) {
  const doc = await LibraryDocument.findOne({ _id: id, society: ctx.societyId, ...(manage ? {} : { archived: false }), ...(await visibilityFilter(ctx, manage)) });
  if (!doc) throw ApiError.notFound('Document not found');
  return doc;
}

async function loadForManager(ctx, id) {
  const doc = await LibraryDocument.findOne({ _id: id, society: ctx.societyId });
  if (!doc) throw ApiError.notFound('Document not found');
  return doc;
}

async function resolveOne(ctx, uploadId) {
  const [file] = await uploads.resolve(ctx, [uploadId]);
  return file;
}

const normaliseVisibility = (v) => (v?.type === 'roles' ? { type: 'roles', roles: v.roles } : { type: v?.type || 'all', roles: [] });

export async function create(ctx, { upload, note, visibility, tags: t, ...data }) {
  await assertFolder(ctx, data.folder);
  const file = await resolveOne(ctx, upload);
  const doc = await LibraryDocument.create({
    ...data,
    tags: [...new Set((t || []).map((x) => x.toLowerCase()))],
    visibility: normaliseVisibility(visibility),
    society: ctx.societyId,
    currentVersion: 1,
    versions: [{ version: 1, ...file, note, uploadedBy: ctx.userId }],
    createdBy: ctx.userId,
  });
  audit.record(ctx, 'document.uploaded', 'LibraryDocument', doc._id, { title: doc.title });
  return present(await LibraryDocument.findById(doc._id).populate('folder', 'name').lean(), true);
}

export async function getById(ctx, id) {
  const manage = await canManage(ctx);
  const doc = await loadVisible(ctx, id, manage);
  await doc.populate([{ path: 'folder', select: 'name' }, { path: 'versions.uploadedBy', select: 'name' }, { path: 'createdBy', select: 'name' }]);
  return { ...present(doc, manage), canManage: manage };
}

export async function update(ctx, id, { visibility, tags: t, ...data }) {
  const doc = await loadForManager(ctx, id);
  if (data.folder) await assertFolder(ctx, data.folder);
  Object.assign(doc, data);
  if (visibility) doc.visibility = normaliseVisibility(visibility);
  if (t) doc.tags = [...new Set(t.map((x) => x.toLowerCase()))];
  // a new expiry date restarts the reminder cycle
  if (data.expiryDate !== undefined) doc.lastReminderAt = undefined;
  await doc.save();
  audit.record(ctx, 'document.updated', 'LibraryDocument', doc._id, { fields: [...Object.keys(data), ...(visibility ? ['visibility'] : []), ...(t ? ['tags'] : [])] });
  return getById(ctx, id);
}

// A new version becomes current; older versions stay downloadable.
export async function addVersion(ctx, id, { upload, note, expiryDate }) {
  const doc = await loadForManager(ctx, id);
  if (doc.archived) throw ApiError.conflict('Restore the document before adding a version');
  const file = await resolveOne(ctx, upload);
  const version = Math.max(0, ...doc.versions.map((v) => v.version)) + 1;
  doc.versions.push({ version, ...file, note, uploadedBy: ctx.userId });
  doc.currentVersion = version;
  if (expiryDate) {
    doc.expiryDate = expiryDate;
    doc.lastReminderAt = undefined;
  }
  await doc.save();
  audit.record(ctx, 'document.version_added', 'LibraryDocument', doc._id, { version });
  return getById(ctx, id);
}

export async function setArchived(ctx, id, archived) {
  const doc = await loadForManager(ctx, id);
  doc.archived = archived;
  await doc.save();
  audit.record(ctx, archived ? 'document.archived' : 'document.restored', 'LibraryDocument', doc._id, { title: doc.title });
  return getById(ctx, id);
}

export async function download(ctx, id, versionNo) {
  const manage = await canManage(ctx);
  const doc = await loadVisible(ctx, id, manage);
  const version = doc.versions.find((v) => v.version === (versionNo || doc.currentVersion));
  if (!version) throw ApiError.notFound('Version not found');
  await Promise.all([
    DocumentDownload.create({ society: ctx.societyId, document: doc._id, version: version.version, user: ctx.userId, role: ctx.role }),
    LibraryDocument.updateOne({ _id: doc._id }, { $inc: { downloads: 1 } }),
  ]);
  return { url: version.url, name: version.name, mimetype: version.mimetype, version: version.version };
}

export async function downloads(ctx, id, pagination) {
  await loadForManager(ctx, id);
  return paginate(DocumentDownload, { society: ctx.societyId, document: id }, pagination, { sort: { at: -1 }, populate: { path: 'user', select: 'name' } });
}

// ---- expiry reminders (scheduler) ----

// Reminds the committee when a document (insurance, lift licence, AMC...) nears expiry,
// at most once a week, and once more after it has lapsed.
export async function expiryReminders(now = new Date()) {
  const today = localDateString(now);
  const horizon = localDateString(addDays(now, 365));
  const candidates = await LibraryDocument.find({
    archived: false,
    expiryDate: { $ne: null, $lte: horizon },
    $or: [{ lastReminderAt: null }, { lastReminderAt: { $lte: addDays(now, -7) } }],
  })
    .select('society title expiryDate remindDaysBefore lastReminderAt')
    .limit(2000)
    .lean();
  const dayDiff = (iso) => Math.round((new Date(`${iso}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
  const due = candidates.filter((d) => {
    const left = dayDiff(d.expiryDate);
    if (left > d.remindDaysBefore) return false;
    // after expiry, one final reminder only
    return left >= 0 || !d.lastReminderAt || new Date(d.lastReminderAt) < new Date(`${d.expiryDate}T00:00:00+05:30`);
  });
  const active = new Set((await Society.find({ _id: { $in: [...new Set(due.map((d) => String(d.society)))] }, active: true }).select('_id').lean()).map((s) => String(s._id)));
  let reminded = 0;
  for (const d of due) {
    if (!active.has(String(d.society))) continue;
    const left = dayDiff(d.expiryDate);
    // eslint-disable-next-line no-await-in-loop
    await notifyUsers(d.society, await managerUserIds(d.society), {
      type: 'document',
      title: left < 0 ? `Expired: ${d.title}` : `${d.title} expires ${left === 0 ? 'today' : `in ${left} day(s)`}`,
      body: `Expiry date ${d.expiryDate}. Upload the renewed document as a new version.`,
      link: `/documents/${d._id}`,
      channels: ['inapp', 'push', 'email'],
    });
    reminded += 1;
  }
  if (due.length) await LibraryDocument.updateMany({ _id: { $in: due.filter((d) => active.has(String(d.society))).map((d) => d._id) } }, { lastReminderAt: now });
  return { reminded };
}
