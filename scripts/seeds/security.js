// Demo data for the security area: vehicles, blocklist, passes, parcels, patrols, parking, emergency, duty log.
import Vehicle from '../../src/modules/vehicles/vehicle.model.js';
import VehicleMovement from '../../src/modules/vehicles/vehicleMovement.model.js';
import Visitor from '../../src/modules/visitors/visitor.model.js';
import GuestPass from '../../src/modules/visitors/guestPass.model.js';
import WatchlistEntry from '../../src/modules/visitors/watchlist.model.js';
import FrequentVisitor from '../../src/modules/visitors/frequentVisitor.model.js';
import Parcel from '../../src/modules/parcels/parcel.model.js';
import DeliveryPreference from '../../src/modules/parcels/deliveryPreference.model.js';
import { Checkpoint, PatrolRoute } from '../../src/modules/patrols/patrol.model.js';
import { EvCharger, ParkingArea, ParkingSlot } from '../../src/modules/parking/parking.model.js';
import { Child, EmergencyContact } from '../../src/modules/emergency/emergency.model.js';
import { Handover, Incident, OccurrenceEntry } from '../../src/modules/guardDuty/guardDuty.model.js';
import { nextNumber } from '../../src/modules/counter/counter.service.js';
import { numericCode, randomCode } from '../../src/common/utils/codes.js';
import { localDateString } from '../../src/common/utils/dates.js';

const H = 3600000;
const ago = (ms) => new Date(Date.now() - ms);

export default async function seed(s) {
  const { sid } = s;
  const [a101, a102, b101] = await Promise.all([s.unit('A-101'), s.unit('A-102'), s.unit('B-101')]);
  const [ravi, neha, guard, manager] = await Promise.all([s.user('resident@demo.test'), s.user('neha@demo.test'), s.user('guard@demo.test'), s.user('manager@demo.test')]);

  // vehicles (one with an RFID tag so the ANPR/RFID demo has something to match)
  const [car] = await Vehicle.insertMany([
    { society: sid, unit: a101._id, owner: ravi._id, number: 'MH12AB1234', type: 'four_wheeler', make: 'Honda City', color: 'White', fuel: 'petrol', rfidTag: 'TAG-0001' },
    { society: sid, unit: a102._id, owner: neha._id, number: 'MH12XY4321', type: 'two_wheeler', make: 'Activa', color: 'Grey' },
    { society: sid, unit: b101._id, number: 'MH14EV2024', type: 'four_wheeler', make: 'Nexon EV', color: 'Blue', fuel: 'electric' },
  ]);

  await WatchlistEntry.insertMany([
    { society: sid, type: 'block', name: 'Door-to-door seller', phone: '9898989898', phoneKey: '9898989898', nameKey: 'door-to-door seller', reason: 'Repeated complaints of harassment', createdBy: manager._id },
    { society: sid, type: 'watch', vehicleNumber: 'MH01ZZ9999', reason: 'Seen circling the colony late at night', createdBy: manager._id },
  ]);

  // regular visitors and passes
  const tutor = await FrequentVisitor.create({ society: sid, unit: a101._id, name: 'Meera (maths tutor)', phone: '9822001100', phoneKey: '9822001100', purpose: 'service', autoApprove: true, visits: 12, lastVisitAt: ago(2 * 24 * H), createdBy: ravi._id });
  await GuestPass.create({
    society: sid,
    unit: a101._id,
    createdBy: ravi._id,
    guestName: tutor.name,
    phone: tutor.phone,
    purpose: 'service',
    code: numericCode(6),
    kind: 'recurring',
    recurrence: { days: [1, 3], startTime: '17:00', endTime: '19:00' },
    validFrom: ago(7 * 24 * H),
    validTo: new Date(Date.now() + 90 * 24 * H),
    frequentVisitor: tutor._id,
  });
  await DeliveryPreference.create({ society: sid, unit: a101._id, company: 'Swiggy', companyKey: 'swiggy', note: 'Leave food at the gate', createdBy: ravi._id });

  // a week of gate traffic for the analytics page
  const names = ['Amazon', 'Swiggy', 'Zomato', 'Uber', 'Flipkart', 'BigBasket'];
  const units = [a101, a102, b101];
  const visitors = [];
  for (let i = 0; i < 40; i += 1) {
    const at = ago((i * 4.3 + 1) * H);
    const delivery = i % 3 !== 0;
    const status = i % 11 === 0 ? 'denied' : 'checked_out';
    visitors.push({
      society: sid,
      unit: units[i % 3]._id,
      name: delivery ? `${names[i % names.length]} partner` : ['Rahul Verma', 'Sneha Kapoor', 'Uncle Raj'][i % 3],
      phone: delivery ? undefined : ['9811100001', '9811100002', '9811100003'][i % 3],
      purpose: delivery ? (i % 5 === 0 ? 'cab' : 'delivery') : 'guest',
      company: delivery ? names[i % names.length] : undefined,
      status,
      loggedBy: guard._id,
      respondedBy: ravi._id,
      respondedAt: new Date(at.getTime() + (30 + (i % 7) * 20) * 1000),
      occurredAt: at,
      checkInAt: status === 'denied' ? undefined : at,
      checkOutAt: status === 'denied' ? undefined : new Date(at.getTime() + 20 * 60000),
      createdAt: at,
    });
  }
  await Visitor.insertMany(visitors);

  // parcels
  await Parcel.insertMany([
    { society: sid, number: await nextNumber(sid, 'parcel', 'PCL'), unit: a101._id, courier: 'Amazon', trackingNo: 'AMZ-4471', storageLocation: 'Shelf A', otp: numericCode(4), status: 'notified', receivedBy: guard._id, receivedAt: ago(30 * H), notifiedAt: ago(30 * H) },
    { society: sid, number: await nextNumber(sid, 'parcel', 'PCL'), unit: a101._id, courier: 'Myntra', storageLocation: 'Shelf A', otp: numericCode(4), status: 'notified', receivedBy: guard._id, receivedAt: ago(2 * H), notifiedAt: ago(2 * H) },
    { society: sid, number: await nextNumber(sid, 'parcel', 'PCL'), unit: a102._id, courier: 'Flipkart', otp: numericCode(4), status: 'collected', receivedBy: guard._id, receivedAt: ago(26 * H), collectedAt: ago(20 * H), collectedBy: { type: 'resident' }, handedOverBy: guard._id },
  ]);

  // patrols
  const cps = await Checkpoint.insertMany(
    ['Main gate', 'Pump room', 'Basement B1', 'Terrace — A wing', 'Back gate'].map((name) => ({ society: sid, name, location: name, code: randomCode(10) })),
  );
  await PatrolRoute.insertMany([
    { society: sid, name: 'Night perimeter', checkpoints: [cps[0]._id, cps[4]._id, cps[2]._id], frequencyMinutes: 120, startTime: '22:00', endTime: '06:00', days: [], createdBy: manager._id },
    { society: sid, name: 'Daytime utilities', checkpoints: [cps[1]._id, cps[3]._id], frequencyMinutes: 240, startTime: '08:00', endTime: '20:00', days: [1, 2, 3, 4, 5, 6], createdBy: manager._id },
  ]);

  // parking
  const area = await ParkingArea.create({ society: sid, name: 'Basement 1', level: 'B1' });
  const slots = await ParkingSlot.insertMany([
    ...Array.from({ length: 10 }, (_, i) => ({ society: sid, area: area._id, number: `P${i + 1}`, type: i === 9 ? 'ev' : 'four_wheeler', covered: true })),
    ...Array.from({ length: 4 }, (_, i) => ({ society: sid, area: area._id, number: `T${i + 1}`, type: 'two_wheeler', covered: true })),
    ...Array.from({ length: 3 }, (_, i) => ({ society: sid, area: area._id, number: `V${i + 1}`, pool: 'visitor' })),
  ]);
  await ParkingSlot.updateOne({ _id: slots[0]._id }, { unit: a101._id, vehicles: [car._id], allottedAt: new Date() });
  await Vehicle.updateOne({ _id: car._id }, { parkingSlot: 'P1' });
  await EvCharger.create({ society: sid, name: 'EV charger 1', location: 'Basement 1, near P10', connector: 'Type 2', powerKw: 7.4, ratePerKwh: 1500, slotMinutes: 60, openTime: '06:00', closeTime: '23:00' });

  // emergency directory and child safety
  await EmergencyContact.insertMany(
    [
      { name: 'Ambulance', category: 'ambulance', phone: '108', available24x7: true },
      { name: 'Police', category: 'police', phone: '112', available24x7: true },
      { name: 'Fire brigade', category: 'fire', phone: '101', available24x7: true },
      { name: 'Sahyadri Hospital', category: 'hospital', phone: '02067215000', address: 'Karve Road, Pune', available24x7: true },
      { name: 'Dr. Kulkarni (society doctor)', category: 'doctor', phone: '9822012345', notes: 'Clinic in B-wing, 9 AM–1 PM' },
      { name: 'Apollo Pharmacy', category: 'pharmacy', phone: '9822054321', notes: 'Home delivery till 11 PM' },
      { name: 'Ganesh Electricals', category: 'electrician', phone: '9822067890' },
    ].map((c, order) => ({ ...c, society: sid, order })),
  );
  await Child.create({ society: sid, unit: a101._id, name: 'Aarav Iyer', age: 7, notes: 'Allowed to go to the play area alone', alertOnExit: true, createdBy: ravi._id });

  // duty log
  const today = localDateString();
  const ho = await Handover.create({
    society: sid,
    shift: 'night',
    fromGuard: guard._id,
    notes: 'Quiet night. Water tanker expected at 7 AM.',
    keys: [{ name: 'Clubhouse', status: 'with_guard' }, { name: 'Terrace', status: 'issued', holder: 'Plumber (Suresh)' }],
    pendingItems: [{ text: 'Back gate light not working — complaint raised' }],
  });
  const inc = await Incident.create({
    society: sid,
    number: await nextNumber(sid, 'incident', 'INC'),
    type: 'suspicious',
    severity: 'medium',
    title: 'Unknown person near back gate',
    description: 'Left when asked to identify himself.',
    location: 'Back gate',
    occurredAt: ago(5 * H),
    reportedBy: guard._id,
  });
  await OccurrenceEntry.insertMany([
    { society: sid, date: today, at: ago(5 * H), category: 'incident', text: `${inc.number} suspicious: ${inc.title}`, by: guard._id, refModel: 'Incident', ref: inc._id },
    { society: sid, date: today, at: ago(2 * H), category: 'handover', text: 'night shift handed over: Quiet night', by: guard._id, refModel: 'Handover', ref: ho._id },
  ]);
  await VehicleMovement.insertMany([
    { society: sid, plate: 'MH12AB1234', direction: 'out', gate: 'Main gate', source: 'rfid', tag: 'TAG-0001', match: 'resident', decision: 'allow', reason: 'Registered to A-101', vehicle: car._id, unit: a101._id, occurredAt: ago(3 * H) },
    { society: sid, plate: 'DL3CAB0007', direction: 'in', gate: 'Main gate', source: 'manual', match: 'unknown', decision: 'deny', reason: 'Unregistered vehicle — guard to verify', loggedBy: guard._id, occurredAt: ago(1 * H) },
  ]);
}
