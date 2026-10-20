import { closeExpired } from './loginAs.service.js';

// "Log in as" sessions nobody exited are closed and logged once their time is up.
export const LOGIN_AS_JOBS = [{ name: 'loginAs.closeExpired', everyMs: 5 * 60 * 1000, run: () => closeExpired() }];
