import ApiError from '../errors/ApiError.js';
import { findActiveByKey } from '../../modules/devices/devices.service.js';

// Authenticates hardware calls with the `X-Device-Key` header and checks the key has the scope.
// Sets req.device and a minimal req.user so ctx(req) works in services:
//   ctx = { societyId, userId: null, role: 'device', unitId: null }
export const authenticateDevice = (scope) => async (req, _res, next) => {
  try {
    const device = await findActiveByKey(req.headers['x-device-key']);
    if (!device) throw new ApiError(401, 'DEVICE_UNAUTHORIZED', 'Invalid or revoked device key');
    if (scope && !device.scopes.includes(scope)) throw new ApiError(403, 'DEVICE_SCOPE', `This device key lacks the "${scope}" permission`);
    req.device = device;
    req.user = { _id: null, society: device.society, role: 'device', unit: null, membershipId: null, name: device.name };
    next();
  } catch (err) {
    next(err);
  }
};
