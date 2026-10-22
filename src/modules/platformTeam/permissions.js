// What a platform team member may do in the owner console. Single source of truth: routes check these keys,
// GET /platform/permissions sends the same list (with plain-English text) to the console.
export const PERMISSION_GROUPS = [
  {
    key: 'societies',
    label: 'Societies',
    permissions: [
      { key: 'societies.view', label: 'View societies', description: 'See every society, its plan, units, admins, subscription and the platform overview numbers.' },
      { key: 'societies.edit', label: 'Edit societies', description: 'Change a society’s plan, validity date, unit limit and internal notes.' },
      { key: 'societies.suspend', label: 'Suspend and reactivate', description: 'Switch a society off (its members can no longer use the app) and back on.' },
      { key: 'societies.features', label: 'Switch modules', description: 'Turn individual modules on or off for one society, overriding its plan.' },
      { key: 'whatsapp.manage', label: 'Manage WhatsApp', description: 'Set a society’s WhatsApp mode (off, click-to-chat or automatic API), add message credits and see WhatsApp usage.' },
    ],
  },
  {
    key: 'billing',
    label: 'Plans & billing',
    permissions: [
      { key: 'plans.view', label: 'View plans', description: 'See plan prices and which modules each plan includes.' },
      { key: 'plans.manage', label: 'Manage plans', description: 'Change plan prices, flat fees and yearly discounts for new invoices.' },
      { key: 'invoices.view', label: 'View invoices', description: 'See subscription invoices, payments and download invoice PDFs.' },
      { key: 'invoices.manage', label: 'Manage invoices', description: 'Mark invoices paid, void them and change a society’s billing cycle, due days and grace period.' },
      { key: 'payments.manage', label: 'Manage colony payments', description: 'Decide which online payment modes a society may use (own gateway, Razorpay Route), set its linked account and commission, and switch its online payments off.' },
      { key: 'billing.run', label: 'Run billing', description: 'Start the billing job now: raise due invoices, send reminders and suspend non-payers.' },
    ],
  },
  {
    key: 'support',
    label: 'Support',
    permissions: [
      { key: 'support.view', label: 'View tickets', description: 'Read support tickets raised by societies.' },
      { key: 'support.reply', label: 'Reply to tickets', description: 'Answer tickets and change their status. Members with this can be assigned tickets.' },
      { key: 'support.assign', label: 'Assign tickets', description: 'Hand a ticket to another support member.' },
      { key: 'support.access', label: 'Open support sessions', description: 'Sign in to a society as a temporary admin for one hour. The society’s admins are told.' },
    ],
  },
  {
    key: 'privacy',
    label: 'Privacy & community',
    permissions: [
      { key: 'privacy.handle', label: 'Handle deletion requests', description: 'Approve or decline account deletion requests from people who are not in any society.' },
      { key: 'luckydraw.oversee', label: 'Oversee lucky draws', description: 'See lucky draws across all societies and cancel one if needed.' },
    ],
  },
  {
    key: 'whitelabel',
    label: 'White label',
    permissions: [
      { key: 'whitelabel.manage', label: 'Manage resellers', description: 'Create white-label partners, their branding and admin logins, generate and revoke licence keys and record key-pack invoices.' },
    ],
  },
  {
    key: 'appearance',
    label: 'App templates',
    permissions: [
      { key: 'templates.manage', label: 'Manage app templates', description: 'Switch app templates on or off, set the default and which plans get which templates, and set or force a colony’s template and whether its admin may change it.' },
    ],
  },
  {
    key: 'ads',
    label: 'Ads',
    permissions: [
      { key: 'ads.manage', label: 'Manage ads', description: 'Create banner and pop-up ads for all or selected societies, see their numbers, and allow or block society-run ads.' },
    ],
  },
  {
    key: 'platform',
    label: 'Team & system',
    permissions: [
      { key: 'team.manage', label: 'Manage team and roles', description: 'Invite platform members, change their roles, switch them off, and create or edit roles.' },
      { key: 'impersonation.manage', label: 'Control "Log in as"', description: 'Decide who may log in as people below them (platform, society admins, sub-admins), per society too, and see every such session.' },
      { key: 'audit.view', label: 'View activity log', description: 'See every action taken in the platform console and by whom.' },
      { key: 'jobs.view', label: 'View system health', description: 'See background job runs and failures.' },
    ],
  },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
export const isPermission = (key) => ALL_PERMISSIONS.includes(key);

// Built-in roles, created on first use. They are read-only; "Duplicate as custom role" covers variations.
// Owner is not stored as a role assignment: owners are the users with platformRole 'super_admin'.
export const SYSTEM_ROLES = [
  { key: 'owner', name: 'Owner', description: 'Everything, including the team. At least one active owner must always remain.', permissions: ALL_PERMISSIONS },
  { key: 'admin', name: 'Admin', description: 'Everything except managing the team and roles.', permissions: ALL_PERMISSIONS.filter((p) => p !== 'team.manage') },
  {
    key: 'billing',
    name: 'Billing',
    description: 'Prices, subscription invoices and the billing run.',
    permissions: ['societies.view', 'plans.view', 'plans.manage', 'invoices.view', 'invoices.manage', 'billing.run', 'whatsapp.manage', 'payments.manage'],
  },
  {
    key: 'support',
    name: 'Support',
    description: 'Answers tickets, opens support sessions and handles privacy requests.',
    permissions: ['societies.view', 'plans.view', 'support.view', 'support.reply', 'support.assign', 'support.access', 'privacy.handle', 'luckydraw.oversee'],
  },
  {
    key: 'onboarding',
    name: 'Onboarding / Sales',
    description: 'Sets up new societies: plan, validity, unit limits and modules.',
    permissions: ['societies.view', 'societies.edit', 'societies.features', 'plans.view', 'invoices.view', 'support.view'],
  },
  { key: 'viewer', name: 'Viewer', description: 'Read-only access to every console page.', permissions: ALL_PERMISSIONS.filter((p) => p.endsWith('.view')) },
];
