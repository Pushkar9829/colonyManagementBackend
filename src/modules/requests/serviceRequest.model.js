import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;

export const REQUEST_KINDS = ['noc', 'move_in', 'move_out'];
export const NOC_TYPES = ['sale', 'passport', 'bank_loan', 'electricity', 'gas', 'renovation', 'other'];
export const REQUEST_STATUS = ['pending', 'info_requested', 'approved', 'rejected', 'cancelled'];

const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const commentSchema = new mongoose.Schema(
  {
    by: { type: ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true },
    internal: { type: Boolean, default: false }, // committee-only note
    attachments: { type: [attachmentSchema], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const historySchema = new mongoose.Schema(
  { by: { type: ObjectId, ref: 'User' }, from: String, to: String, note: String },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } },
);

const requestSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    number: { type: String, required: true },
    kind: { type: String, enum: REQUEST_KINDS, required: true },
    nocType: { type: String, enum: NOC_TYPES },
    unit: { type: ObjectId, ref: 'Unit', required: true },
    unitLabel: String,
    raisedBy: { type: ObjectId, ref: 'User', required: true },
    applicantName: String,
    residentType: String,
    // NOC details
    addressedTo: { type: String, trim: true }, // "The Passport Officer, Pune"
    purpose: { type: String, trim: true },
    description: { type: String, trim: true },
    info: {
      buyerName: String,
      bankName: String,
      loanAmount: Number, // paise
      provider: String, // electricity / gas company
      workDescription: String,
      contractorName: String,
      contractorPhone: String,
      workFrom: String,
      workTo: String,
    },
    // Move-in / move-out details
    move: {
      date: String, // YYYY-MM-DD
      from: String, // HH:MM
      to: String,
      liftBooking: { type: Boolean, default: false },
      vehicleNumber: String,
      vehicleType: String,
      driverName: String,
      driverPhone: String,
      moversCompany: String,
      tenancy: { type: String, enum: ['owner', 'tenant'] },
      guardsNotifiedOn: String, // date of the morning reminder to guards
    },
    attachments: { type: [attachmentSchema], default: [] }, // rent agreement, sale deed, ID...
    status: { type: String, enum: REQUEST_STATUS, default: 'pending' },
    fees: { type: String, trim: true }, // e.g. "Transfer fee ₹25,000 payable"
    comments: { type: [commentSchema], default: [] },
    history: { type: [historySchema], default: [] },
    decidedBy: { type: ObjectId, ref: 'User' },
    decidedAt: Date,
    decisionNote: String,
    duesAtApproval: Number, // paise outstanding when approved
    letter: {
      number: String,
      issuedAt: Date,
      subject: String,
      body: String,
      signatory: { name: String, position: String },
    },
  },
  { timestamps: true },
);
requestSchema.index({ society: 1, number: 1 }, { unique: true });
requestSchema.index({ society: 1, status: 1, createdAt: -1 });
requestSchema.index({ society: 1, raisedBy: 1, createdAt: -1 });
requestSchema.index({ society: 1, kind: 1, 'move.date': 1, status: 1 });

export default mongoose.model('ServiceRequest', requestSchema);
