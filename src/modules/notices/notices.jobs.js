import { publishDue } from './notices.service.js';

// Publishes scheduled notices (notifies the audience) once their publish time arrives.
export default [{ name: 'notices.publishScheduled', everyMs: 60 * 1000, run: () => publishDue() }];
