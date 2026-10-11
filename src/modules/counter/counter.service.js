import Counter from './counter.model.js';

export async function nextSeq(societyId, key, session) {
  const doc = await Counter.findOneAndUpdate(
    { society: societyId, key },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true, session },
  );
  return doc.seq;
}

export async function nextNumber(societyId, key, prefix, pad = 6) {
  const seq = await nextSeq(societyId, key);
  return `${prefix}-${String(seq).padStart(pad, '0')}`;
}
