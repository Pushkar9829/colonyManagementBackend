import { z } from 'zod';
import { dateOnly, hhmm, idParams, noDefaults, objectId, pageQuery, paise } from '../../common/utils/schemas.js';
import { ASSIGNEE_ROLES, CHECK_TYPES, PPM_FREQUENCIES } from './ppmSchedule.model.js';
import { TASK_STATUS } from './ppmTask.model.js';
import { BREAKDOWN_PRIORITY, BREAKDOWN_STATUS } from './breakdown.model.js';
import { WO_SOURCES, WO_STATUS } from './workOrder.model.js';
import { CHECKLIST_AREAS } from './checklist.model.js';
import { RUN_STATUS } from './checklistRun.model.js';

export { idParams };

const text = (max) => z.string().trim().max(max);
const uploadIds = (max = 5) => z.array(objectId()).max(max);
const range = z.object({ from: dateOnly().optional(), to: dateOnly().optional() });

// ---- PPM schedules ----
const checkItem = z
  .object({
    _id: objectId().optional(), // keep ids stable when editing so old results still line up
    label: text(120).min(2),
    type: z.enum(CHECK_TYPES).default('yes_no'),
    unit: text(20).optional(),
    min: z.coerce.number().optional(),
    max: z.coerce.number().optional(),
    required: z.boolean().default(true),
  })
  .refine((v) => v.min === undefined || v.max === undefined || v.max >= v.min, { message: 'max must be ≥ min', path: ['max'] });

const scheduleFields = {
  asset: objectId(),
  title: text(120).min(3),
  description: text(1000).optional(),
  frequency: z.enum(PPM_FREQUENCIES),
  intervalDays: z.coerce.number().int().min(1).max(3650).optional(),
  startDate: dateOnly(),
  endDate: dateOnly().optional(),
  checklist: z.array(checkItem).max(50).default([]),
  assigneeRole: z.enum(ASSIGNEE_ROLES).default('staff'),
  assignee: objectId().optional(),
  leadDays: z.coerce.number().int().min(0).max(60).default(7),
  graceDays: z.coerce.number().int().min(0).max(60).default(3),
  active: z.boolean().optional(),
};
const intervalRule = (v) => v.frequency !== 'every_n_days' || v.intervalDays;
const endRule = (v) => !v.endDate || !v.startDate || v.endDate >= v.startDate;

export const createSchedule = z
  .object(scheduleFields)
  .refine(intervalRule, { message: 'Interval (days) is required for "every N days"', path: ['intervalDays'] })
  .refine(endRule, { message: 'End date must be after the start date', path: ['endDate'] });

const { asset: _asset, ...editable } = scheduleFields;
export const updateSchedule = z
  .object({ ...noDefaults(editable), assignee: objectId().nullable(), endDate: dateOnly().nullable() })
  .partial()
  .refine((v) => !v.frequency || intervalRule(v), { message: 'Interval (days) is required for "every N days"', path: ['intervalDays'] });

export const listSchedules = pageQuery.extend({ asset: objectId().optional(), active: z.stringbool().optional() });

// ---- PPM tasks ----
export const listTasks = pageQuery.extend({
  status: z.enum(TASK_STATUS).optional(),
  asset: objectId().optional(),
  schedule: objectId().optional(),
  date: dateOnly().optional(),
  from: dateOnly().optional(),
  to: dateOnly().optional(),
  mine: z.stringbool().optional(),
  open: z.stringbool().optional(), // pending + overdue
});

export const completeTask = z.object({
  results: z.array(z.object({ itemId: objectId(), value: z.union([z.boolean(), z.number(), z.string().trim().max(500)]).nullable().optional() })).max(50).default([]),
  photos: uploadIds(6).optional(),
  remarks: text(1000).optional(),
  raiseBreakdown: z.object({ title: text(120).min(3), priority: z.enum(BREAKDOWN_PRIORITY).default('high') }).optional(),
});

export const skipTask = z.object({ reason: text(300).min(3) });
export const reassignTask = z.object({ assignee: objectId().nullable(), assigneeRole: z.enum(ASSIGNEE_ROLES).optional() });

export const ppmReport = range;

// ---- breakdowns ----
export const createBreakdown = z.object({
  asset: objectId(),
  title: text(120).min(3),
  description: text(2000).optional(),
  priority: z.enum(BREAKDOWN_PRIORITY).default('high'),
  complaint: objectId().optional(),
  ppmTask: objectId().optional(),
  assignedTo: objectId().optional(),
  markUnderRepair: z.boolean().default(true),
  attachments: uploadIds().optional(),
});
export const listBreakdowns = pageQuery.extend({ status: z.enum(BREAKDOWN_STATUS).optional(), asset: objectId().optional(), open: z.stringbool().optional() });
export const breakdownStatus = z.object({
  status: z.enum(['in_progress', 'resolved', 'closed']),
  resolution: text(2000).optional(),
  cost: paise().optional(),
  attachments: uploadIds().optional(),
});
export const assignBreakdown = z.object({ assignedTo: objectId() });

// ---- work orders ----
export const createWorkOrder = z
  .object({
    title: text(120).min(3),
    scope: text(4000).optional(),
    source: z.enum(WO_SOURCES).default('adhoc'),
    asset: objectId().optional(),
    ppmTask: objectId().optional(),
    breakdown: objectId().optional(),
    location: text(120).optional(),
    vendor: objectId().optional(),
    vendorName: text(120).optional(),
    technician: objectId().optional(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
    estimate: paise().default(0),
    dueDate: dateOnly().optional(),
    attachments: uploadIds().optional(),
  })
  .refine((v) => v.vendorName || v.technician, { message: 'Choose a vendor or a technician', path: ['vendorName'] });

export const updateWorkOrder = z
  .object({
    title: text(120).min(3),
    scope: text(4000),
    location: text(120),
    vendor: objectId().nullable(),
    vendorName: text(120).nullable(),
    technician: objectId().nullable(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    estimate: paise(),
    dueDate: dateOnly().nullable(),
  })
  .partial();

export const listWorkOrders = pageQuery.extend({
  status: z.enum(WO_STATUS).optional(),
  asset: objectId().optional(),
  vendor: objectId().optional(),
  open: z.stringbool().optional(),
  mine: z.stringbool().optional(),
});

export const workOrderStatus = z.object({
  status: z.enum(['in_progress', 'completed', 'verified', 'cancelled']),
  note: text(1000).optional(),
  actualCost: paise().optional(),
  attachments: uploadIds(6).optional(), // completion proof
});

// ---- housekeeping checklists ----
const checklistFields = {
  name: text(100).min(2),
  area: z.enum(CHECKLIST_AREAS).default('other'),
  location: text(120).optional(),
  items: z.array(z.object({ _id: objectId().optional(), label: text(120).min(2) })).min(1).max(40),
  slots: z.array(z.object({ label: text(40).min(1), dueBy: hhmm() })).min(1).max(6),
  days: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  assigneeRole: z.enum(ASSIGNEE_ROLES).default('staff'),
  assignee: objectId().optional(),
  requirePhoto: z.boolean().default(true),
  graceMinutes: z.coerce.number().int().min(0).max(720).default(120),
  active: z.boolean().optional(),
};
export const createChecklist = z.object(checklistFields);
export const updateChecklist = z.object({ ...noDefaults(checklistFields), assignee: objectId().nullable() }).partial();

export const listRuns = pageQuery.extend({
  date: dateOnly().optional(),
  from: dateOnly().optional(),
  to: dateOnly().optional(),
  status: z.enum(RUN_STATUS).optional(),
  checklist: objectId().optional(),
  mine: z.stringbool().optional(),
});
export const completeRun = z.object({
  items: z.array(z.object({ itemId: objectId(), done: z.boolean(), note: text(200).optional() })).max(40),
  photos: uploadIds(6).optional(),
  remarks: text(1000).optional(),
});
export const verifyRun = z.object({ approved: z.boolean(), note: text(300).optional() });
export const runReport = range;
