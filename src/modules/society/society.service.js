import Society from './society.model.js';
import ApiError from '../../common/errors/ApiError.js';
import { randomCode } from '../../common/utils/codes.js';
import * as audit from '../audit/audit.service.js';

export async function generateUniqueCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = randomCode(6);
    // eslint-disable-next-line no-await-in-loop
    if (!(await Society.exists({ code }))) return code;
  }
  throw new Error('Could not generate a unique society code');
}

export async function getById(id) {
  const society = await Society.findById(id).lean();
  if (!society) throw ApiError.notFound('Society not found');
  return society;
}

export const findByCode = (code) => Society.findOne({ code: code.toUpperCase(), active: true }).lean();

export async function updateProfile(ctx, data) {
  const society = await Society.findByIdAndUpdate(ctx.societyId, { $set: data }, { returnDocument: 'after', runValidators: true }).lean();
  audit.record(ctx, 'society.profile_updated', 'Society', ctx.societyId, data);
  return society;
}

// Merges nested settings so partial updates don't wipe sibling keys.
export async function updateSettings(ctx, data) {
  const set = {};
  for (const [group, values] of Object.entries(data)) {
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const [k, v] of Object.entries(values)) set[`settings.${group}.${k}`] = v;
    } else {
      set[`settings.${group}`] = values;
    }
  }
  const society = await Society.findByIdAndUpdate(ctx.societyId, { $set: set }, { returnDocument: 'after', runValidators: true }).lean();
  audit.record(ctx, 'society.settings_updated', 'Society', ctx.societyId, data);
  return society;
}

export async function regenerateCode(ctx) {
  const code = await generateUniqueCode();
  const society = await Society.findByIdAndUpdate(ctx.societyId, { code }, { returnDocument: 'after' }).lean();
  audit.record(ctx, 'society.code_regenerated', 'Society', ctx.societyId);
  return society;
}
