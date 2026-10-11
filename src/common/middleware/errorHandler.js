import mongoose from 'mongoose';
import ApiError from '../errors/ApiError.js';
import env from '../../config/env.js';
import { reportError } from '../utils/errorReporter.js';

export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let error = err;

  if (err instanceof mongoose.Error.ValidationError) {
    error = ApiError.validation(Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })));
  } else if (err instanceof mongoose.Error.CastError) {
    error = ApiError.badRequest(`Invalid ${err.path}`);
  } else if (err?.code === 11000) {
    const fields = Object.keys(err.keyValue || {}).filter((f) => f !== 'society');
    error = ApiError.conflict(`${fields.join(', ') || 'Record'} already exists`);
  } else if (err?.type === 'entity.parse.failed') {
    error = ApiError.badRequest('Malformed JSON body');
  } else if (!(err instanceof ApiError)) {
    reportError(err, { source: 'api', method: req.method, path: req.originalUrl, user: req.user?._id ? String(req.user._id) : undefined });
    error = new ApiError(500, 'INTERNAL_ERROR', env.isProd ? 'Something went wrong' : err.message);
  }

  res.status(error.status).json({
    success: false,
    error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
  });
}
