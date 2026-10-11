// Request context passed from controllers to services. Tenant id always comes from the verified token.
export const ctx = (req) => ({
  userId: req.user._id,
  societyId: req.user.society,
  role: req.user.role,
  unitId: req.user.unit || null,
  user: req.user,
  ip: req.ip,
});

// Validated query (set by validate middleware) with a fallback to the raw query.
export const query = (req) => req.validatedQuery || req.query;
