import Society from './society.model.js';
import Block from '../units/block.model.js';
import Unit from '../units/unit.model.js';
import Membership from '../users/membership.model.js';
import Notice from '../notices/notice.model.js';
import Amenity from '../amenities/amenity.model.js';
import FinanceSettings from '../financeSettings/financeSettings.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { STAFF_ROLES } from '../../common/constants/index.js';
import * as audit from '../audit/audit.service.js';

const LIVE = { $in: ['active', 'pending'] };

// The first-run checklist for a new society admin. Computed live from the data itself, so a step done
// some other way (bulk import, seed, another admin) still counts.
export async function setupStatus(ctx) {
  const society = ctx.societyId;
  const now = new Date();
  const [doc, blocks, units, residents, staff, notice, amenities, finance] = await Promise.all([
    Society.findById(society).select('settings.billing setupChecklistDismissedAt').lean(),
    Block.exists({ society }),
    Unit.exists({ society }),
    Membership.exists({ society, role: 'resident', status: LIVE, support: { $ne: true } }),
    Membership.exists({ society, role: { $in: STAFF_ROLES }, status: LIVE, support: { $ne: true } }),
    Notice.exists({ society, $or: [{ publishAt: null }, { publishAt: { $lte: now } }] }),
    Amenity.exists({ society }),
    // a finance settings document only exists once someone has saved the finance settings page
    FinanceSettings.exists({ society }),
  ]);
  if (!doc) throw ApiError.notFound('Society not found');
  const billing = doc.settings?.billing || {};

  const steps = [
    { key: 'blocks', title: 'Create blocks or towers', done: Boolean(blocks), link: '/units' },
    { key: 'units', title: 'Add units (flats)', done: Boolean(units), link: '/units' },
    { key: 'residents', title: 'Invite or approve your first resident', done: Boolean(residents), link: '/members' },
    { key: 'billing', title: 'Set the maintenance charge', done: billing.fixedAmount > 0 || billing.perSqftRate > 0, link: '/settings' },
    { key: 'staff', title: 'Add a guard or staff member', done: Boolean(staff), link: '/members' },
    { key: 'notice', title: 'Publish your first notice', done: Boolean(notice), link: '/notices' },
    { key: 'amenities', title: 'Add amenities (clubhouse, hall…)', done: Boolean(amenities), link: '/amenities' },
    { key: 'finance', title: 'Review finance settings (GST, autopay)', done: Boolean(finance), link: '/finance/settings' },
  ];
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, dismissedAt: doc.setupChecklistDismissedAt || null };
}

export async function dismissSetup(ctx) {
  await Society.updateOne({ _id: ctx.societyId }, { $set: { setupChecklistDismissedAt: new Date() } });
  audit.record(ctx, 'society.setup_dismissed', 'Society', ctx.societyId);
  return setupStatus(ctx);
}
