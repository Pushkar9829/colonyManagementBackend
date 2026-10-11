import { z } from 'zod';
import { idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { LISTING_CATEGORIES, LISTING_CONDITIONS, LISTING_STATUS, LISTING_TYPES, PRICE_UNITS } from './listing.model.js';
import { BUSINESS_CATEGORIES } from './business.model.js';

export { idParams };

const listingFields = {
  title: z.string().trim().min(3).max(100),
  description: z.string().trim().max(2000).optional(),
  category: z.enum(LISTING_CATEGORIES).default('other'),
  condition: z.enum(LISTING_CONDITIONS).default('not_applicable'),
  price: paise().max(10_000_000_00).default(0),
  priceUnit: z.enum(PRICE_UNITS).default('total'),
  negotiable: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  photos: z.array(objectId()).max(8).optional(), // upload ids (folder "marketplace")
};

export const createListing = z.object({ type: z.enum(LISTING_TYPES), ...listingFields });

export const updateListing = z.object({
  title: listingFields.title.optional(),
  description: listingFields.description,
  category: z.enum(LISTING_CATEGORIES).optional(),
  condition: z.enum(LISTING_CONDITIONS).optional(),
  price: paise().max(10_000_000_00).optional(),
  priceUnit: z.enum(PRICE_UNITS).optional(),
  negotiable: z.boolean().optional(),
  showPhone: z.boolean().optional(),
  photos: listingFields.photos, // added to the existing photos
  removePhotos: z.array(z.string().max(500)).max(8).optional(), // photo urls to drop
});

export const listingStatus = z.object({ status: z.enum(['active', 'sold', 'closed']) });
export const removeListing = z.object({ reason: z.string().trim().max(300).optional() });

export const listListings = pageQuery.extend({
  type: z.enum(LISTING_TYPES).optional(),
  category: z.enum(LISTING_CATEGORIES).optional(),
  status: z.enum(LISTING_STATUS).optional(),
  mine: z.stringbool().optional(),
  search: z.string().trim().max(60).optional(),
  maxPrice: paise().optional(),
});

export const report = z.object({
  reason: z.enum(['spam', 'scam', 'prohibited', 'offensive', 'wrong_category', 'other']),
  note: z.string().trim().max(500).optional(),
});
export const listReports = pageQuery.extend({ status: z.enum(['open', 'dismissed', 'actioned']).optional() });
export const resolveReport = z.object({ action: z.enum(['dismiss', 'remove']), reason: z.string().trim().max(300).optional() });

export const contact = z.object({ message: z.string().trim().min(1).max(1000).default('Hi! Is this still available?') });

const businessFields = {
  name: z.string().trim().min(2).max(100),
  category: z.enum(BUSINESS_CATEGORIES),
  description: z.string().trim().max(2000).optional(),
  priceNote: z.string().trim().max(120).optional(),
  timings: z.string().trim().max(120).optional(),
  contactPhone: phone().optional(),
  photos: z.array(objectId()).max(6).optional(),
};
export const createBusiness = z.object(businessFields);
export const updateBusiness = z.object(Object.fromEntries(Object.entries(businessFields).map(([k, v]) => [k, v.optional()])));
export const reviewBusiness = z.object({ status: z.enum(['approved', 'rejected']), reason: z.string().trim().max(300).optional() });
export const listBusinesses = pageQuery.extend({
  category: z.enum(BUSINESS_CATEGORIES).optional(),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  mine: z.stringbool().optional(),
  search: z.string().trim().max(60).optional(),
});
