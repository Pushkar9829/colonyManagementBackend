// Fill-in-the-blanks notice drafts. Plain string templates, not generated text: the admin edits the
// result and posts it through Notices. {{field}} placeholders; {{society}} is filled automatically.
export const NOTICE_TEMPLATES = [
  {
    key: 'water_cut',
    label: 'Water supply interruption',
    category: 'maintenance',
    fields: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'from', label: 'From (time)', type: 'time', required: true },
      { key: 'to', label: 'To (time)', type: 'time', required: true },
      { key: 'reason', label: 'Reason', type: 'text', default: 'overhead tank cleaning' },
      { key: 'blocks', label: 'Affected blocks', type: 'text', default: 'all blocks' },
    ],
    title: 'Water supply interruption on {{date}}',
    body: 'Dear residents,\n\nWater supply to {{blocks}} will be stopped on {{date}} from {{from}} to {{to}} for {{reason}}. Please store enough water in advance.\n\nWe regret the inconvenience.\n\nManaging Committee, {{society}}',
  },
  {
    key: 'maintenance_due',
    label: 'Maintenance due reminder',
    category: 'billing',
    fields: [
      { key: 'month', label: 'Billing month', type: 'text', required: true },
      { key: 'dueDate', label: 'Due date', type: 'date', required: true },
      { key: 'lateFee', label: 'Late fee', type: 'text', default: 'as per society rules' },
    ],
    title: 'Maintenance for {{month}} is due by {{dueDate}}',
    body: 'Dear residents,\n\nThis is a reminder that maintenance charges for {{month}} are due by {{dueDate}}. You can pay online in the ColonyHub app under Billing. A late fee {{lateFee}} applies after the due date.\n\nPlease ignore this notice if you have already paid.\n\nTreasurer, {{society}}',
  },
  {
    key: 'agm',
    label: 'Annual general meeting',
    category: 'meeting',
    fields: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'time', label: 'Time', type: 'time', required: true },
      { key: 'venue', label: 'Venue', type: 'text', default: 'the clubhouse' },
      { key: 'agenda', label: 'Agenda (one item per line)', type: 'textarea', default: 'Adoption of audited accounts\nBudget for the coming year\nElection of the managing committee\nAny other matter with the chair’s permission' },
      { key: 'noticeDays', label: 'Notice period (days)', type: 'text', default: '14' },
    ],
    title: 'Notice of Annual General Meeting on {{date}}',
    body: 'Dear members,\n\nNotice is hereby given ({{noticeDays}} days in advance) that the Annual General Meeting of {{society}} will be held on {{date}} at {{time}} at {{venue}}.\n\nAgenda:\n{{agenda}}\n\nMembers are requested to attend in person. If the quorum is not present, the meeting will be adjourned by 30 minutes and held at the same place.\n\nSecretary, {{society}}',
  },
  {
    key: 'festival',
    label: 'Festival celebration',
    category: 'event',
    fields: [
      { key: 'festival', label: 'Festival', type: 'text', required: true },
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'time', label: 'Time', type: 'time', required: true },
      { key: 'venue', label: 'Venue', type: 'text', default: 'the clubhouse lawn' },
      { key: 'contribution', label: 'Contribution per flat', type: 'text', default: 'voluntary' },
      { key: 'contact', label: 'Contact person', type: 'text' },
    ],
    title: '{{festival}} celebration on {{date}}',
    body: 'Dear residents,\n\nJoin us to celebrate {{festival}} on {{date}} at {{time}} at {{venue}}. There will be cultural programmes, games for children and dinner for all.\n\nContribution: {{contribution}}. For volunteering or details, please contact {{contact}}.\n\nWarm wishes,\nCultural Committee, {{society}}',
  },
];

export const templateByKey = (key) => NOTICE_TEMPLATES.find((t) => t.key === key);

const prettyDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : v);
const prettyTime = (v) => {
  if (!/^\d{2}:\d{2}$/.test(v)) return v;
  const [h, m] = v.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// Missing required fields stay visible as [Label] so the draft is obviously incomplete.
export function render(template, values, societyName) {
  const missing = [];
  const filled = { society: societyName };
  for (const f of template.fields) {
    let v = values?.[f.key] ?? f.default;
    if (v === undefined || v === '') {
      if (f.required) missing.push(f.key);
      v = `[${f.label}]`;
    } else if (f.type === 'date') v = prettyDate(v);
    else if (f.type === 'time') v = prettyTime(v);
    filled[f.key] = String(v);
  }
  const fill = (s) => s.replace(/\{\{(\w+)\}\}/g, (_m, k) => filled[k] ?? '');
  return { key: template.key, category: template.category, title: fill(template.title), body: fill(template.body), missing };
}
