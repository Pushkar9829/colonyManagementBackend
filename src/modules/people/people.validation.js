import { z } from 'zod';
import { objectId } from '../../common/utils/schemas.js';
import { anniversaryAfterBirth, personalFields } from './occupation.js';

const anniversaryCheck = [anniversaryAfterBirth, { message: 'Anniversary must be after the date of birth', path: ['anniversaryDate'] }];

export const personalBody = z.object(personalFields).refine(...anniversaryCheck);
export const familyPersonalBody = z.object({ ...personalFields, showBirthday: z.boolean().optional() }).refine(...anniversaryCheck);

export const unitParams = z.object({ unitId: objectId() });
export const userParams = z.object({ userId: objectId() });
export const familyParams = z.object({ unitId: objectId(), memberId: objectId() });
