import { expireHolds } from './amenities.service.js';
import { expirePasses } from './passes.service.js';

const MIN = 60 * 1000;

export const AMENITY_JOBS = [
  { name: 'amenity-payment-holds', everyMs: 5 * MIN, run: () => expireHolds() },
  { name: 'amenity-pass-expiry', everyMs: 60 * MIN, run: () => expirePasses() },
];
