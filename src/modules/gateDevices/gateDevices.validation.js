import { z } from 'zod';
import { idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { COMMAND_STATUS } from './barrierCommand.model.js';

export { idParams };

export const event = z
  .object({
    type: z.enum(['anpr', 'rfid']),
    plate: z.string().trim().min(3).max(15).optional(),
    tag: z.string().trim().min(4).max(40).optional(),
    direction: z.enum(['in', 'out']),
    gate: z.string().trim().min(1).max(40).default('Main gate'),
    imageUrl: z.url().max(500).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    occurredAt: z.coerce.date().optional(),
    eventId: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => (v.type === 'anpr' ? v.plate : v.tag), { message: 'plate is required for anpr, tag for rfid', path: ['plate'] });

export const requestOpen = z.object({
  gate: z.string().trim().min(1).max(40).default('Main gate'),
  reason: z.string().trim().max(200).optional(),
  visitorId: objectId().optional(),
  movementId: objectId().optional(),
});

export const poll = z.object({ gate: z.string().trim().max(40).optional() });
export const ack = z.object({ status: z.enum(['done', 'failed']).default('done'), message: z.string().trim().max(200).optional() });
export const listCommands = pageQuery.extend({ status: z.enum(COMMAND_STATUS).optional(), gate: z.string().trim().max(40).optional() });
