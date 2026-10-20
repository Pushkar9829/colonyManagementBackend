import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery, phone } from '../../common/utils/schemas.js';
import { BLOOD_GROUPS, PET_TYPES, RELATIONS } from './household.model.js';
import { anniversaryAfterBirth, personalFields } from '../people/occupation.js';

export { idParams };

const text = (max) => z.string().trim().max(max);
// Optional text that may be cleared with "" (stored as undefined).
const clearable = (max) => text(max).optional().or(z.literal('').transform(() => undefined));
const pastDate = dateOnly().refine((v) => v <= new Date().toISOString().slice(0, 10), 'Date cannot be in the future');

const medical = {
  bloodGroup: z.enum(BLOOD_GROUPS).optional().nullable(),
  allergies: clearable(300),
  conditions: clearable(300),
  elderly: z.boolean().optional(),
  specialNeeds: z.boolean().optional(),
};

// Update schemas are built from the field sets without defaults, so a partial PATCH never resets a field.
const memberFields = {
  name: text(80).min(2),
  relation: z.enum(RELATIONS),
  dob: pastDate.optional().nullable(),
  age: z.coerce.number().int().min(0).max(120).optional().nullable(),
  phone: phone().optional().or(z.literal('').transform(() => undefined)),
  photo: objectId().optional().nullable(), // upload id ('household' folder)
  ...medical,
  anniversaryDate: personalFields.anniversaryDate,
  gender: personalFields.gender,
  occupation: personalFields.occupation,
  showBirthday: z.boolean().optional(),
};
const anniversaryCheck = [(v) => anniversaryAfterBirth({ dateOfBirth: v.dob, anniversaryDate: v.anniversaryDate }), { message: 'Anniversary must be after the date of birth', path: ['anniversaryDate'] }];
export const memberBody = z.object({ ...memberFields, relation: memberFields.relation.default('other') }).refine(...anniversaryCheck);
export const memberUpdate = z.object(memberFields).partial().refine(...anniversaryCheck);

const petFields = {
  name: text(60).min(1),
  type: z.enum(PET_TYPES),
  breed: clearable(60),
  vaccinationDate: pastDate.optional().nullable(),
  vaccinationCertificate: objectId().optional().nullable(), // upload id ('documents' folder)
  registrationNumber: clearable(40),
  photo: objectId().optional().nullable(),
};
export const petBody = z.object({ ...petFields, type: petFields.type.default('dog') });
export const petUpdate = z.object(petFields).partial();

const contact = z.object({
  name: text(80).min(2),
  relation: clearable(40),
  phone: phone(),
  altPhone: phone().optional().or(z.literal('').transform(() => undefined)),
});

export const updateProfile = z.object({
  emergencyContacts: z.array(contact).max(5).optional(),
  medicalNotes: clearable(1000),
});

export const myMedical = z.object(medical);

export const itemParams = z.object({ itemId: objectId() });
export const unitParams = z.object({ unitId: objectId() });
export const sosParams = z.object({ sosId: objectId() });

export const listHouseholds = pageQuery.extend({
  search: z.string().trim().max(40).optional(),
  medicalOnly: z.stringbool().optional(),
});
