import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, ok } from '../../common/utils/response.js';
import { ctx, query } from '../../common/utils/context.js';
import { getPagination } from '../../common/utils/pagination.js';
import * as service from './registers.service.js';

const paged = (fn) => asyncHandler(async (req, res) => {
  const q = query(req);
  const { items, meta } = await fn(ctx(req), q, getPagination(q));
  ok(res, items, meta);
});

const sendPdf = (res, { buffer, filename }) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.send(buffer);
};

export const mine = asyncHandler(async (req, res) => ok(res, await service.mine(ctx(req))));

export const listMembers = paged(service.listMembers);
export const getMember = asyncHandler(async (req, res) => ok(res, await service.getMember(ctx(req), req.params.id)));
export const createMember = asyncHandler(async (req, res) => created(res, (await service.createMember(ctx(req), req.body)).toObject()));
export const updateMember = asyncHandler(async (req, res) => ok(res, await service.updateMember(ctx(req), req.params.id, req.body)));
export const ceaseMember = asyncHandler(async (req, res) => ok(res, await service.ceaseMember(ctx(req), req.params.id, req.body)));
export const jForm = asyncHandler(async (req, res) => ok(res, await service.jForm(ctx(req))));
export const jFormPdf = asyncHandler(async (req, res) => sendPdf(res, await service.jFormPdf(ctx(req))));

export const listCertificates = paged(service.listCertificates);
export const getCertificate = asyncHandler(async (req, res) => ok(res, await service.getCertificate(ctx(req), req.params.id)));
export const issueCertificate = asyncHandler(async (req, res) => created(res, await service.issueCertificate(ctx(req), req.body)));
export const cancelCertificate = asyncHandler(async (req, res) => ok(res, await service.cancelCertificate(ctx(req), req.params.id, req.body)));
export const certificatePdf = asyncHandler(async (req, res) => sendPdf(res, await service.certificatePdf(ctx(req), req.params.id)));

export const listTransfers = paged(service.listTransfers);
export const transfer = asyncHandler(async (req, res) => created(res, await service.transfer(ctx(req), req.body)));

export const listNominations = paged(service.listNominations);
export const createNomination = asyncHandler(async (req, res) => created(res, await service.createNomination(ctx(req), req.body)));
export const revokeNomination = asyncHandler(async (req, res) => ok(res, await service.revokeNomination(ctx(req), req.params.id)));
