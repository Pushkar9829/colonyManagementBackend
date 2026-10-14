import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { INCIDENT_TYPES, OB_CATEGORIES, SEVERITY, SHIFTS } from './guardDuty.model.js';

export { idParams };

const pendingItems = z.array(z.object({ text: z.string().trim().min(1).max(200), done: z.boolean().default(false) })).max(30);

export const createHandover = z.object({
  shift: z.enum(SHIFTS),
  gateId: objectId().optional(), // omitted = the guard's current gate
  gate: z.string().trim().max(40).optional(), // legacy: gate name
  toGuard: objectId().optional(),
  notes: z.string().trim().max(2000).optional(),
  incidents: z.string().trim().max(2000).optional(),
  keys: z.array(z.object({ name: z.string().trim().min(1).max(60), status: z.enum(['with_guard', 'issued', 'missing']).default('with_guard'), holder: z.string().trim().max(60).optional() })).max(50).default([]),
  pendingItems: pendingItems.default([]),
});
export const acknowledge = z.object({ note: z.string().trim().max(500).optional(), pendingItems: pendingItems.optional() });
export const listHandovers = pageQuery.extend({ status: z.enum(['open', 'acknowledged']).optional() });

export const createIncident = z.object({
  type: z.enum(INCIDENT_TYPES),
  severity: z.enum(SEVERITY).default('medium'),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(3000).optional(),
  location: z.string().trim().max(120).optional(),
  occurredAt: z.coerce.date().optional(),
  photos: z.array(objectId()).max(6).default([]),
  visitorId: objectId().optional(),
  vehicleNumber: z.string().trim().max(15).transform((v) => v.replace(/[\s-]+/g, '').toUpperCase()).optional(),
});
export const closeIncident = z.object({ actionTaken: z.string().trim().min(3).max(1000) });
export const listIncidents = pageQuery.extend({
  status: z.enum(['open', 'closed']).optional(),
  type: z.enum(INCIDENT_TYPES).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const occurrenceBook = z.object({ date: dateOnly().optional() });
export const addOccurrence = z.object({ text: z.string().trim().min(2).max(500), category: z.enum(OB_CATEGORIES).default('note'), occurredAt: z.coerce.date().optional() });
