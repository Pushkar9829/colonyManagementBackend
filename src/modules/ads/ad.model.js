import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const AD_SCOPES = ['platform', 'society'];
export const AD_PLACEMENTS = ['banner', 'popup', 'both'];
export const AD_FREQUENCIES = ['once', 'daily', 'every_visit'];
export const AD_ROLES = ['admin', 'accountant', 'facility_manager', 'guard', 'resident', 'staff'];

const mediaSchema = new mongoose.Schema(
  {
    upload: { type: ObjectId, ref: 'AdMedia' },
    url: { type: String, required: true },
    mimetype: { type: String, required: true },
  },
  { _id: false },
);

// A banner and/or pop-up ad. Platform ads are run by the platform team for all or chosen societies; society ads
// are run by a society's admin / facility manager for its own members only.
const adSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: AD_SCOPES, required: true },
    society: { type: ObjectId, ref: 'Society' }, // society ads only
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    mediaType: { type: String, enum: ['image', 'video'], required: true },
    media: { type: mediaSchema, required: true },
    poster: mediaSchema, // still image shown before / instead of a video
    landingUrl: { type: String, required: true },
    ctaLabel: { type: String, trim: true, default: 'Learn more' },
    placement: { type: String, enum: AD_PLACEMENTS, default: 'banner' },
    audience: {
      allSocieties: { type: Boolean, default: true }, // platform ads
      societies: [{ type: ObjectId, ref: 'Society' }], // platform ads, when allSocieties is false
      roles: [{ type: String, enum: AD_ROLES }], // empty = every role
      platform: { type: Boolean, default: false }, // platform ads: also show in the platform console
    },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    frequency: { type: String, enum: AD_FREQUENCIES, default: 'daily' }, // pop-ups
    priority: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: ObjectId, ref: 'User', required: true },
    updatedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
adSchema.index({ society: 1, active: 1, endAt: 1 });
adSchema.index({ scope: 1, active: 1, endAt: 1 });

export default mongoose.model('Ad', adSchema);
