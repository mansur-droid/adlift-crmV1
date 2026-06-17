import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const formSecret = process.env.GOOGLE_FORM_WEBHOOK_SECRET;

const reply = (res, status, body) => res.status(status).json(body);
const clean = value => String(value || '').trim();
const pick = (body, keys) => {
  for (const key of keys) {
    if (body[key] !== undefined && clean(body[key])) return clean(body[key]);
  }
  return '';
};

function normalizeSubmission(body) {
  return {
    fullName: pick(body, ['fullName', 'Full Name', 'Name', 'Naam', 'name']),
    email: pick(body, ['email', 'Email', 'E-mail', 'Email Address']),
    phone: pick(body, ['phone', 'Phone', 'Phone Number', 'Telefoon', 'GSM']),
    buyerStatus: pick(body, ['buyerStatus', 'Buyer Clients?', 'Buyer Status']),
    leadSource: pick(body, ['leadSource', 'Current Lead Source', 'Lead Source']),
    openToAppointments: pick(body, ['openToAppointments', 'Open to Appointments?', 'Open To Appointments']),
    preferredType: pick(body, ['preferredType', 'Preferred Client Type', 'Preferred Type']),
    notes: pick(body, ['notes', 'Notes', 'Extra Info', 'Opmerkingen']),
    submittedAt: new Date().toISOString(),
    source: 'google_form',
    raw: body,
    deleted: false
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') return reply(res, 405, { error: 'Method not allowed.' });
  if (!supabaseUrl || !serviceRoleKey) return reply(res, 500, { error: 'Missing Supabase server env vars.' });
  if (formSecret && req.headers['x-adlift-form-secret'] !== formSecret) return reply(res, 401, { error: 'Invalid form secret.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const payload = normalizeSubmission(body);
    const fingerprint = `${payload.email}|${payload.phone}|${payload.submittedAt}`;
    const id = crypto.randomUUID();

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    const { error } = await supabase.from('crm_records').upsert({
      id,
      type: 'submissions',
      payload: { ...payload, id, fingerprint, created_by: 'google_form_webhook', created_by_email: 'google-form@adlift.crm' },
      created_by: 'google_form_webhook',
      updated_at: payload.submittedAt
    });

    if (error) return reply(res, 400, { error: error.message });
    return reply(res, 200, { ok: true, id });
  } catch (error) {
    return reply(res, 500, { error: error.message || 'Form submit failed.' });
  }
}
