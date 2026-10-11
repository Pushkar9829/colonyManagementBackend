import { z } from 'zod';
import { dateOnly, idParams, objectId, pageQuery } from '../../common/utils/schemas.js';
import { ACTION_STATUS, ATTENDANCE_MODES, AUDIENCE_TYPES, MAJORITY, MEETING_STATUS, MEETING_TYPES } from './meeting.model.js';

export { idParams };

const sub = (name) => z.object({ id: objectId(), [name]: objectId() });
export const itemParams = sub('itemId');
export const resolutionParams = sub('resolutionId');
export const actionParams = sub('actionId');
export const attachmentParams = sub('attachmentId');
export const memberParams = sub('membershipId');

const agendaItem = z.object({
  _id: objectId().optional(),
  title: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  presenter: z.string().trim().max(100).optional(),
});

const audience = z
  .object({ type: z.enum(AUDIENCE_TYPES), memberships: z.array(objectId()).max(2000).optional() })
  .refine((a) => a.type !== 'custom' || a.memberships?.length, { message: 'Pick at least one member', path: ['memberships'] });

const quorum = z
  .object({ type: z.enum(['count', 'percent']), value: z.coerce.number().int().min(1).max(10000) })
  .refine((q) => q.type !== 'percent' || q.value <= 100, { message: 'Percentage must be 1-100', path: ['value'] });

const meetingFields = {
  title: z.string().trim().min(3).max(200),
  type: z.enum(MEETING_TYPES),
  scheduledAt: z.coerce.date(),
  durationMinutes: z.coerce.number().int().min(0).max(1440).optional(),
  mode: z.enum(['in_person', 'online', 'hybrid']).optional(),
  venue: z.string().trim().max(200).optional(),
  onlineLink: z.url().max(500).optional(),
  description: z.string().trim().max(3000).optional(),
  audience: audience.optional(),
  quorum: quorum.optional(),
};

export const createMeeting = z.object({ ...meetingFields, agenda: z.array(agendaItem).max(50).optional() });

export const updateMeeting = z
  .object({ ...Object.fromEntries(Object.entries(meetingFields).map(([k, v]) => [k, v.optional()])), agenda: z.array(agendaItem).max(50).optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const listMeetings = pageQuery.extend({
  type: z.enum(MEETING_TYPES).optional(),
  status: z.enum(MEETING_STATUS).optional(),
  when: z.enum(['upcoming', 'past']).optional(),
});

export const addAgendaItem = agendaItem.omit({ _id: true });
export const updateAgendaItem = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    presenter: z.string().trim().max(100).optional(),
    minutes: z.string().max(20000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const minutes = z.object({ summary: z.string().max(20000) });
export const cancel = z.object({ reason: z.string().trim().min(3).max(300) });

export const attendance = z.object({
  entries: z
    .array(z.object({ membership: objectId(), mode: z.enum(ATTENDANCE_MODES), proxyHolder: z.string().trim().max(100).optional() }))
    .min(1)
    .max(2000),
});

const votes = z.coerce.number().int().min(0).max(100000);
export const resolution = z.object({
  agendaItem: objectId().optional(),
  title: z.string().trim().min(3).max(200),
  text: z.string().trim().min(5).max(5000),
  proposedBy: objectId().optional(),
  secondedBy: objectId().optional(),
  majority: z.enum(MAJORITY).default('simple'),
  votesFor: votes.default(0),
  votesAgainst: votes.default(0),
  abstain: votes.default(0),
});
export const updateResolution = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    text: z.string().trim().min(5).max(5000).optional(),
    proposedBy: objectId().optional(),
    secondedBy: objectId().optional(),
    majority: z.enum(MAJORITY).optional(),
    votesFor: votes.optional(),
    votesAgainst: votes.optional(),
    abstain: votes.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const actionItem = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(2000).optional(),
  agendaItem: objectId().optional(),
  owner: objectId().optional(),
  dueDate: dateOnly().optional(),
  status: z.enum(ACTION_STATUS).optional(),
});
export const updateActionItem = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(2000).optional(),
    owner: objectId().optional(),
    dueDate: dateOnly().optional(),
    status: z.enum(ACTION_STATUS).optional(),
    notes: z.string().trim().max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const listActionItems = z.object({
  status: z.enum(ACTION_STATUS).optional(),
  mine: z.stringbool().optional(),
  overdue: z.stringbool().optional(),
});

export const attachments = z.object({ uploads: z.array(objectId()).min(1).max(10) });
