import { z } from 'zod';
import { idParams, noDefaults, objectId, pageQuery } from '../../common/utils/schemas.js';
import { AD_FREQUENCIES, AD_PLACEMENTS, AD_ROLES } from './ad.model.js';

export { idParams };

// Ads open outside the app, so only full https links (no credentials in the link).
export const httpsUrl = () =>
  z
    .string()
    .trim()
    .max(500)
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'https:' && Boolean(u.hostname) && !u.username && !u.password;
      } catch {
        return false;
      }
    }, 'Use a full https:// link');

const audience = z
  .object({
    allSocieties: z.boolean().optional(),
    societies: z.array(objectId()).max(500).optional(),
    roles: z.array(z.enum(AD_ROLES)).optional(),
    platform: z.boolean().optional(),
  })
  .strict();

const fields = {
  title: z.string().trim().min(2).max(80),
  body: z.string().trim().max(200).optional(),
  mediaId: objectId(),
  posterId: objectId().nullable().optional(),
  landingUrl: httpsUrl(),
  ctaLabel: z.string().trim().min(1).max(24).default('Learn more'),
  placement: z.enum(AD_PLACEMENTS).default('banner'),
  audience: audience.optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  frequency: z.enum(AD_FREQUENCIES).default('daily'),
  priority: z.coerce.number().int().min(0).max(100).default(0),
  active: z.boolean().default(true),
};

export const createAd = z.object(fields).strict().refine((d) => d.endAt > d.startAt, { message: 'The end must be after the start', path: ['endAt'] });
export const updateAd = z.object(noDefaults(fields)).partial().strict();

export const listAds = pageQuery.extend({
  status: z.enum(['live', 'scheduled', 'ended', 'paused']).optional(),
  search: z.string().trim().max(80).optional(),
  society: objectId().optional(),
});
export const statsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).optional() });
export const eventBody = z.object({ placement: z.enum(['banner', 'popup']).optional() });
export const societiesQuery = pageQuery.extend({ search: z.string().trim().max(80).optional() });
export const societySetting = z.object({ allowSocietyAds: z.boolean() }).strict();
