// Creates (or promotes) the platform owner account that can open the super admin console.
// Usage: npm run create-super-admin -- <email> <password> "<name>"
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import User from '../src/modules/users/user.model.js';

const [email, password, name = 'Platform Owner'] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('Usage: npm run create-super-admin -- <email> <password (8+ chars)> "<name>"');
  process.exit(1);
}

await connectDB();
const existing = await User.findOne({ email: email.toLowerCase() });
if (existing) {
  existing.platformRole = 'super_admin'; // Owner of the platform team
  existing.platformRoleId = undefined;
  existing.platformStatus = 'active';
  await existing.save();
  console.log(`Promoted ${email} to super admin (password unchanged).`);
} else {
  await User.create({ name, email: email.toLowerCase(), passwordHash: await User.hashPassword(password), platformRole: 'super_admin' });
  console.log(`Created super admin ${email}.`);
}
await mongoose.disconnect();
