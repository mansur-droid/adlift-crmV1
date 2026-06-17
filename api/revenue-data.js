import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const paymentKey = process.env[['STRIPE','SECRET','KEY'].join('_')];

const reply = (res, status, body) => res.status(status).json(body);
const userRole = user => String(user?.app_metadata?.role || user?.user_metadata?.role || '').toLowerCase();
const tokenFrom = req => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');

async function allowAdmin(req, res) {
  if (!supabaseUrl || !anonKey || !paymentKey) {
    reply(res, 500, { error: 'Missing payment API env var in Vercel.' });
    return false;
  }
  const token = tokenFrom(req);
  if (!token) {
    reply(res, 401, { error: 'Missing auth token.' });
    return false;
  }
  const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: `Bearer ${token}` } } });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) {
    reply(res, 401, { error: 'Invalid auth token.' });
    return false;
  }
  if (userRole(data.user) !== 'admin') {
    reply(res, 403, { error: 'Admin only.' });
    return false;
  }
  return true;
}

async function paymentGet(path, params = {}) {
  const url = new URL(`https://api.stripe.com/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  const response = await fetch(url, { headers: { Authorization: `Bearer ${paymentKey}` } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message || 'Payment data request failed.');
  return body;
}

const yearStart = y => Math.floor(Date.UTC(y, 0, 1) / 1000);
const monthStart = (y, m) => Math.floor(Date.UTC(y, m, 1) / 1000);

async function paidCharges(start, end) {
  let after = '';
  const all = [];
  for (let page = 0; page < 40; page++) {
    const data = await paymentGet('charges', {
      limit: 100,
      'created[gte]': start,
      'created[lt]': end,
      starting_after: after
    });
    all.push(...(data.data || []));
    if (!data.has_more || !data.data?.length) break;
    after = data.data[data.data.length - 1].id;
  }
  return all;
}

function netRevenue(list) {
  return Math.round(list.reduce((sum, charge) => {
    if (!charge.paid || charge.status !== 'succeeded') return sum;
    return sum + ((charge.amount || 0) - (charge.amount_refunded || 0));
  }, 0) / 100);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!(await allowAdmin(req, res))) return;
  try {
    const currentYear = new Date().getUTCFullYear();
    const monthly = [];
    for (let m = 0; m < 12; m++) {
      const start = monthStart(currentYear, m);
      const end = m === 11 ? yearStart(currentYear + 1) : monthStart(currentYear, m + 1);
      const charges = await paidCharges(start, end);
      monthly.push({ month: new Date(Date.UTC(currentYear, m, 1)).toLocaleString('en-US', { month: 'short' }), revenue: netRevenue(charges) });
    }
    const yearly = [];
    for (let y = currentYear - 4; y <= currentYear; y++) {
      const charges = await paidCharges(yearStart(y), yearStart(y + 1));
      yearly.push({ year: String(y), revenue: netRevenue(charges) });
    }
    reply(res, 200, { currency: 'EUR', monthly, yearly, updatedAt: new Date().toISOString() });
  } catch (error) {
    reply(res, 500, { error: error.message || 'Revenue data failed.' });
  }
}
