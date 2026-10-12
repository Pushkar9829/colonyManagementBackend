import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, requireSociety } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import ApiError from '../../common/errors/ApiError.js';
import { idParams } from '../../common/utils/schemas.js';
import { FOLDERS, MAX_BYTES } from './uploads.service.js';
import * as controller from './uploads.controller.js';

const parser = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } }).single('file');

// Wraps multer so its errors (e.g. file too large) come back in the standard error format.
const receive = (req, res, next) =>
  parser(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('File is larger than 5 MB'));
    return next(ApiError.badRequest(err.message));
  });

const router = Router();
router.use(authenticate, requireSociety);

router.post('/', receive, validate({ body: z.object({ folder: z.enum(FOLDERS) }) }), controller.upload);
router.delete('/:id', validate({ params: idParams }), controller.remove);

export default router;
