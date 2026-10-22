import mongoose from 'mongoose';

// One row per society: which template its app uses and who may change it. Created on first change; a
// society without a row uses the platform default template, its plan's allowance and adminMayChange = true.
const societyAppearanceSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true, unique: true },
    template: { type: String, trim: true }, // catalogue key; empty = platform default
    // Set by the platform ("force a template"): stays even when the plan does not include it, until the
    // colony admin applies another one (if allowed).
    forced: { type: Boolean, default: false },
    allowedTemplates: { type: [String], default: [] }, // platform override; empty = the plan's allowance
    adminMayChange: { type: Boolean, default: true },
    logoUrl: { type: String, trim: true },
    coverUrl: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
societyAppearanceSchema.index({ template: 1 });

export const SocietyAppearance = mongoose.model('SocietyAppearance', societyAppearanceSchema);

// Which templates each plan may use. Missing plans fall back to DEFAULT_PLAN_TEMPLATES in the catalogue.
const templatePlanRuleSchema = new mongoose.Schema(
  {
    plan: { type: String, required: true, unique: true },
    templates: { type: [String], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const TemplatePlanRule = mongoose.model('TemplatePlanRule', templatePlanRuleSchema);

// Platform-wide switches: templates switched off for everyone, and the default for new / unset colonies.
const templateSettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    disabled: { type: [String], default: [] },
    defaultTemplate: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
export const TemplateSetting = mongoose.model('TemplateSetting', templateSettingSchema);
