import { z } from 'zod';
import { dateOnly, hhmm, idParams, objectId, pageQuery, paise, phone } from '../../common/utils/schemas.js';
import { NOC_TYPES, REQUEST_KINDS, REQUEST_STATUS } from './serviceRequest.model.js';

export { idParams };

const text = (max) => z.string().trim().max(max).optional();

export const createRequest = z
  .object({
    kind: z.enum(REQUEST_KINDS),
    nocType: z.enum(NOC_TYPES).optional(),
    addressedTo: text(200),
    purpose: text(300),
    description: text(2000),
    info: z
      .object({
        buyerName: text(120),
        bankName: text(120),
        loanAmount: paise().optional(),
        provider: text(120),
        workDescription: text(1000),
        contractorName: text(120),
        contractorPhone: phone().optional(),
        workFrom: dateOnly().optional(),
        workTo: dateOnly().optional(),
      })
      .optional(),
    move: z
      .object({
        date: dateOnly(),
        from: hhmm(),
        to: hhmm(),
        liftBooking: z.boolean().default(false),
        vehicleNumber: text(20),
        vehicleType: text(40),
        driverName: text(80),
        driverPhone: phone().optional(),
        moversCompany: text(120),
        tenancy: z.enum(['owner', 'tenant']).optional(),
      })
      .optional(),
    attachments: z.array(objectId()).max(5).optional(),
  })
  .refine((v) => v.kind !== 'noc' || v.nocType, { message: 'Choose the type of NOC', path: ['nocType'] })
  .refine((v) => v.kind === 'noc' || v.move, { message: 'Give the moving date and time slot', path: ['move'] })
  .refine((v) => v.nocType !== 'renovation' || v.info?.workDescription || v.description, { message: 'Describe the renovation work', path: ['info', 'workDescription'] })
  .refine((v) => !(v.info?.workFrom && v.info?.workTo) || v.info.workTo >= v.info.workFrom, { message: 'Work end date is before the start', path: ['info', 'workTo'] });

export const listRequests = pageQuery.extend({
  kind: z.enum(REQUEST_KINDS).optional(),
  nocType: z.enum(NOC_TYPES).optional(),
  status: z.enum(REQUEST_STATUS).optional(),
  open: z.stringbool().optional(),
  mine: z.stringbool().optional(),
});

export const comment = z.object({ text: z.string().trim().min(1).max(1000), internal: z.boolean().optional(), attachments: z.array(objectId()).max(5).optional() });
export const respond = z.object({ text: z.string().trim().min(1).max(1000), attachments: z.array(objectId()).max(5).optional() });
export const requestInfo = z.object({ note: z.string().trim().min(3).max(1000) });
export const approve = z.object({
  note: text(500),
  fees: text(200),
  acknowledgeDues: z.boolean().optional(),
  subject: text(200),
  letterBody: z.string().trim().min(20).max(6000).optional(),
});
export const reject = z.object({ reason: z.string().trim().min(3).max(500) });
export const movesQuery = z.object({ date: dateOnly().optional() });
