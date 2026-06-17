import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, body) {
  res.status(status).json(body);
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

function getRole(user) {
  return String(user?.app_metadata?.role || user?.user_metadata?.role || '').toLowerCase();
}

async function requireAdmin(req, res) {
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    json(res, 500, { error: 'Missing Supabase server environment variables. Add SUPABASE_SERVICE_ROLE_KEY in Vercel.' });
    return null;
  }

  const token = getBearerToken(req);
  if (!token) {
    json(res, 401, { error: 'Missing auth token.' });
    return null;
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) {
    json(res, 401, { error: 'Invalid auth token.' });
    return null;
  }

  if (getRole(data.user) !== 'admin') {
    json(res, 403, { error: 'Admin only.' });
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

function cleanUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.app_metadata?.role || user.user_metadata?.role || 'freelancer',
    created_at: user.created_at,
    last_sign_in_at: user.last_sign_in_at,
    email_confirmed_at: user.email_confirmed_at
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    if (req.method === 'GET') {
      const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (error) return json(res, 400, { error: error.message });
      return json(res, 200, { users: (data.users || []).map(cleanUser) });
    }

    if (req.method !== 'POST') {
      return json(res, 405, { error: 'Method not allowed.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = body.action;

    if (action === 'create') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const role = String(body.role || 'freelancer').toLowerCase() === 'admin' ? 'admin' : 'freelancer';
      const invite = Boolean(body.invite);

      if (!email) return json(res, 400, { error: 'Email is required.' });
      if (!invite && password.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters.' });

      if (invite) {
        const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
          data: { role },
          redirectTo: process.env.SITE_URL || undefined
        });
        if (error) return json(res, 400, { error: error.message });
        if (data?.user?.id) {
          await admin.auth.admin.updateUserById(data.user.id, {
            app_metadata: { role },
            user_metadata: { role }
          });
        }
        return json(res, 200, { user: cleanUser(data.user), invited: true });
      }

      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: { role },
        user_metadata: { role }
      });
      if (error) return json(res, 400, { error: error.message });
      return json(res, 200, { user: cleanUser(data.user) });
    }

    if (action === 'role') {
      const userId = String(body.userId || '');
      const role = String(body.role || 'freelancer').toLowerCase() === 'admin' ? 'admin' : 'freelancer';
      if (!userId) return json(res, 400, { error: 'User ID is required.' });
      const { data, error } = await admin.auth.admin.updateUserById(userId, {
        app_metadata: { role },
        user_metadata: { role }
      });
      if (error) return json(res, 400, { error: error.message });
      return json(res, 200, { user: cleanUser(data.user) });
    }

    if (action === 'delete') {
      const userId = String(body.userId || '');
      if (!userId) return json(res, 400, { error: 'User ID is required.' });
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) return json(res, 400, { error: error.message });
      return json(res, 200, { ok: true });
    }

    if (action === 'resetPassword') {
      const userId = String(body.userId || '');
      const password = String(body.password || '');
      if (!userId) return json(res, 400, { error: 'User ID is required.' });
      if (password.length < 6) return json(res, 400, { error: 'Password must be at least 6 characters.' });
      const { data, error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json(res, 400, { error: error.message });
      return json(res, 200, { user: cleanUser(data.user) });
    }

    return json(res, 400, { error: 'Unknown action.' });
  } catch (error) {
    return json(res, 500, { error: error.message || 'Server error.' });
  }
}
