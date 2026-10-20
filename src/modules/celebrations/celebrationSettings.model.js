import mongoose from 'mongoose';
import { LANGUAGES } from './celebrations.templates.js';

// "Celebrations" society setting. Societies without a row use the defaults below (on, 08:00 IST).
const celebrationSettingsSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    enabled: { type: Boolean, default: true },
    sendTime: { type: String, default: '08:00' }, // HH:MM IST
    channels: {
      whatsapp: { type: Boolean, default: true }, // still subject to the society's WhatsApp mode and credits
      inapp: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
    },
    language: { type: String, enum: LANGUAGES, default: 'en' },
    // Custom text; empty means the default for `language`.
    templates: {
      birthday: { type: String, trim: true, maxlength: 600 },
      anniversary: { type: String, trim: true, maxlength: 600 },
    },
    // Society-wide "Today's birthdays" card on the dashboard (only people who opted in appear).
    dashboardCard: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
celebrationSettingsSchema.index({ society: 1 }, { unique: true });

export default mongoose.model('CelebrationSettings', celebrationSettingsSchema);
