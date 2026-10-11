import { expireOld } from './lostFound.service.js';

// Lost & found posts auto-expire 30 days after they were posted.
export default [{ name: 'lostFound.expire', everyMs: 60 * 60 * 1000, run: () => expireOld() }];
