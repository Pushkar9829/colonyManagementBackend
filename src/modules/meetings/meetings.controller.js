import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './meetings.service.js';

const p = (req) => req.params;

export const list = asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await service.list(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});
export const getById = asyncHandler(async (req, res) => ok(res, await service.getById(ctx(req), p(req).id)));
export const create = asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body)));
export const update = asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), p(req).id, req.body)));
export const sendNotice = asyncHandler(async (req, res) => ok(res, await service.sendNotice(ctx(req), p(req).id)));
export const cancel = asyncHandler(async (req, res) => ok(res, await service.cancel(ctx(req), p(req).id, req.body.reason)));
export const invitees = asyncHandler(async (req, res) => ok(res, await service.invitees(ctx(req), p(req).id)));

export const addAgendaItem = asyncHandler(async (req, res) => created(res, await service.addAgendaItem(ctx(req), p(req).id, req.body)));
export const updateAgendaItem = asyncHandler(async (req, res) => ok(res, await service.updateAgendaItem(ctx(req), p(req).id, p(req).itemId, req.body)));
export const removeAgendaItem = asyncHandler(async (req, res) => ok(res, await service.removeAgendaItem(ctx(req), p(req).id, p(req).itemId)));
export const updateMinutes = asyncHandler(async (req, res) => ok(res, await service.updateMinutes(ctx(req), p(req).id, req.body)));
export const approveMinutes = asyncHandler(async (req, res) => ok(res, await service.approveMinutes(ctx(req), p(req).id)));

export const markAttendance = asyncHandler(async (req, res) => ok(res, await service.markAttendance(ctx(req), p(req).id, req.body)));
export const removeAttendance = asyncHandler(async (req, res) => ok(res, await service.removeAttendance(ctx(req), p(req).id, p(req).membershipId)));

export const addResolution = asyncHandler(async (req, res) => created(res, await service.addResolution(ctx(req), p(req).id, req.body)));
export const updateResolution = asyncHandler(async (req, res) => ok(res, await service.updateResolution(ctx(req), p(req).id, p(req).resolutionId, req.body)));
export const removeResolution = asyncHandler(async (req, res) => ok(res, await service.removeResolution(ctx(req), p(req).id, p(req).resolutionId)));

export const listActionItems = asyncHandler(async (req, res) => ok(res, await service.listActionItems(ctx(req), query(req))));
export const addActionItem = asyncHandler(async (req, res) => created(res, await service.addActionItem(ctx(req), p(req).id, req.body)));
export const updateActionItem = asyncHandler(async (req, res) => ok(res, await service.updateActionItem(ctx(req), p(req).id, p(req).actionId, req.body)));
export const removeActionItem = asyncHandler(async (req, res) => ok(res, await service.removeActionItem(ctx(req), p(req).id, p(req).actionId)));

export const addAttachments = asyncHandler(async (req, res) => ok(res, await service.addAttachments(ctx(req), p(req).id, req.body.uploads)));
export const removeAttachment = asyncHandler(async (req, res) => ok(res, await service.removeAttachment(ctx(req), p(req).id, p(req).attachmentId)));

export const minutesPdf = asyncHandler(async (req, res) => {
  const { buffer, filename } = await service.minutesPdf(ctx(req), p(req).id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.send(buffer);
});
