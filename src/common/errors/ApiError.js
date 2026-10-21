// A message with dynamic parts can be given as an English template plus params, so the app can
// translate it:  new ApiError(403, 'GATE_NOT_ALLOWED', '{name} is only valid at {gates}', { params: { name, gates } })
// `message` is still the filled-in English text; responses also carry `template` and `params`.
// The options object may carry the usual `details` too: { params, details }.
const fill = (text, params) => text.replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined || params[k] === null ? m : String(params[k])));
const isOptions = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, 'params');

export default class ApiError extends Error {
  constructor(status, code, message, details) {
    const params = isOptions(details) ? details.params : undefined;
    super(params ? fill(message, params) : message);
    this.status = status;
    this.code = code;
    this.details = isOptions(details) ? details.details : details;
    if (params) {
      this.template = message;
      this.params = params;
    }
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Authentication required', options) {
    return new ApiError(401, 'UNAUTHORIZED', message, options);
  }

  static forbidden(message = 'You do not have permission to do this', options) {
    return new ApiError(403, 'FORBIDDEN', message, options);
  }

  static notFound(message = 'Resource not found', options) {
    return new ApiError(404, 'NOT_FOUND', message, options);
  }

  static conflict(message = 'Conflict', options) {
    return new ApiError(409, 'CONFLICT', message, options);
  }

  static validation(details) {
    return new ApiError(422, 'VALIDATION_ERROR', 'Validation failed', details);
  }
}
