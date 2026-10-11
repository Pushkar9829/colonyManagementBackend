import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;
const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });
const photoSchema = new mongoose.Schema({ url: String, mimetype: String, name: String, by: { type: ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } });

const eventSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: ['festival', 'sports', 'meeting', 'kids', 'cultural', 'workshop', 'other'], default: 'other' },
    cover: attachmentSchema,
    venue: { type: String, trim: true },
    amenity: { type: ObjectId, ref: 'Amenity' }, // optional: held at a bookable amenity
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    audience: {
      type: { type: String, enum: ['all', 'blocks', 'roles'], default: 'all' },
      blocks: [{ type: ObjectId, ref: 'Block' }],
      roles: [String],
    },
    capacity: { type: Number, min: 1 }, // total headcount; unset = unlimited
    rsvpDeadline: Date, // unset = until the event starts
    maxGuests: { type: Number, min: 0, max: 20, default: 4 }, // extra people per RSVP
    ticketPrice: { type: Number, min: 0, default: 0 }, // paise per person; 0 = free
    allowOnlinePayment: { type: Boolean, default: true },
    status: { type: String, enum: ['scheduled', 'cancelled'], default: 'scheduled' },
    cancelReason: String,
    // denormalised counters, changed atomically so capacity can't be oversold
    goingCount: { type: Number, default: 0 }, // confirmed headcount
    waitlistCount: { type: Number, default: 0 }, // waitlisted RSVPs
    gallery: [photoSchema],
    reminderSentAt: Date,
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
eventSchema.index({ society: 1, startAt: 1 });
eventSchema.index({ status: 1, startAt: 1, reminderSentAt: 1 });

export default mongoose.model('Event', eventSchema);
