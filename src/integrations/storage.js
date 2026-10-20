import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import env from '../config/env.js';

// Storage adapters share one interface:
//   save({ buffer, mimetype, originalname, folder }) -> { url, key, provider }
//   remove(key) -> Promise<void>

export const UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf', 'video/mp4': '.mp4', 'video/webm': '.webm' };

const local = {
  name: 'local',
  async save({ buffer, mimetype, folder }) {
    // Unguessable name: links are only as private as they are hard to guess.
    const key = `${folder}/${crypto.randomBytes(16).toString('hex')}${EXT[mimetype] || ''}`;
    const full = path.join(UPLOAD_DIR, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buffer);
    return { url: `${env.PUBLIC_URL.replace(/\/$/, '')}/uploads/${key}`, key, provider: 'local' };
  },
  async remove(key) {
    const full = path.join(UPLOAD_DIR, key);
    if (!full.startsWith(UPLOAD_DIR)) return; // never escape the upload dir
    await fs.rm(full, { force: true });
  },
};

function cloudinarySignature(params) {
  const toSign = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + env.CLOUDINARY_API_SECRET).digest('hex');
}

const cloudinary = {
  name: 'cloudinary',
  async save({ buffer, mimetype, folder }) {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { folder: `colonyhub/${folder}`, timestamp };
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimetype }));
    form.append('api_key', env.CLOUDINARY_API_KEY);
    form.append('timestamp', String(timestamp));
    form.append('folder', params.folder);
    form.append('signature', cloudinarySignature(params));
    const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/auto/upload`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`Cloudinary upload failed (${res.status})`);
    const json = await res.json();
    return { url: json.secure_url, key: `${json.resource_type}:${json.public_id}`, provider: 'cloudinary' };
  },
  async remove(key) {
    const [resourceType, publicId] = key.split(/:(.*)/s);
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: publicId, timestamp };
    const form = new URLSearchParams({ public_id: publicId, timestamp: String(timestamp), api_key: env.CLOUDINARY_API_KEY, signature: cloudinarySignature(params) });
    await fetch(`https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD_NAME}/${resourceType}/destroy`, { method: 'POST', body: form });
  },
};

export const storage = env.STORAGE_PROVIDER === 'cloudinary' ? cloudinary : local;
