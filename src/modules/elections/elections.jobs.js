import { autoClose } from './elections.service.js';

// Closes elections whose voting window has ended and seals the results.
export default [{ name: 'elections-auto-close', everyMs: 5 * 60 * 1000, run: () => autoClose() }];
