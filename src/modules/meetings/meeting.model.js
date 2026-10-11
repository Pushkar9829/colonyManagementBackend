import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const MEETING_TYPES = ['agm', 'sgm', 'committee', 'other'];
export const MEETING_STATUS = ['draft', 'scheduled', 'completed', 'cancelled'];
export const AUDIENCE_TYPES = ['all_members', 'owners', 'committee', 'custom'];
export const ATTENDANCE_MODES = ['in_person', 'online', 'proxy'];
export const MAJORITY = ['simple', 'two_thirds', 'three_fourths'];
export const ACTION_STATUS = ['open', 'in_progress', 'done', 'cancelled'];

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String });

const agendaItemSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, trim: true },
  presenter: { type: String, trim: true },
  minutes: { type: String, default: '' }, // what was discussed / decided on this item
});

const attendanceSchema = new mongoose.Schema(
  {
    membership: { type: ObjectId, ref: 'Membership', required: true },
    user: { type: ObjectId, ref: 'User' },
    name: { type: String, required: true },
    unitLabel: String,
    mode: { type: String, enum: ATTENDANCE_MODES, required: true },
    proxyHolder: { type: String, trim: true }, // who attended on the member's behalf
    markedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: { createdAt: 'markedAt', updatedAt: false } },
);

const resolutionSchema = new mongoose.Schema(
  {
    number: { type: String, required: true }, // R-1, R-2 within the meeting
    agendaItem: ObjectId,
    title: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true }, // "Resolved that ..."
    proposedBy: { type: ObjectId, ref: 'Membership' },
    proposedByName: String,
    secondedBy: { type: ObjectId, ref: 'Membership' },
    secondedByName: String,
    majority: { type: String, enum: MAJORITY, default: 'simple' },
    votesFor: { type: Number, default: 0, min: 0 },
    votesAgainst: { type: Number, default: 0, min: 0 },
    abstain: { type: Number, default: 0, min: 0 },
    result: { type: String, enum: ['passed', 'failed'], required: true },
    recordedBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

const actionItemSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    agendaItem: ObjectId,
    owner: { type: ObjectId, ref: 'Membership' },
    ownerUser: { type: ObjectId, ref: 'User' },
    ownerName: String,
    dueDate: String, // YYYY-MM-DD
    status: { type: String, enum: ACTION_STATUS, default: 'open' },
    notes: { type: String, trim: true },
    completedAt: Date,
  },
  { timestamps: true },
);

const meetingSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    type: { type: String, enum: MEETING_TYPES, required: true },
    scheduledAt: { type: Date, required: true },
    durationMinutes: { type: Number, min: 0 },
    mode: { type: String, enum: ['in_person', 'online', 'hybrid'], default: 'in_person' },
    venue: { type: String, trim: true },
    onlineLink: { type: String, trim: true },
    description: { type: String, trim: true },
    audience: {
      type: { type: String, enum: AUDIENCE_TYPES, default: 'all_members' },
      memberships: [{ type: ObjectId, ref: 'Membership' }],
    },
    // Members needed: a fixed count, or a percentage of those invited.
    quorum: {
      type: { type: String, enum: ['count', 'percent'], default: 'percent' },
      value: { type: Number, default: 33, min: 0 },
    },
    agenda: { type: [agendaItemSchema], default: [] },
    status: { type: String, enum: MEETING_STATUS, default: 'draft' },
    notice: { sentAt: Date, count: { type: Number, default: 0 }, recipients: { type: Number, default: 0 } },
    attendance: { type: [attendanceSchema], default: [] },
    resolutions: { type: [resolutionSchema], default: [] },
    actionItems: { type: [actionItemSchema], default: [] },
    attachments: { type: [attachmentSchema], default: [] },
    minutes: {
      status: { type: String, enum: ['draft', 'approved'], default: 'draft' },
      summary: { type: String, default: '' }, // opening remarks / general notes
      approvedBy: { type: ObjectId, ref: 'User' },
      approvedAt: Date,
      signatories: [{ _id: false, name: String, position: String }],
    },
    cancelledReason: String,
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true },
);
meetingSchema.index({ society: 1, number: 1 }, { unique: true });
meetingSchema.index({ society: 1, scheduledAt: -1 });
meetingSchema.index({ society: 1, 'actionItems.ownerUser': 1 });

export default mongoose.model('Meeting', meetingSchema);
