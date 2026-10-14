import Upload from './upload.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { storage } from '../../integrations/storage.js';

export const MAX_BYTES = 5 * 1024 * 1024;
export const FOLDERS = ['complaints', 'visitors', 'documents', 'notices', 'staffhr', 'facility', 'household', 'amenities', 'events', 'forum', 'lostfound', 'marketplace', 'chat', 'expenses', 'support', 'builder', 'parcels', 'security', 'luckydraw'];

// Detects the real type from the file's first bytes; the browser-declared type can be spoofed.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return null;
}

export async function save(ctx, file, folder) {
  if (!file) throw ApiError.badRequest('Attach a file in the "file" field');
  const mimetype = sniff(file.buffer);
  if (!mimetype) throw ApiError.badRequest('Only JPG, PNG, WEBP images and PDF files are allowed');
  const stored = await storage.save({ buffer: file.buffer, mimetype, folder: `${ctx.societyId}/${folder}` });
  const doc = await Upload.create({
    society: ctx.societyId,
    owner: ctx.userId,
    folder,
    ...stored,
    mimetype,
    size: file.size,
    name: file.originalname?.slice(0, 120),
  });
  return { _id: doc._id, url: doc.url, mimetype, size: doc.size, name: doc.name };
}

// Turns upload ids sent by a client into attachment records. Only the uploader's own files count,
// so nobody can attach someone else's document by guessing an id.
export async function resolve(ctx, ids = []) {
  if (!ids.length) return [];
  const docs = await Upload.find({ _id: { $in: ids }, society: ctx.societyId, owner: ctx.userId }).lean();
  if (docs.length !== new Set(ids.map(String)).size) throw ApiError.badRequest('One or more attachments are invalid');
  return docs.map((d) => ({ url: d.url, mimetype: d.mimetype, name: d.name }));
}

export async function remove(ctx, id) {
  const doc = await Upload.findOne({ _id: id, society: ctx.societyId, owner: ctx.userId });
  if (!doc) throw ApiError.notFound('File not found');
  await storage.remove(doc.key).catch(() => {});
  await doc.deleteOne();
}
