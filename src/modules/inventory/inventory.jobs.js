import { reorderAlerts } from './inventory.service.js';

const HOUR = 60 * 60 * 1000;

export const INVENTORY_JOBS = [{ name: 'facility-inventory-reorder-alerts', everyMs: 6 * HOUR, run: () => reorderAlerts() }];
