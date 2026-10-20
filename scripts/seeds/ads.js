import zlib from 'node:zlib';
import User from '../../src/modules/users/user.model.js';
import Ad from '../../src/modules/ads/ad.model.js';
import AdMedia from '../../src/modules/ads/adMedia.model.js';
import { storage } from '../../src/integrations/storage.js';
import { addDays } from '../../src/common/utils/dates.js';

// Ads demo: a platform banner, a platform pop-up and one society ad. The pictures are plain two-colour
// placeholders drawn here (no files are downloaded); admins replace them with real images or videos.

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// Horizontal gradient between two RGB colours.
function placeholderPng(width, height, [r1, g1, b1], [r2, g2, b2]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    const t = x / (width - 1);
    row[1 + x * 3] = Math.round(r1 + (r2 - r1) * t);
    row[2 + x * 3] = Math.round(g1 + (g2 - g1) * t);
    row[3 + x * 3] = Math.round(b1 + (b2 - b1) * t);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function mediaFor({ scope, society, owner, png, name }) {
  const stored = await storage.save({ buffer: png, mimetype: 'image/png', folder: scope === 'platform' ? 'platform/ads' : `${society}/ads` });
  const doc = await AdMedia.create({ scope, society, owner, ...stored, mimetype: 'image/png', size: png.length, name });
  return { upload: doc._id, url: doc.url, mimetype: 'image/png' };
}

export default async function seed(s) {
  const { sid } = s;
  const owner = await User.findOne({ platformRole: 'super_admin' }).select('_id').lean();
  const admin = await s.user('admin@demo.test');
  if (!owner || !admin) return;
  const now = new Date();
  const window = { startAt: addDays(now, -1), endAt: addDays(now, 30) };

  const banner = await mediaFor({ scope: 'platform', owner: owner._id, png: placeholderPng(1200, 200, [79, 70, 229], [14, 165, 233]), name: 'home-insurance-banner.png' });
  await Ad.create({
    scope: 'platform',
    title: 'Home insurance from ₹999 a year',
    body: 'Cover your flat against fire, theft and water damage.',
    mediaType: 'image',
    media: banner,
    landingUrl: 'https://colonyhub.example.com/offers/home-insurance',
    ctaLabel: 'Get a quote',
    placement: 'banner',
    audience: { allSocieties: true, societies: [], roles: ['admin', 'resident'], platform: false },
    ...window,
    priority: 10,
    createdBy: owner._id,
  });

  // Pop-up "video" ad. No video file ships with the demo, so it runs as an image (the poster) until a
  // platform admin uploads an MP4/WebM clip in Platform > Ads.
  const poster = await mediaFor({ scope: 'platform', owner: owner._id, png: placeholderPng(800, 450, [15, 23, 42], [234, 88, 12]), name: 'festive-sale-poster.png' });
  await Ad.create({
    scope: 'platform',
    title: 'Festive sale on home appliances',
    body: 'Up to 40% off for ColonyHub residents this month.',
    mediaType: 'image',
    media: poster,
    poster,
    landingUrl: 'https://colonyhub.example.com/offers/festive-sale',
    ctaLabel: 'Shop the sale',
    placement: 'popup',
    frequency: 'daily',
    audience: { allSocieties: true, societies: [], roles: ['resident'], platform: false },
    ...window,
    priority: 5,
    createdBy: owner._id,
  });

  const society = await mediaFor({ scope: 'society', society: sid, owner: admin._id, png: placeholderPng(1200, 200, [5, 150, 105], [250, 204, 21]), name: 'diwali-mela.png' });
  await Ad.create({
    scope: 'society',
    society: sid,
    title: 'Diwali mela at the clubhouse, Sat 6 pm',
    body: 'Food stalls, games for kids and a lucky draw.',
    mediaType: 'image',
    media: society,
    landingUrl: 'https://colonyhub.example.com/greenwood/diwali-mela',
    ctaLabel: 'See details',
    placement: 'banner',
    audience: { allSocieties: false, societies: [], roles: [], platform: false },
    ...window,
    priority: 20,
    createdBy: admin._id,
  });
}
