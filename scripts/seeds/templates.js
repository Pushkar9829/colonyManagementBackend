import Society from '../../src/modules/society/society.model.js';
import Reseller from '../../src/modules/whitelabel/reseller.model.js';
import { SocietyAppearance, TemplatePlanRule, TemplateSetting } from '../../src/modules/appearance/appearance.model.js';
import { DEFAULT_PLAN_TEMPLATES, TEMPLATE_KEYS } from '../../src/modules/appearance/templates.catalogue.js';

// App templates demo:
// - plan rules as the catalogue defaults (trial / premium all 10, standard 6, basic 3, free 1), all templates on
// - Green Valley (demo society) on Classic Blue, all 10 allowed, its admin may change it; a generated cover
//   picture (served by the web app) so the cover-photo layouts have something to show
// - SmartNest Lakeview (reseller society) on Ocean Teal, the SmartNest colour overriding the template palette
// Runs after billingWhitelabel (which creates SmartNest). Idempotent.
const DEMO_COVER = '/templates/demo-cover.svg';

export default async function seed(s) {
  await TemplateSetting.deleteMany({});
  await TemplateSetting.create({ key: 'global', disabled: [], defaultTemplate: 'classic-blue' });
  await TemplatePlanRule.deleteMany({});
  await TemplatePlanRule.insertMany(Object.entries(DEFAULT_PLAN_TEMPLATES).map(([plan, templates]) => ({ plan, templates })));

  const admin = await s.user('admin@demo.test');
  await SocietyAppearance.updateOne(
    { society: s.sid },
    { $set: { template: 'classic-blue', forced: false, allowedTemplates: TEMPLATE_KEYS, adminMayChange: true, coverUrl: DEMO_COVER, updatedBy: admin?._id }, $unset: { logoUrl: 1 } },
    { upsert: true },
  );

  const reseller = await Reseller.findOne({ slug: 'smartnest' });
  if (reseller) {
    await Reseller.updateOne({ _id: reseller._id }, { $set: { 'templates.allowed': [], 'templates.brandOverridesTemplate': true } });
    const lakeview = await Society.findOne({ code: 'SNLAKE' }).select('_id').lean();
    if (lakeview) {
      await SocietyAppearance.updateOne(
        { society: lakeview._id },
        { $set: { template: 'ocean-teal', forced: false, allowedTemplates: [], adminMayChange: true, coverUrl: DEMO_COVER } },
        { upsert: true },
      );
    }
  }
  console.log('  templates: Green Valley on Classic Blue (all 10 allowed), SmartNest Lakeview on Ocean Teal (brand override)');
}
