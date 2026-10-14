import { Gate } from '../../src/modules/gates/gate.model.js';
import { ensureDefaultGate } from '../../src/modules/gates/gates.service.js';
import Visitor from '../../src/modules/visitors/visitor.model.js';
import GuestPass from '../../src/modules/visitors/guestPass.model.js';
import VehicleMovement from '../../src/modules/vehicles/vehicleMovement.model.js';
import BarrierCommand from '../../src/modules/gateDevices/barrierCommand.model.js';
import DailyHelp from '../../src/modules/dailyHelp/dailyHelp.model.js';
import Parcel from '../../src/modules/parcels/parcel.model.js';
import { Handover } from '../../src/modules/guardDuty/guardDuty.model.js';
import { ChildAlert } from '../../src/modules/emergency/emergency.model.js';
import { numericCode } from '../../src/common/utils/codes.js';

const H = 3600000;

// Four gates for the demo society, and the gate traffic seeded by other modules spread over them so
// "By gate" analytics and the gate filters have something to show. Runs after the security seed.
export default async function seed(s) {
  const { sid } = s;
  const main = await ensureDefaultGate(sid);
  const [club, service, pedestrian] = await Gate.create([
    { society: sid, name: 'Gate 2 — Club side', code: 'G2', allowVisitors: true, allowVehicles: true, allowStaff: false, allowDeliveries: false, order: 1, notes: 'Next to the clubhouse; closes at 11 PM' },
    { society: sid, name: 'Service gate', code: 'SVC', allowVisitors: false, allowVehicles: false, allowStaff: true, allowDeliveries: true, order: 2, notes: 'Behind B wing — staff and deliveries' },
    { society: sid, name: 'Pedestrian gate', code: 'PED', allowVisitors: true, allowVehicles: false, allowStaff: false, allowDeliveries: false, isPedestrianOnly: true, order: 3 },
  ]);
  const ref = (g) => ({ _id: g._id, name: g.name });

  // Visitors: deliveries mostly via the service gate, guests split between the other three.
  const visitors = await Visitor.find({ society: sid, entryGate: null }).sort({ createdAt: 1 }).select('purpose status vehicleNumber').lean();
  const n = { delivery: 0, vehicle: 0, guest: 0 };
  const ops = visitors.map((v) => {
    let g;
    if (v.purpose === 'delivery') g = n.delivery++ % 4 === 0 ? main : service;
    else if (v.vehicleNumber || v.purpose === 'cab') g = n.vehicle++ % 2 ? club : main;
    else g = [main, club, pedestrian][n.guest++ % 3];
    const set = { entryGate: g._id, entryGateName: g.name };
    if (v.status === 'checked_out') Object.assign(set, { exitGate: g._id, exitGateName: g.name });
    return { updateOne: { filter: { _id: v._id }, update: { $set: set } } };
  });
  if (ops.length) await Visitor.bulkWrite(ops);

  // Gate-name records from before gates: link them to the gate of the same name.
  for (const Model of [VehicleMovement, BarrierCommand, Handover, ChildAlert]) {
    // eslint-disable-next-line no-await-in-loop
    await Model.updateMany({ society: sid, gate: main.name, gateId: null }, { gateId: main._id });
  }
  const movement = await VehicleMovement.findOne({ society: sid }).lean();
  await VehicleMovement.create({
    society: sid,
    plate: 'MH14EV2024',
    direction: 'in',
    gate: club.name,
    gateId: club._id,
    source: 'manual',
    match: 'resident',
    decision: 'allow',
    reason: 'Registered to B-101',
    vehicle: movement?.vehicle,
    occurredAt: new Date(Date.now() - 5 * H),
  });

  await Parcel.updateMany({ society: sid, gate: null }, { gate: service._id, gateName: service.name });

  const [ravi, a101] = await Promise.all([s.user('resident@demo.test'), s.unit('A-101')]);
  // A guest pass that only works at the main gate.
  await GuestPass.create({
    society: sid,
    unit: a101._id,
    createdBy: ravi._id,
    guestName: 'Ankit (cousin)',
    phone: '9822004400',
    purpose: 'guest',
    code: numericCode(6),
    validFrom: new Date(Date.now() - H),
    validTo: new Date(Date.now() + 3 * 24 * H),
    maxUses: 3,
    gates: [main._id],
  });
  // A helper who may only come in by the service gate.
  await DailyHelp.create({ society: sid, name: 'Raju (car cleaner)', phone: '9100000044', type: 'cleaner', units: [a101._id], passcode: '730241', allowedGates: [service._id], createdBy: ravi._id });

  return { gates: [ref(main), ref(club), ref(service), ref(pedestrian)] };
}
