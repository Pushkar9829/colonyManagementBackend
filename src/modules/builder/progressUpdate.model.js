import mongoose from 'mongoose';

const { ObjectId } = mongoose.Schema.Types;
const attachmentSchema = new mongoose.Schema({ url: String, mimetype: String, name: String }, { _id: false });

const progressUpdateSchema = new mongoose.Schema(
  {
    society: { type: ObjectId, ref: 'Society', required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, trim: true },
    tower: { type: String, trim: true },
    milestone: { type: String, trim: true },
    percentComplete: { type: Number, min: 0, max: 100 },
    photos: { type: [attachmentSchema], default: [] },
    postedBy: { type: ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);
progressUpdateSchema.index({ society: 1, createdAt: -1 });
export default mongoose.model('ProgressUpdate', progressUpdateSchema);
