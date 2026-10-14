// Switchable modules. Everything not listed here (visitors, billing, helpdesk, notices, polls, amenities,
// daily help, SOS...) is "core" and always on. Keys are stable identifiers other modules gate on.
export const FEATURES = Object.freeze([
  { key: 'parking', label: 'Parking', description: 'Parking slots, allocation and stickers' },
  { key: 'events', label: 'Events', description: 'Society events and RSVPs' },
  { key: 'forum', label: 'Forum', description: 'Discussion forum for residents' },
  { key: 'marketplace', label: 'Marketplace', description: 'Buy, sell and services between residents' },
  { key: 'chat', label: 'Chat', description: 'Group and direct chat' },
  { key: 'elections', label: 'Elections', description: 'Committee elections and e-voting' },
  { key: 'accounting', label: 'Accounting', description: 'Double-entry books and financial statements' },
  { key: 'expenses', label: 'Expenses & vendors', description: 'Expense tracking and vendor payments' },
  { key: 'meters', label: 'Meters', description: 'Water / electricity meter readings and billing' },
  { key: 'assets', label: 'Assets & maintenance', description: 'Asset register, PPM and AMC' },
  { key: 'payroll', label: 'Payroll', description: 'Society staff salaries' },
  { key: 'patrols', label: 'Guard patrols', description: 'Patrol rounds and checkpoints' },
  { key: 'parcels', label: 'Parcels', description: 'Parcel and courier register at the gate' },
  { key: 'documents', label: 'Documents', description: 'Society document library' },
  { key: 'requests', label: 'Requests', description: 'NOC, move-in / move-out and other requests' },
  { key: 'builder', label: 'Builder handover', description: 'Possession, snag lists and handover to the association' },
  { key: 'luckyDraw', label: 'Lucky draws', description: 'Society lucky draws that members can join' },
]);

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

const BASIC = ['parking', 'events', 'forum', 'parcels', 'documents', 'requests', 'expenses'];
const STANDARD = [...BASIC, 'marketplace', 'chat', 'elections', 'accounting', 'meters', 'assets', 'patrols'];
// luckyDraw is deliberately in no tier list: only trial and premium (every key) include it.

// What each plan includes before any per-society override. Free = core modules only.
export const PLAN_FEATURES = Object.freeze({
  trial: FEATURE_KEYS, // new societies, until plan.validUntil
  free: [],
  basic: BASIC,
  standard: STANDARD,
  premium: FEATURE_KEYS,
});
