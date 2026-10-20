// Scheduled jobs contributed by feature modules.
// Each module exports an array of { name, everyMs, run } from src/modules/<module>/<module>.jobs.js
// and adds it here with one import line and one spread line. Names must be unique.
// ---- job imports (add below this line) ----
import { CELEBRATION_JOBS } from '../modules/celebrations/celebrations.jobs.js';
import { LOGIN_AS_JOBS } from '../modules/loginAs/loginAs.jobs.js';
import luckyDrawJobs from '../modules/luckyDraw/luckyDraw.jobs.js';
import { ASSET_JOBS } from '../modules/assets/assets.jobs.js';
import { MAINTENANCE_JOBS } from '../modules/maintenance/maintenance.jobs.js';
import { INVENTORY_JOBS } from '../modules/inventory/inventory.jobs.js';
import { STAFFHR_JOBS } from '../modules/staffhr/staffhr.jobs.js';
import { VISITOR_JOBS } from '../modules/visitors/visitors.jobs.js';
import { PARCEL_JOBS } from '../modules/parcels/parcels.jobs.js';
import { PATROL_JOBS } from '../modules/patrols/patrols.jobs.js';
import { PARKING_JOBS } from '../modules/parking/parking.jobs.js';
import { EMERGENCY_JOBS } from '../modules/emergency/emergency.jobs.js';
import { SUBSCRIPTION_JOBS } from '../modules/subscriptions/subscriptions.jobs.js';
import { SUPPORT_JOBS } from '../modules/support/support.jobs.js';
import { REPORT_JOBS } from '../modules/reports/reports.jobs.js';
import { AMENITY_JOBS } from '../modules/amenities/amenities.jobs.js';
import { COMPLAINT_JOBS } from '../modules/complaints/complaints.jobs.js';
import { DAILY_HELP_JOBS } from '../modules/dailyHelp/dailyHelp.jobs.js';
import { TENANCY_JOBS } from '../modules/tenancy/tenancy.jobs.js';
import { ACCOUNTING_JOBS } from '../modules/accounting/accounting.jobs.js';
import { EXPENSE_JOBS } from '../modules/expenses/expenses.jobs.js';
import paymentJobs from '../modules/payments/payments.jobs.js';
import electionJobs from '../modules/elections/elections.jobs.js';
import documentJobs from '../modules/documents/documents.jobs.js';
import requestJobs from '../modules/requests/requests.jobs.js';
import noticeJobs from '../modules/notices/notices.jobs.js';
import eventJobs from '../modules/events/events.jobs.js';
import lostFoundJobs from '../modules/lostFound/lostFound.jobs.js';

export const MODULE_JOBS = [
  // ---- job spreads (add below this line) ----
  ...CELEBRATION_JOBS,
  ...LOGIN_AS_JOBS,
  ...luckyDrawJobs,
  ...ASSET_JOBS,
  ...MAINTENANCE_JOBS,
  ...INVENTORY_JOBS,
  ...STAFFHR_JOBS,
  ...VISITOR_JOBS,
  ...PARCEL_JOBS,
  ...PATROL_JOBS,
  ...PARKING_JOBS,
  ...EMERGENCY_JOBS,
  ...SUBSCRIPTION_JOBS,
  ...SUPPORT_JOBS,
  ...REPORT_JOBS,
  ...AMENITY_JOBS,
  ...COMPLAINT_JOBS,
  ...DAILY_HELP_JOBS,
  ...TENANCY_JOBS,
  ...ACCOUNTING_JOBS,
  ...EXPENSE_JOBS,
  ...paymentJobs,
  ...electionJobs,
  ...documentJobs,
  ...requestJobs,
  ...noticeJobs,
  ...eventJobs,
  ...lostFoundJobs,
];
