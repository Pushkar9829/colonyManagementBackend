export const ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  ADMIN: 'admin',
  ACCOUNTANT: 'accountant',
  FACILITY_MANAGER: 'facility_manager',
  GUARD: 'guard',
  RESIDENT: 'resident',
  STAFF: 'staff',
});

export const ALL_ROLES = Object.values(ROLES);
export const STAFF_ROLES = [ROLES.ACCOUNTANT, ROLES.FACILITY_MANAGER, ROLES.GUARD, ROLES.STAFF];
export const MANAGEMENT = [ROLES.ADMIN, ROLES.FACILITY_MANAGER];
export const FINANCE = [ROLES.ADMIN, ROLES.ACCOUNTANT];

export const RESIDENT_TYPES = ['owner', 'tenant', 'family'];
export const USER_STATUS = ['pending', 'active', 'rejected', 'inactive'];
export const UNIT_TYPES = ['flat', 'villa', 'plot', 'shop', 'other'];
export const OCCUPANCY = ['vacant', 'owner_occupied', 'rented'];

export const VISITOR_STATUS = ['pending', 'denied', 'checked_in', 'checked_out'];
export const VISITOR_PURPOSE = ['guest', 'delivery', 'cab', 'service', 'other'];
export const HELP_TYPES = ['maid', 'cook', 'driver', 'nanny', 'gardener', 'cleaner', 'other'];
export const SOS_TYPES = ['medical', 'fire', 'security', 'lift', 'other'];
export const SOS_STATUS = ['active', 'acknowledged', 'resolved'];

export const BILL_STATUS = ['unpaid', 'partial', 'paid', 'cancelled'];
export const PAYMENT_METHODS = ['cash', 'cheque', 'upi', 'bank', 'online'];

export const COMPLAINT_CATEGORIES = ['plumbing', 'electrical', 'lift', 'cleaning', 'security', 'parking', 'noise', 'water', 'other'];
export const COMPLAINT_PRIORITY = ['low', 'medium', 'high', 'urgent'];
export const COMPLAINT_STATUS = ['open', 'assigned', 'in_progress', 'on_hold', 'resolved', 'closed', 'reopened'];

// SaaS plans. unitLimit null = unlimited.
export const PLANS = Object.freeze({
  trial: { label: 'Trial (30 days, everything on)', unitLimit: 500 },
  free: { label: 'Free', unitLimit: 50 },
  basic: { label: 'Basic', unitLimit: 200 },
  standard: { label: 'Standard', unitLimit: 1000 },
  premium: { label: 'Premium', unitLimit: null },
});

export const BOOKING_STATUS = ['pending', 'confirmed', 'rejected', 'cancelled'];
