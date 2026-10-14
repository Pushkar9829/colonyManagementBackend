import mongoose from 'mongoose';
import PlatformAudit from './platformAudit.model.js';
import logger from '../../common/utils/logger.js';

const SECRET_KEY = /password|token|secret|otp|code$/i;
const MAX_DETAILS = 4000;
const asId = (v) => {
  const id = v?._id ?? v;
  return id && mongoose.isValidObjectId(id) ? id : undefined;
};

// Request bodies become the row's details: secrets dropped, size capped.
export function cleanDetails(value) {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value, (k, v) => (k && SECRET_KEY.test(k) ? undefined : v));
  if (!json || json === '{}') return undefined;
  return json.length > MAX_DETAILS ? { truncated: json.slice(0, MAX_DETAILS) } : JSON.parse(json);
}

// Fire-and-forget like the society audit log: a logging failure must never break the action itself.
// ctx: { userId, ip } (from ctx(req)).
export function recordPlatform(ctx, action, { targetType, targetId, society, details } = {}) {
  return PlatformAudit.create({
    actor: asId(ctx?.userId),
    action,
    targetType,
    targetId: asId(targetId),
    society: asId(society),
    details: cleanDetails(details),
    ip: ctx?.ip,
  }).catch((err) => logger.error({ err, action }, 'platform audit write failed'));
}

// Route middleware: records the action once the response has gone out successfully.
// action and every option may be a function of (req, data), where data is the JSON response's `data`.
//   audited('invoice.voided', { targetType: 'PlatformInvoice', society: (req, data) => data?.society })
// targetId defaults to req.params.id.
export const audited = (action, { targetType, targetId, society, details } = {}) => (req, res, next) => {
  const json = res.json.bind(res);
  let body;
  res.json = (payload) => {
    body = payload;
    return json(payload);
  };
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.user) return;
    const data = body?.data;
    const pick = (opt, fallback) => (typeof opt === 'function' ? opt(req, data) : opt ?? fallback);
    recordPlatform({ userId: req.user._id, ip: req.ip }, pick(action), {
      targetType: pick(targetType),
      targetId: pick(targetId, req.params?.id),
      society: pick(society, targetType === 'Society' ? req.params?.id : undefined),
      details: pick(details, req.body && Object.keys(req.body).length ? req.body : undefined),
    });
  });
  next();
};
