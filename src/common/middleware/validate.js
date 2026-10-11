import ApiError from '../errors/ApiError.js';

// validate({ body, query, params }) — each a zod schema. Parsed values replace the raw ones.
export const validate = (schemas) => (req, _res, next) => {
  const details = [];
  for (const key of ['params', 'query', 'body']) {
    if (!schemas[key]) continue;
    const result = schemas[key].safeParse(req[key] ?? {});
    if (!result.success) {
      for (const issue of result.error.issues) details.push({ field: [key, ...issue.path].join('.'), message: issue.message });
    } else if (key === 'query') {
      // req.query is a getter in Express 5 and read-only-ish in 4; store parsed copy separately.
      req.validatedQuery = result.data;
    } else {
      req[key] = result.data;
    }
  }
  if (details.length) return next(ApiError.validation(details));
  return next();
};
