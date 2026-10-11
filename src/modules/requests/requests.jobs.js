import { notifyGuardsForToday } from './requests.service.js';

// On a moving day, tells the guards which approved move-ins / move-outs to expect.
export default [{ name: 'requests-move-day-guards', everyMs: 30 * 60 * 1000, run: () => notifyGuardsForToday() }];
