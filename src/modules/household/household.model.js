import mongoose from 'mongoose';
import { GENDERS, occupationSchema } from '../people/occupation.js';

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
export const RELATIONS = ['spouse', 'child', 'parent', 'grandparent', 'sibling', 'relative', 'other'];
export const PET_TYPES = ['dog', 'cat', 'bird', 'fish', 'rabbit', 'other'];

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

// Medical details shared by family members (no login) and app residents.
const medicalFields = {
  bloodGroup: { type: String, enum: BLOOD_GROUPS },
  allergies: { type: String, trim: true },
  conditions: { type: String, trim: true }, // e.g. diabetic, heart patient
  elderly: { type: Boolean, default: false },
  specialNeeds: { type: Boolean, default: false },
};

// People living in the flat who do not have their own app login.
const familyMemberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    relation: { type: String, enum: RELATIONS, default: 'other' },
    dob: String, // YYYY-MM-DD
    age: { type: Number, min: 0, max: 120 }, // used when the exact DOB is unknown
    phone: { type: String, trim: true },
    photo: attachmentSchema,
    ...medicalFields,
    // Personal details (modules/people/occupation.js). dob above is the date of birth.
    anniversaryDate: String, // YYYY-MM-DD
    gender: { type: String, enum: GENDERS },
    occupation: { type: occupationSchema, default: undefined },
    showBirthday: { type: Boolean, default: false }, // opt-in for the society's "Today's birthdays" card
  },
  { timestamps: true },
);

const petSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: PET_TYPES, default: 'dog' },
    breed: { type: String, trim: true },
    vaccinationDate: String, // last anti-rabies / core vaccination, YYYY-MM-DD
    vaccinationCertificate: attachmentSchema,
    registrationNumber: { type: String, trim: true }, // municipal pet licence
    photo: attachmentSchema,
  },
  { timestamps: true },
);

const emergencyContactSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  relation: { type: String, trim: true },
  phone: { type: String, required: true, trim: true },
  altPhone: { type: String, trim: true },
});

// Medical record of an app resident (each resident edits only their own).
const residentMedicalSchema = new mongoose.Schema(
  { user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, ...medicalFields },
  { _id: false, timestamps: { createdAt: false, updatedAt: true } },
);

// One profile per unit. Login-bearing residents stay in the users module; this holds the rest.
const householdSchema = new mongoose.Schema(
  {
    society: { type: mongoose.Schema.Types.ObjectId, ref: 'Society', required: true },
    unit: { type: mongoose.Schema.Types.ObjectId, ref: 'Unit', required: true },
    members: { type: [familyMemberSchema], default: [] },
    pets: { type: [petSchema], default: [] },
    emergencyContacts: { type: [emergencyContactSchema], default: [] },
    residentMedical: { type: [residentMedicalSchema], default: [] },
    medicalNotes: { type: String, trim: true }, // e.g. "oxygen cylinder in bedroom"
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
householdSchema.index({ society: 1, unit: 1 }, { unique: true });

export default mongoose.model('Household', householdSchema);
