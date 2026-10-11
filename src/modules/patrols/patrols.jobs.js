import { detectMissedRounds } from './patrols.service.js';
import { settingsLookup } from '../visitors/securitySettings.service.js';

export const PATROL_JOBS = [{ name: 'patrol-missed-checkpoints', everyMs: 5 * 60 * 1000, run: () => detectMissedRounds(settingsLookup) }];
