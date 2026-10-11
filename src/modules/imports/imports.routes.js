import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import ApiError from '../../common/errors/ApiError.js';
import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import * as service from './imports.service.js';

const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } }).single('file');
const receive = (req, res, next) =>
  parser(req, res, (err) => (err ? next(ApiError.badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 3 MB' : err.message)) : next()));

const kindParams = z.object({ kind: z.enum(Object.keys(service.KINDS)) });

// Bulk onboarding from spreadsheets (admin only): template → preview (dry run) → commit.
const router = Router();
router.use(authenticate, requireSociety, authorize());

router.get(
  '/:kind/template',
  validate({ params: kindParams }),
  asyncHandler(async (req, res) => {
    const buf = await service.template(req.params.kind);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="colonyhub-${req.params.kind}-template.xlsx"`,
    });
    res.send(Buffer.from(buf));
  }),
);
router.post('/:kind/preview', validate({ params: kindParams }), receive, asyncHandler(async (req, res) => ok(res, await service.preview(ctx(req), req.params.kind, req.file))));
router.post('/:kind/commit', validate({ params: kindParams }), receive, asyncHandler(async (req, res) => ok(res, await service.commit(ctx(req), req.params.kind, req.file))));

export default router;
