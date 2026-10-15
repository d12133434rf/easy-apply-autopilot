import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import os from 'os';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIR = path.dirname(new URL(import.meta.url).pathname);
const mock = fs.readFileSync(path.join(DIR, 'mock.html'), 'utf8');
const reactJs = fs.readFileSync(path.join(DIR, 'node_modules/react/umd/react.development.js'), 'utf8');
const reactDomJs = fs.readFileSync(path.join(DIR, 'node_modules/react-dom/umd/react-dom.development.js'), 'utf8');

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('PASS:', msg); };

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await ctx.route('https://www.linkedin.com/**', (route) => {
  const u = new URL(route.request().url());
  if (u.pathname === '/mock/react.js') return route.fulfill({ body: reactJs, contentType: 'text/javascript' });
  if (u.pathname === '/mock/react-dom.js') return route.fulfill({ body: reactDomJs, contentType: 'text/javascript' });
  return route.fulfill({ body: mock, contentType: 'text/html' });
});

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const storage = (fn, arg) => sw.evaluate(fn, arg);

await storage(() => chrome.storage.local.set({
  profile: {
    first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '5551234567',
    phone_country: 'United States (+1)', work_authorized: 'Yes', requires_sponsorship: 'No',
    years_experience: 6, skills: { Python: 5 },
  },
  documents: {
    resume: { name: 'Jane_Doe_Resume.pdf', type: 'application/pdf', size: 9, data: btoa('%PDF-1.4\n') },
    coverLetter: { name: 'Jane_Doe_Cover.pdf', type: 'application/pdf', size: 9, data: btoa('%PDF-1.4\n') },
  },
  settings: { dryRun: false, dailyCap: 25, delaySeconds: 1, followCompany: false, defaultSkillYears: '' },
}));

const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('[page error]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

async function runUntilStopped() {
  await page.goto('https://www.linkedin.com/jobs/search/');
  await page.locator('#easy-apply-autopilot-panel button').click({ timeout: 10000 });
  await page.waitForFunction(() => {
    const s = document.querySelector('#easy-apply-autopilot-panel').shadowRoot.getElementById('status').textContent;
    return /Stopped|No more jobs/.test(s);
  }, null, { timeout: 90000 });
  return page.evaluate(() => ({
    subs: window.__submissions,
    status: document.querySelector('#easy-apply-autopilot-panel').shadowRoot.getElementById('status').textContent,
    counts: document.querySelector('#easy-apply-autopilot-panel').shadowRoot.getElementById('counts').textContent,
  }));
}

// --- Run 1: job 101 should submit, 102 skip (not Easy Apply), 103 needs an answer, 104 already applied
let r = await runUntilStopped();
console.log('run 1:', r.status, '|', r.counts);
assert(r.subs.length === 1, 'exactly one application submitted in run 1');
const s = r.subs[0] || {};
assert(s.job === '101', 'submitted job 101');
assert(s.firstName === 'Jane' && s.lastName === 'Doe', 'React state received names');
assert(s.email === 'jane@example.com', 'email select set');
assert(s.phoneCountry === 'United States (+1)' && s.phone === '5551234567', 'phone country + phone');
assert(s.python === '5', 'skill years from profile.skills');
assert(s.authorized === 'Yes' && s.sponsorship === 'No', 'radio + select screening answers');
assert(s.follow === false, 'follow-company unchecked');
assert(s.resume === 'Jane_Doe_Resume.pdf' && s.coverLetter === 'Jane_Doe_Cover.pdf', 'resume + cover letter files uploaded');

let st = await storage(() => chrome.storage.local.get(['pendingQuestions', 'applications', 'stats']));
const pendingKeys = Object.keys(st.pendingQuestions || {});
console.log('pending:', pendingKeys);
assert(pendingKeys.some((k) => k.includes('weekends')), 'unknown weekends question saved for the user');
assert(st.applications?.length === 1 && st.applications[0].job_title === 'Frontend Engineer' && st.applications[0].company === 'Acme', 'application logged with title/company');
assert(st.stats?.count === 1, 'daily count incremented');
assert(await page.locator('.jobs-easy-apply-modal').count() === 0, 'no modal left open');

// --- Run 2: user answers the weekends question → 103 submits, 101 not re-applied
const key = pendingKeys.find((k) => k.includes('weekends'));
await storage((k) => chrome.storage.local.set({ answers: { [k]: { label: 'Are you willing to work weekends?', answer: 'Yes' } }, pendingQuestions: {} }), key);
r = await runUntilStopped();
console.log('run 2:', r.status, '|', r.counts);
assert(r.subs.length === 1 && r.subs[0].job === '103' && r.subs[0].weekends === 'Yes', 'job 103 submitted using answer bank; 101 not re-applied');
assert(r.subs[0]?.resume === '' && r.subs[0]?.coverLetter === 'Jane_Doe_Cover.pdf', 'existing LinkedIn resume kept (no duplicate upload)');

// --- Run 3: dry run never submits
await storage(() => chrome.storage.local.set({ applications: [], settings: { dryRun: true, dailyCap: 25, delaySeconds: 1, followCompany: false, defaultSkillYears: '' } }));
r = await runUntilStopped();
console.log('run 3:', r.status, '|', r.counts);
assert(r.subs.length === 0 && /2 dry-run/.test(r.counts), 'dry run reaches submit on 2 jobs but submits nothing');

// --- Manual mode: Autofill button fills step 1, then re-fills step 2 automatically
await page.goto('https://www.linkedin.com/jobs/search/');
await page.locator('li[data-occludable-job-id="101"]').click();
await page.locator('button.jobs-apply-button').click();
await page.locator('#easy-apply-autopilot-fill').click({ timeout: 5000 });
await page.waitForFunction(() => /Filled/.test(document.getElementById('easy-apply-autopilot-fill')?.textContent));
console.log('button:', await page.locator('#easy-apply-autopilot-fill').textContent());
await page.locator('button[aria-label="Continue to next step"]').click();
const up = await page.waitForFunction(() => document.querySelector('.jobs-easy-apply-modal')?.innerText.includes('Jane_Doe_Resume.pdf'), null, { timeout: 8000 }).then(() => true, () => false);
assert(up, 'manual mode fills the next step (resume upload) automatically');

await ctx.close();
