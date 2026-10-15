// popup.js — profile editor, answer bank, settings and account.

const PROFILE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'phone_country', 'address', 'city', 'state', 'zip',
  'linkedin_url', 'website', 'years_experience', 'education', 'work_authorized', 'requires_sponsorship',
  'desired_salary', 'notice_period', 'cover_letter',
];
const DEFAULT_SETTINGS = { dryRun: true, dailyCap: 25, delaySeconds: 30, followCompany: false, defaultSkillYears: '' };

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// Must match normKey() in content.js.
const normKey = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
  .replace(/\brequired\b/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim();

function flash(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.className = `msg${isError ? ' err' : ''}`;
  if (!isError) setTimeout(() => (el.textContent = ''), 2500);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav button, section').forEach((n) => n.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.tab).classList.add('active');
  });
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
function skillsToText(skills = {}) {
  return Object.entries(skills).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function textToSkills(text) {
  const skills = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(.+?)\s*[:=-]\s*(\d+(?:\.\d+)?)\s*$/);
    if (m) skills[m[1]] = Number(m[2]);
  }
  return skills;
}

function addWorkRow(job = {}) {
  const field = (name, label, placeholder = '') =>
    el('label', { text: label }, [el('input', { 'data-k': name, value: job[name] || '', placeholder })]);
  const row = el('div', { class: 'wh' }, [
    el('div', { class: 'row' }, [field('title', 'Title'), field('company', 'Company')]),
    el('div', { class: 'row' }, [field('start', 'Start', '2021-03'), field('end', 'End', 'Present')]),
    el('button', { class: 'btn danger', type: 'button', text: 'Remove', onclick: () => row.remove() }),
  ]);
  $('workHistory').append(row);
}

function readWorkHistory() {
  return [...$('workHistory').querySelectorAll('.wh')].map((row) => {
    const job = {};
    row.querySelectorAll('input').forEach((i) => (job[i.dataset.k] = i.value.trim()));
    return job;
  }).filter((j) => j.title || j.company);
}

$('addJob').addEventListener('click', () => addWorkRow());

$('saveProfile').addEventListener('click', async () => {
  const profile = {};
  for (const f of PROFILE_FIELDS) profile[f] = $(f).value.trim();
  profile.skills = textToSkills($('skills').value);
  profile.work_history = readWorkHistory();
  if (!profile.first_name || !profile.last_name || !profile.email) {
    return flash('profileMsg', 'First name, last name and email are required.', true);
  }
  const res = await send({ type: 'SAVE_PROFILE', profile });
  res?.ok ? flash('profileMsg', 'Saved') : flash('profileMsg', res?.error || 'Save failed', true);
});

// ---------------------------------------------------------------------------
// Answer bank
// ---------------------------------------------------------------------------
let answers = {};
let pending = {};

function answerInput(options, value = '') {
  if (options?.length) {
    const select = el('select', {}, [el('option', { value: '', text: 'Choose…' })]);
    for (const o of options) select.append(el('option', { value: o, text: o }));
    select.value = value;
    return select;
  }
  return el('input', { value, placeholder: 'Your answer' });
}

function renderAnswers() {
  const pendingEntries = Object.entries(pending);
  $('pendingCount').hidden = pendingEntries.length === 0;
  $('pendingCount').textContent = pendingEntries.length;

  $('pendingList').replaceChildren(...(pendingEntries.length ? pendingEntries.map(([key, q]) => {
    const input = answerInput(q.options);
    const save = async () => {
      if (!input.value.trim()) return;
      answers[key] = { label: q.label, answer: input.value.trim(), options: q.options || [] };
      delete pending[key];
      await chrome.storage.local.set({ pendingQuestions: pending });
      await send({ type: 'SAVE_ANSWERS', answers });
      renderAnswers();
    };
    const dismiss = async () => {
      delete pending[key];
      await chrome.storage.local.set({ pendingQuestions: pending });
      renderAnswers();
    };
    return el('div', { class: 'card' }, [
      el('div', { class: 'q', text: q.label }),
      el('div', { class: 'meta', text: [q.kind, q.job].filter(Boolean).join(' · ') }),
      el('div', { class: 'line' }, [
        input,
        el('button', { class: 'btn', text: 'Save', onclick: save }),
        el('button', { class: 'btn danger', text: '✕', title: 'Dismiss', onclick: dismiss }),
      ]),
    ]);
  }) : [el('p', { class: 'hint', text: 'Nothing waiting. 🎉' })]));

  const saved = Object.entries(answers);
  $('answerList').replaceChildren(...(saved.length ? saved.map(([key, a]) => {
    const input = answerInput(a.options, a.answer);
    input.addEventListener('change', async () => {
      answers[key].answer = input.value.trim();
      await send({ type: 'SAVE_ANSWERS', answers });
    });
    return el('div', { class: 'card' }, [
      el('div', { class: 'q', text: a.label }),
      el('div', { class: 'line' }, [
        input,
        el('button', {
          class: 'btn danger', text: '✕', title: 'Delete',
          onclick: async () => {
            delete answers[key];
            await send({ type: 'SAVE_ANSWERS', answers });
            renderAnswers();
          },
        }),
      ]),
    ]);
  }) : [el('p', { class: 'hint', text: 'No saved answers yet.' })]));
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
$('saveSettings').addEventListener('click', async () => {
  const settings = {
    dryRun: $('dryRun').checked,
    followCompany: $('followCompany').checked,
    dailyCap: Math.max(1, Number($('dailyCap').value) || DEFAULT_SETTINGS.dailyCap),
    delaySeconds: Math.max(5, Number($('delaySeconds').value) || DEFAULT_SETTINGS.delaySeconds),
    defaultSkillYears: $('defaultSkillYears').value.trim(),
  };
  await chrome.storage.local.set({ settings });
  flash('settingsMsg', settings.dryRun ? 'Saved (dry run)' : 'Saved (LIVE: will submit)');
});

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
async function renderAccount() {
  const s = await send({ type: 'GET_STATE' });
  if (!s?.ok) return flash('accountMsg', s?.error || 'Could not load account', true);
  $('notConfigured').hidden = s.configured;
  $('signedOut').hidden = !s.configured || !!s.email;
  $('signedIn').hidden = !s.email;
  $('userEmail').textContent = s.email || '';
  $('plan').textContent = s.subscription === 'pro' ? 'Pro' : 'Free';
  $('trackerInfo').textContent = s.subscription === 'pro'
    ? `${s.applicationCount} applications logged. Unlimited tracker.`
    : `${s.applicationCount} applications logged. Free plan syncs up to ${s.freeLimit} to your tracker${s.trackerLimitReached ? ' (limit reached; upgrade for unlimited)' : ''}.`;
}

async function authAction(type) {
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || !password) return flash('accountMsg', 'Email and password required.', true);
  const res = await send({ type, email, password });
  if (!res?.ok) return flash('accountMsg', res?.error || 'Failed', true);
  if (res.needsConfirmation) flash('accountMsg', 'Check your email to confirm, then sign in.');
  await loadAll();
}

$('signIn').addEventListener('click', () => authAction('SIGN_IN'));
$('signUp').addEventListener('click', () => authAction('SIGN_UP'));
$('signOut').addEventListener('click', async () => { await send({ type: 'SIGN_OUT' }); renderAccount(); });
$('syncNow').addEventListener('click', async () => {
  const res = await send({ type: 'SYNC' });
  res?.ok ? flash('accountMsg', 'Synced') : flash('accountMsg', res?.error || 'Sync failed', true);
  loadAll();
});

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------
async function loadAll() {
  const d = await chrome.storage.local.get(['profile', 'answers', 'pendingQuestions', 'settings']);
  const profile = d.profile || {};
  for (const f of PROFILE_FIELDS) $(f).value = profile[f] ?? '';
  $('skills').value = skillsToText(profile.skills);
  $('workHistory').replaceChildren();
  (profile.work_history || []).forEach(addWorkRow);

  answers = d.answers || {};
  pending = d.pendingQuestions || {};
  for (const key of Object.keys(pending)) if (answers[key]) delete pending[key];
  renderAnswers();

  const settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  $('dryRun').checked = settings.dryRun;
  $('followCompany').checked = settings.followCompany;
  $('dailyCap').value = settings.dailyCap;
  $('delaySeconds').value = settings.delaySeconds;
  $('defaultSkillYears').value = settings.defaultSkillYears;

  renderAccount();
}

loadAll();
