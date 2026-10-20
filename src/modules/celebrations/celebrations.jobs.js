import { sendDueWishes } from './celebrations.service.js';

// Every 15 minutes: each society's wishes go out on the first run after its send time (idempotent).
export const CELEBRATION_JOBS = [{ name: 'celebration-wishes', everyMs: 15 * 60 * 1000, run: () => sendDueWishes() }];
