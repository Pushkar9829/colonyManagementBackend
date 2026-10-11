import { syncAllSocieties } from './sync.service.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const ACCOUNTING_JOBS = [
  // Posts new/changed bills, payments, adjustments, amenity payments, payslips and vendor documents.
  { name: 'accounting-sync', everyMs: 15 * MIN, run: () => syncAllSocieties() },
  // Nightly safety net: re-checks every source document in case a change slipped past the cursor.
  { name: 'accounting-full-sync', everyMs: 24 * HOUR, run: () => syncAllSocieties({ full: true }) },
];
