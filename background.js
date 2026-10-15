// background.js — MV3 service worker: Supabase auth, profile sync, application log.
// Talks to Supabase's REST endpoints directly with fetch (MV3 forbids remotely
// hosted code, and this avoids needing a bundler for supabase-js).
// Leave the two constants empty to run in local-only mode (no account needed).

const SUPABASE_URL = '';      // e.g. 'https://abcdefgh.supabase.co'
const SUPABASE_ANON_KEY = ''; // Project Settings → API → anon / publishable key

const FREE_TRACKER_LIMIT = 10;
const configured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

const PROFILE_COLUMNS = [
  'first_name', 'last_name', 'email', 'phone', 'phone_country', 'address', 'city', 'state', 'zip',
  'linkedin_url', 'website', 'years_experience', 'education', 'work_authorized', 'requires_sponsorship',
  'desired_salary', 'notice_period', 'cover_letter', 'work_history', 'skills',
];

// ---------------------------------------------------------------------------
// Supabase HTTP helpers
// ---------------------------------------------------------------------------
async function auth(path, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.msg || data.message || `Auth error ${res.status}`);
  return data;
}

function toSession(d) {
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_at: d.expires_at || Math.floor(Date.now() / 1000) + d.expires_in,
    user: { id: d.user.id, email: d.user.email },
  };
}

async function getSession() {
  if (!configured()) return null;
  const { session } = await chrome.storage.local.get('session');
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session;
  try {
    const fresh = toSession(await auth('token?grant_type=refresh_token', { refresh_token: session.refresh_token }));
    await chrome.storage.local.set({ session: fresh });
    return fresh;
  } catch {
    await chrome.storage.local.remove('session');
    return null;
  }
}

async function rest(path, { method = 'GET', body, prefer } = {}) {
  const session = await getSession();
  if (!session) throw new Error('Not signed in');
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.code = data?.code;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
function toRow(profile) {
  const row = {};
  for (const col of PROFILE_COLUMNS) if (profile[col] !== undefined) row[col] = profile[col];
  row.years_experience = row.years_experience === '' || row.years_experience == null ? null : Number(row.years_experience);
  return row;
}

async function pushProfile() {
  const session = await getSession();
  if (!session) return;
  const { profile = {}, answers = {} } = await chrome.storage.local.get(['profile', 'answers']);
  await rest('profiles?on_conflict=user_id', {
    method: 'POST',
    body: { user_id: session.user.id, ...toRow(profile), answer_bank: answers, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

async function refreshSubscription() {
  const session = await getSession();
  if (!session) return 'free';
  const rows = await rest(`users?id=eq.${session.user.id}&select=subscription_status`);
  const subscription = rows?.[0]?.subscription_status || 'free';
  await chrome.storage.local.set({ subscription });
  return subscription;
}

async function pullFromServer() {
  const session = await getSession();
  if (!session) return;
  await refreshSubscription();
  const rows = await rest(`profiles?user_id=eq.${session.user.id}&select=*`);
  const local = await chrome.storage.local.get(['profile', 'answers']);
  const row = rows?.[0];
  if (!row) {
    if (local.profile) await pushProfile(); // first sign-in: upload what's cached locally
    return;
  }
  const profile = {};
  for (const col of PROFILE_COLUMNS) profile[col] = row[col] ?? '';
  const answers = { ...(local.answers || {}), ...(row.answer_bank || {}) };
  await chrome.storage.local.set({ profile, answers });
}

async function syncPendingApplications() {
  const session = await getSession();
  if (!session) return;
  const { applications = [], subscription = 'free' } = await chrome.storage.local.get(['applications', 'subscription']);
  let synced = applications.filter((a) => a.synced).length;
  let limitReached = false;

  for (const app of applications) {
    if (app.synced) continue;
    if (subscription !== 'pro' && synced >= FREE_TRACKER_LIMIT) {
      limitReached = true;
      break;
    }
    try {
      await rest('applications', {
        method: 'POST',
        body: {
          job_id: app.job_id, job_title: app.job_title, company: app.company,
          job_url: app.job_url, applied_at: app.applied_at, status: app.status,
        },
        prefer: 'return=minimal',
      });
      app.synced = true;
      synced++;
    } catch (err) {
      if (err.code === '23505') app.synced = true;             // already in tracker
      else if (/FREE_TIER_LIMIT/.test(err.message)) { limitReached = true; break; }
      else throw err;
    }
  }
  await chrome.storage.local.set({ applications, trackerLimitReached: limitReached });
}

// ---------------------------------------------------------------------------
// Message handlers (from popup.js and content.js)
// ---------------------------------------------------------------------------
const handlers = {
  async GET_STATE() {
    const session = await getSession();
    const { subscription = 'free', applications = [], trackerLimitReached = false } =
      await chrome.storage.local.get(['subscription', 'applications', 'trackerLimitReached']);
    return {
      configured: configured(),
      email: session?.user.email || null,
      subscription,
      applicationCount: applications.length,
      trackerLimitReached,
      freeLimit: FREE_TRACKER_LIMIT,
    };
  },

  async SIGN_UP({ email, password }) {
    const data = await auth('signup', { email, password });
    if (!data.access_token) return { needsConfirmation: true };
    await chrome.storage.local.set({ session: toSession(data) });
    await pullFromServer();
    return {};
  },

  async SIGN_IN({ email, password }) {
    const data = await auth('token?grant_type=password', { email, password });
    await chrome.storage.local.set({ session: toSession(data) });
    await pullFromServer();
    await syncPendingApplications();
    return {};
  },

  async SIGN_OUT() {
    await chrome.storage.local.remove(['session', 'subscription', 'trackerLimitReached']);
    return {};
  },

  async SYNC() {
    await pullFromServer();
    await syncPendingApplications();
    return {};
  },

  async SAVE_PROFILE({ profile }) {
    await chrome.storage.local.set({ profile });
    await pushProfile().catch((e) => console.warn('Profile sync failed', e));
    return {};
  },

  async SAVE_ANSWERS({ answers }) {
    await chrome.storage.local.set({ answers });
    await pushProfile().catch((e) => console.warn('Answer sync failed', e));
    return {};
  },

  async LOG_APPLICATION({ job }) {
    const { applications = [] } = await chrome.storage.local.get('applications');
    if (!applications.some((a) => a.job_id === job.job_id)) {
      applications.unshift({ ...job, applied_at: new Date().toISOString(), status: 'applied', synced: false });
      await chrome.storage.local.set({ applications });
    }
    await syncPendingApplications().catch((e) => console.warn('Application sync failed', e));
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true; // async response
});

// Check subscription status whenever the extension loads.
chrome.runtime.onStartup.addListener(() => refreshSubscription().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => refreshSubscription().catch(() => {}));

// TODO(stripe): "Upgrade to Pro" should open a Stripe Checkout link created by the
// backend; the Stripe webhook updates users.subscription_status server-side, and
// refreshSubscription() picks it up here.
