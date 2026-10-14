import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { asyncHandler } from '../../common/utils/asyncHandler.js';
import { created, noContent, ok } from '../../common/utils/response.js';
import { ctx } from '../../common/utils/context.js';
import { idParams, objectId } from '../../common/utils/schemas.js';
import { DEVICE_SCOPES, DEVICE_TYPES } from './deviceKey.model.js';
import * as service from './devices.service.js';

const createSchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z.enum(DEVICE_TYPES).default('other'),
  location: z.string().trim().max(80).optional(),
  scopes: z.array(z.enum(DEVICE_SCOPES)).min(1),
  gateId: objectId().nullable().optional(), // gate the device stands at
});
const updateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  location: z.string().trim().max(80).optional(),
  active: z.boolean().optional(),
  gateId: objectId().nullable().optional(), // null unlinks
});

// Admin-only management of hardware integration keys.
const router = Router();
router.use(authenticate, requireSociety, authorize());

router.get('/', asyncHandler(async (req, res) => ok(res, await service.list(ctx(req)))));
router.post('/', validate({ body: createSchema }), asyncHandler(async (req, res) => created(res, await service.create(ctx(req), req.body))));
router.patch('/:id', validate({ params: idParams, body: updateSchema }), asyncHandler(async (req, res) => ok(res, await service.update(ctx(req), req.params.id, req.body))));
router.delete('/:id', validate({ params: idParams }), asyncHandler(async (req, res) => {
  await service.revoke(ctx(req), req.params.id);
  noContent(res);
}));

export default router;
