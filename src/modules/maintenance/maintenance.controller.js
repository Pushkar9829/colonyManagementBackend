import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as ppm from './maintenance.service.js';
import * as wo from './workOrders.service.js';
import * as hk from './housekeeping.service.js';

const paged = (fn) =>
  asyncHandler(async (req, res) => {
    const q = query(req);
    const { items, meta } = await fn(ctx(req), q, getPagination(q), req);
    ok(res, items, meta);
  });
const one = (fn, make = ok) => asyncHandler(async (req, res) => make(res, await fn(ctx(req), req)));

// PPM
export const stats = one((c) => ppm.ppmStats(c));
export const listSchedules = paged((c, q, p) => ppm.listSchedules(c, q, p));
export const createSchedule = one((c, req) => ppm.createSchedule(c, req.body), created);
export const getSchedule = one((c, req) => ppm.getSchedule(c, req.params.id));
export const updateSchedule = one((c, req) => ppm.updateSchedule(c, req.params.id, req.body));
export const listTasks = paged((c, q, p) => ppm.listTasks(c, q, p));
export const getTask = one((c, req) => ppm.getTask(c, req.params.id));
export const completeTask = one((c, req) => ppm.completeTask(c, req.params.id, req.body));
export const skipTask = one((c, req) => ppm.skipTask(c, req.params.id, req.body));
export const reassignTask = one((c, req) => ppm.reassignTask(c, req.params.id, req.body));
export const ppmReport = one((c, req) => ppm.ppmReport(c, query(req)));

// Breakdowns
export const listBreakdowns = paged((c, q, p) => ppm.listBreakdowns(c, q, p));
export const createBreakdown = one((c, req) => ppm.createBreakdown(c, req.body), created);
export const getBreakdown = one((c, req) => ppm.getBreakdown(c, req.params.id));
export const assignBreakdown = one((c, req) => ppm.assignBreakdown(c, req.params.id, req.body));
export const breakdownStatus = one((c, req) => ppm.changeBreakdownStatus(c, req.params.id, req.body));

// Work orders
export const woStats = one((c) => wo.stats(c));
export const listWorkOrders = paged((c, q, p) => wo.list(c, q, p));
export const createWorkOrder = one((c, req) => wo.create(c, req.body), created);
export const getWorkOrder = one((c, req) => wo.getById(c, req.params.id));
export const updateWorkOrder = one((c, req) => wo.update(c, req.params.id, req.body));
export const workOrderStatus = one((c, req) => wo.changeStatus(c, req.params.id, req.body));

// Housekeeping checklists
export const listChecklists = one((c) => hk.listChecklists(c));
export const createChecklist = one((c, req) => hk.createChecklist(c, req.body), created);
export const updateChecklist = one((c, req) => hk.updateChecklist(c, req.params.id, req.body));
export const listRuns = paged((c, q, p) => hk.listRuns(c, q, p));
export const completeRun = one((c, req) => hk.completeRun(c, req.params.id, req.body));
export const verifyRun = one((c, req) => hk.verifyRun(c, req.params.id, req.body));
export const runReport = one((c, req) => hk.runReport(c, query(req)));
