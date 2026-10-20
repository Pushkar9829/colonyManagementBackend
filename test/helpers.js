// Test bootstrap: isolated local database, never the dev/prod one.
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/colony_management_test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'test-secret-test-secret-test-secret-123';
process.env.PAYMENT_PROVIDER = 'mock';

const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { connectDB } = await import('../src/config/db.js');
const { createApp } = await import('../src/app.js');

if (!/_test$/.test(new URL(process.env.MONGODB_URI.replace('mongodb://', 'http://')).pathname)) {
  throw new Error('Refusing to run tests against a database whose name does not end with _test');
}

export async function setup() {
  await connectDB(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  return request(createApp());
}

export async function teardown() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// New societies start with online payments off (modules/paymentSettings). Tests written before that put a
// society back on the platform account (the pre-existing behaviour) to keep exercising the payment flows.
export async function onlinePaymentsLegacy(societyId) {
  const { default: PaymentSettings } = await import('../src/modules/paymentSettings/paymentSettings.model.js');
  await PaymentSettings.updateOne({ society: societyId }, { mode: 'platform_legacy', enabled: true, status: 'active' }, { upsert: true });
}
