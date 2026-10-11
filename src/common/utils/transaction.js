import mongoose from 'mongoose';

let supported;

// Transactions need a replica set (Atlas always is). A standalone local mongod is not,
// so there we run the work without a session instead of failing.
async function transactionsSupported() {
  if (supported === undefined) {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  }
  return supported;
}

export async function withTransaction(work) {
  if (!(await transactionsSupported())) return work(undefined);
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
