// Demo data for households, KYC, tenancy, daily-help reviews/salary, amenity passes and helpdesk settings.
import Household from '../../src/modules/household/household.model.js';
import KycDocument from '../../src/modules/kyc/kycDocument.model.js';
import Lease from '../../src/modules/tenancy/lease.model.js';
import DailyHelp from '../../src/modules/dailyHelp/dailyHelp.model.js';
import HelpReview from '../../src/modules/dailyHelp/helpReview.model.js';
import HelpEmployment from '../../src/modules/dailyHelp/helpEmployment.model.js';
import Amenity from '../../src/modules/amenities/amenity.model.js';
import AmenityPass, { AmenityPassPlan } from '../../src/modules/amenities/amenityPass.model.js';
import ComplaintCategory from '../../src/modules/complaints/complaintCategory.model.js';
import EscalationRule from '../../src/modules/complaints/escalationRule.model.js';
import { localDateString } from '../../src/common/utils/dates.js';

const day = (offset) => localDateString(Date.now() + offset * 86400000);

export default async function seed(s) {
  const { sid } = s;
  const [a101, a102] = await Promise.all([s.unit('A-101'), s.unit('A-102')]);
  const ravi = await s.user('resident@demo.test');
  const raviM = await s.membership('resident@demo.test');
  const neha = await s.user('neha@demo.test');
  const nehaM = await s.membership('neha@demo.test');
  const manager = await s.user('manager@demo.test');
  const admin = await s.user('admin@demo.test');

  // Household profile of A-101
  await Household.create({
    society: sid,
    unit: a101._id,
    members: [
      { name: 'Kamala Iyer', relation: 'parent', dob: '1948-06-12', bloodGroup: 'B+', conditions: 'Diabetic, uses a walker', elderly: true, specialNeeds: true },
      { name: 'Aarav Iyer', relation: 'child', dob: '2016-02-03', bloodGroup: 'O+', allergies: 'Peanuts' },
    ],
    pets: [{ name: 'Bruno', type: 'dog', breed: 'Labrador', vaccinationDate: day(-120), registrationNumber: 'PMC-DOG-2231' }],
    emergencyContacts: [
      { name: 'Suresh Iyer', relation: 'Brother', phone: '9822000011' },
      { name: 'Dr. Mehta (family doctor)', relation: 'Doctor', phone: '9822000012' },
    ],
    residentMedical: [{ user: ravi._id, bloodGroup: 'O+', allergies: 'Penicillin' }],
    medicalNotes: 'Insulin in the fridge. Spare key with A-102.',
    updatedBy: ravi._id,
  });

  // KYC: numbers keep only the last 4 digits; demo records carry no files
  if (raviM) {
    await KycDocument.insertMany([
      { society: sid, unit: a101._id, membership: raviM._id, user: ravi._id, type: 'aadhaar', category: 'id_proof', last4: '4821', nameOnDocument: 'Ravi Iyer', status: 'pending' },
      { society: sid, unit: a101._id, membership: raviM._id, user: ravi._id, type: 'photo', category: 'photo', status: 'verified', reviewedBy: admin._id, reviewedAt: new Date() },
    ]);
  }

  // A-102 is rented to Neha by a landlord who does not live in the colony
  if (nehaM) {
    await Lease.create({
      society: sid,
      unit: a102._id,
      tenantMembership: nehaM._id,
      tenantUser: neha._id,
      ownerName: 'Mr. Kapoor',
      ownerPhone: '9811100099',
      startDate: day(-340),
      endDate: day(25),
      rent: 2800000,
      securityDeposit: 8400000,
      policeVerification: { status: 'submitted', reference: 'PS-KTR-5521' },
      emergencyContact: { name: 'Rajiv Gupta', relation: 'Father', phone: '9811100088' },
      createdBy: admin._id,
    });
  }

  // Daily help: ratings and A-101's salary arrangement for Sunita
  const sunita = await DailyHelp.findOne({ society: sid, phone: '9100000001' });
  if (sunita) {
    await HelpReview.insertMany([
      { society: sid, help: sunita._id, unit: a101._id, user: ravi._id, rating: 5, text: 'Punctual and careful with the kids' },
      ...(neha ? [{ society: sid, help: sunita._id, unit: a102._id, user: neha._id, rating: 4 }] : []),
    ]);
    sunita.avgRating = neha ? 4.5 : 5;
    sunita.ratingCount = neha ? 2 : 1;
    sunita.policeVerification = { status: 'verified', verifiedAt: new Date(), verifiedBy: manager?._id };
    await sunita.save();
    await HelpEmployment.create({ society: sid, help: sunita._id, unit: a101._id, salary: 450000, dueDay: 5, updatedBy: ravi._id });
  }

  // Amenities: paid clubhouse with a refundable deposit, gym membership passes
  await Amenity.updateOne({ society: sid, name: 'Clubhouse' }, { $set: { deposit: 500000, paymentMode: 'online', 'cancellation.fullRefundHours': 48, 'cancellation.partialRefundHours': 12 } });
  const gym = await Amenity.findOne({ society: sid, name: 'Gym' }).lean();
  if (gym) {
    const [monthly] = await AmenityPassPlan.insertMany([
      { society: sid, amenity: gym._id, name: 'Monthly', durationDays: 30, price: 50000, description: 'Unlimited gym access for 30 days' },
      { society: sid, amenity: gym._id, name: 'Quarterly', durationDays: 90, price: 135000 },
    ]);
    await AmenityPass.create({
      society: sid,
      amenity: gym._id,
      plan: monthly._id,
      unit: a101._id,
      holder: ravi._id,
      purchasedBy: ravi._id,
      code: 'GYMRAVI1',
      validFrom: day(-5),
      validTo: day(24),
      price: 50000,
      status: 'active',
      paymentStatus: 'paid',
    });
  }

  // Helpdesk: a custom category and a stricter escalation ladder for lifts
  await ComplaintCategory.insertMany([
    { society: sid, key: 'pest_control', name: 'Pest Control', keywords: ['termite', 'termites', 'rodent', 'rat', 'bedbugs'] },
    { society: sid, key: 'plumbing', name: 'Plumbing', isDefault: true, keywords: ['seepage'], requiresResolutionPhotos: true },
  ]);
  await EscalationRule.create({
    society: sid,
    category: 'lift',
    priority: null,
    levels: [
      { level: 1, afterHours: 0, roles: ['facility_manager'], notifyAssignee: true },
      { level: 2, afterHours: 2, roles: ['admin'] },
      { level: 3, afterHours: 6, roles: ['admin'], users: [admin._id] },
    ],
    createdBy: admin._id,
  });
}
