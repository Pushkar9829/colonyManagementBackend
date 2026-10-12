import { z } from 'zod';
import { objectId, phone } from '../../common/utils/schemas.js';
import { password } from '../users/users.validation.js';

export const registerSociety = z.object({
  society: z.object({
    name: z.string().trim().min(2).max(120),
    address: z.string().trim().max(300).optional(),
    city: z.string().trim().max(80).optional(),
    state: z.string().trim().max(80).optional(),
    pincode: z.string().trim().max(10).optional(),
  }),
  admin: z.object({
    name: z.string().trim().min(2).max(80),
    email: z.email().toLowerCase(),
    phone: phone().optional(),
    password: password(),
    designation: z.string().trim().max(60).optional(),
  }),
});

export const login = z.object({
  identifier: z.string().trim().min(3).max(120), // email or phone
  password: z.string().min(1).max(72),
});

export const refresh = z.object({ refreshToken: z.string().min(20) });

export const join = z
  .object({
    societyCode: z.string().trim().length(6),
    name: z.string().trim().min(2).max(80),
    email: z.email().toLowerCase().optional(),
    phone: phone().optional(),
    password: password(),
    unit: objectId(),
    residentType: z.enum(['owner', 'tenant', 'family']),
  })
  .refine((v) => v.email || v.phone, { message: 'Email or phone is required', path: ['email'] });

export const societyCodeParams = z.object({ code: z.string().trim().length(6) });

export const updateMe = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: phone().optional(),
  notificationPrefs: z.object({ sms: z.boolean().optional(), whatsapp: z.boolean().optional(), email: z.boolean().optional() }).optional(),
});

export const switchMembership = z.object({ membershipId: objectId().nullable() });

export const addHome = z.object({
  societyCode: z.string().trim().length(6),
  unit: objectId(),
  residentType: z.enum(['owner', 'tenant', 'family']),
});

export const changePassword = z.object({
  currentPassword: z.string().min(1),
  newPassword: password(),
  refreshToken: z.string().min(20).optional(),
});

export const otpRequest = z.object({ phone: phone() });
export const otpVerify = z.object({ phone: phone(), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });

export const forgotPassword = z.object({ email: z.email().toLowerCase() });
export const resetToken = z.object({ token: z.string().min(20).max(200) });
export const resetPassword = z.object({ token: z.string().min(20).max(200), password: password() });
export const currentSession = z.object({ refreshToken: z.string().min(20).optional() });
export const sessionParams = z.object({ family: z.string().uuid() });
export const supportSession = z.object({ societyId: objectId(), reason: z.string().trim().max(200).optional() });

// ---- two-step verification ----
const totpCode = () => z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from your app');
const backupCode = () => z.string().trim().min(8).max(20);
export const mfaCode = z.object({ code: totpCode() });
export const mfaDisable = z.object({ password: z.string().min(1).max(72), code: z.string().trim().min(6).max(20) });
export const mfaVerify = z
  .object({ mfaToken: z.string().min(20).max(2000), code: totpCode().optional(), backupCode: backupCode().optional() })
  .refine((v) => Boolean(v.code) !== Boolean(v.backupCode), { message: 'Enter the code from your app or a backup code', path: ['code'] });
