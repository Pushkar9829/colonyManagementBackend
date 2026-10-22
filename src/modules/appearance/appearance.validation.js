import { z } from 'zod';
import { idParams, objectId } from '../../common/utils/schemas.js';
import { RULE_PLANS, TEMPLATE_KEYS } from './templates.catalogue.js';

export { idParams };

const templateKey = () => z.enum(TEMPLATE_KEYS);

export const publicQuery = z.object({
  society: z.string().trim().max(20).optional(),
  slug: z.string().trim().toLowerCase().max(40).optional(),
  host: z.string().trim().max(200).optional(),
});

export const keyParams = z.object({ key: templateKey() });
export const planParams = z.object({ plan: z.enum(RULE_PLANS) });

export const apply = z.object({ template: templateKey() });
export const media = z
  .object({ logo: objectId().nullable().optional(), cover: objectId().nullable().optional() })
  .refine((v) => v.logo !== undefined || v.cover !== undefined, 'Send a logo or a cover photo');

export const setEnabled = z.object({ enabled: z.boolean() });
export const setDefault = z.object({ template: templateKey() });
export const setPlanRule = z.object({ templates: z.array(templateKey()).min(1, 'Pick at least one template').max(TEMPLATE_KEYS.length) });

export const updateSociety = z
  .object({
    allowedTemplates: z.array(templateKey()).max(TEMPLATE_KEYS.length).optional(),
    adminMayChange: z.boolean().optional(),
    forceTemplate: templateKey().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const updateReseller = z
  .object({
    allowedTemplates: z.array(templateKey()).max(TEMPLATE_KEYS.length).optional(),
    brandOverridesTemplate: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');
