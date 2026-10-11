// Demo data for the facility area: assets + AMC, PPM, checklists, fire safety, stores, utility logs and staff HR.
import * as assets from '../../src/modules/assets/assets.service.js';
import * as fire from '../../src/modules/assets/fireSafety.service.js';
import * as ppm from '../../src/modules/maintenance/maintenance.service.js';
import * as housekeeping from '../../src/modules/maintenance/housekeeping.service.js';
import * as inventory from '../../src/modules/inventory/inventory.service.js';
import * as utility from '../../src/modules/utilityLogs/utilityLogs.service.js';
import * as employees from '../../src/modules/staffhr/employees.service.js';
import { addDaysStr, today } from '../../src/modules/assets/facility.shared.js';

export default async function seed(s) {
  const { ctx } = s;
  const t = today();
  const electrician = await s.user('electrician@demo.test');

  // ---- assets ----
  const dg = await assets.create(ctx, { category: 'dg_set', name: 'DG Set 125 kVA', location: 'Basement, Tower A', make: 'Kirloskar', model: 'KG1-125', serialNumber: 'KOEL-88213', purchaseDate: '2021-04-12', purchaseCost: 145000000, warrantyExpiry: addDaysStr(t, 25) });
  const lift = await assets.create(ctx, { category: 'lift', name: 'Lift A1', location: 'Tower A', make: 'Otis', model: 'Gen2', capacity: '8 passenger', purchaseDate: '2019-08-01', purchaseCost: 280000000 });
  const pump = await assets.create(ctx, { category: 'pump', name: 'Domestic water pump 1', location: 'Pump room', make: 'Kirloskar', capacity: '5 HP' });
  const stp = await assets.create(ctx, { category: 'stp', name: 'STP 150 KLD', location: 'Rear compound' });
  await assets.create(ctx, { category: 'cctv', name: 'NVR main gate', location: 'Security cabin', make: 'Hikvision' });
  await assets.setAmc(ctx, lift._id, { renew: false, vendorName: 'Otis Elevator Co.', contractNumber: 'OTIS-AMC-2291', startDate: addDaysStr(t, -340), endDate: addDaysStr(t, 25), cost: 18000000, coverage: 'comprehensive', visitsPerYear: 12 });
  await assets.addAmcVisit(ctx, lift._id, { date: addDaysStr(t, -20), type: 'preventive', technician: 'Prakash (Otis)', findings: 'Door rollers greased, brake checked' });

  // ---- PPM ----
  await ppm.createSchedule(ctx, {
    asset: String(dg._id),
    title: 'DG daily inspection',
    frequency: 'daily',
    startDate: t,
    leadDays: 3,
    graceDays: 1,
    assigneeRole: 'staff',
    checklist: [
      { label: 'Engine oil level OK', type: 'yes_no', required: true },
      { label: 'Coolant level OK', type: 'yes_no', required: true },
      { label: 'Battery voltage', type: 'reading', unit: 'V', min: 12, max: 14, required: true },
      { label: 'Diesel level', type: 'reading', unit: '%', min: 30, max: 100, required: true },
      { label: 'Remarks', type: 'text', required: false },
    ],
  });
  await ppm.createSchedule(ctx, { asset: String(pump._id), title: 'Pump monthly service', frequency: 'monthly', startDate: addDaysStr(t, 2), leadDays: 7, assigneeRole: 'staff', assignee: String(electrician._id), checklist: [{ label: 'Gland leakage', type: 'yes_no' }, { label: 'Motor current', type: 'reading', unit: 'A', min: 5, max: 9 }] });
  await ppm.createBreakdown(ctx, { asset: String(stp._id), title: 'Blower 2 tripping', description: 'Trips every few hours', priority: 'high', markUnderRepair: true });

  // ---- housekeeping & fire safety ----
  await housekeeping.createChecklist(ctx, { name: 'Lobby cleaning', area: 'lobby', location: 'Tower A lobby', items: [{ label: 'Floor mopped' }, { label: 'Glass doors wiped' }, { label: 'Dustbins emptied' }], slots: [{ label: 'Morning', dueBy: '10:00' }, { label: 'Evening', dueBy: '18:00' }], days: [0, 1, 2, 3, 4, 5, 6], assigneeRole: 'staff', requirePhoto: true, graceMinutes: 120 });
  await housekeeping.createChecklist(ctx, { name: 'Garbage room sanitising', area: 'garbage_room', items: [{ label: 'Bins washed' }, { label: 'Disinfectant sprayed' }], slots: [{ label: 'Night', dueBy: '22:00' }], days: [1, 3, 5], assigneeRole: 'staff', requirePhoto: true, graceMinutes: 120 });
  await fire.createExtinguisher(ctx, { location: 'Tower A lobby', type: 'abc_powder', capacityKg: 6, lastRefillDate: addDaysStr(t, -350), nextRefillDue: addDaysStr(t, 15), expiryDate: '2029-03-31' });
  await fire.createExtinguisher(ctx, { location: 'DG room', type: 'co2', capacityKg: 4.5, lastRefillDate: addDaysStr(t, -100), nextRefillDue: addDaysStr(t, 265) });
  await fire.createNoc(ctx, { number: 'PMC/FIRE/2025/4471', issuedBy: 'PMC Fire Brigade', issueDate: addDaysStr(t, -340), expiryDate: addDaysStr(t, 25) });
  await fire.createDrill(ctx, { date: addDaysStr(t, -60), time: '11:00', scenario: 'Kitchen fire, Tower B', conductedBy: 'Facility manager', attendance: 64, evacuationMinutes: 7 });

  // ---- stores ----
  await inventory.createItem(ctx, { name: 'LED bulb 9W', category: 'electrical', unit: 'pcs', reorderLevel: 10, reorderQty: 50, location: 'Store shelf A', openingStock: 24, openingCost: 9500 });
  await inventory.createItem(ctx, { name: 'Floor cleaner (5 L can)', category: 'cleaning', unit: 'can', reorderLevel: 4, reorderQty: 10, openingStock: 3, openingCost: 65000 });
  await inventory.createItem(ctx, { name: 'Sodium hypochlorite', category: 'chemical', unit: 'l', reorderLevel: 20, openingStock: 60, openingCost: 4000 });

  // ---- utility logs ----
  const dgPoint = await utility.createPoint(ctx, { kind: 'dg', name: 'DG 125 kVA', asset: String(dg._id), capacity: 250, openingDieselStock: 180, openingHours: 1520 });
  await utility.createPoint(ctx, { kind: 'tank', name: 'Overhead tank Tower A', capacity: 50000 });
  await utility.createPoint(ctx, { kind: 'stp', name: 'STP 150 KLD', asset: String(stp._id) });
  await utility.createPoint(ctx, { kind: 'meter', name: 'Common area meter', openingMeterReading: 48210 });
  await utility.createReading(ctx, { point: String(dgPoint._id), shift: 'morning', hoursEnd: 1522.5, dieselConsumed: 38 });

  // ---- staff HR ----
  await employees.updateSettings(ctx, { geofence: { enabled: false, lat: 18.559, lng: 73.7868, radiusM: 250 } });
  const day = await employees.createShift(ctx, { name: 'Day', start: '08:00', end: '20:00', color: 'amber' });
  await employees.createShift(ctx, { name: 'Night', start: '20:00', end: '08:00', color: 'indigo' });
  await employees.createShift(ctx, { name: 'General', start: '09:30', end: '18:30', color: 'sky' });
  const staff = [
    ['guard@demo.test', 'GRD-01', 'security', 1600000, 0],
    ['plumber@demo.test', 'TEC-01', 'maintenance', 1800000, 0],
    ['electrician@demo.test', 'TEC-02', 'maintenance', 2000000, 0],
    ['manager@demo.test', 'MGR-01', 'administration', 4500000, 0],
  ];
  for (const [email, code, department, basic] of staff) {
    // eslint-disable-next-line no-await-in-loop
    const m = await s.membership(email);
    if (!m) continue;
    // eslint-disable-next-line no-await-in-loop
    await employees.create(ctx, {
      membership: String(m._id),
      employeeCode: code,
      department,
      employmentType: 'permanent',
      dateOfJoining: '2024-04-01',
      defaultShift: String(day._id),
      weeklyOff: 0,
      salary: { basic, hra: Math.round(basic * 0.2), allowances: [{ name: 'Conveyance', amount: 160000 }], pfPercent: 12, esiPercent: 0.75, professionalTax: 20000 },
      policeVerification: { status: department === 'security' ? 'verified' : 'submitted' },
    });
  }
}
