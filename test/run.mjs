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

async function runUntilStopped(query = '') {
  await page.goto('https://www.linkedin.com/jobs/search/' + query);
  await page.locator('#easy-apply-autopilot-panel #toggle').click({ timeout: 10000 });
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

// --- Run 1 (layout without LinkedIn's classic classes): 101 submits, 102 skipped
// (not Easy Apply), 103 needs an answer, 104 already applied
let r = await runUntilStopped('?new=1');
assert(!(await page.evaluate(() => window.__pillClicked)), 'did not click the "Easy Apply" search filter');
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
assert(st.applications?.length === 1 && st.applications[0].job_title === 'Frontend Engineer' && st.applications[0].company === 'Acme', 'application logged with title/company (fallback readers)');
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
await page.locator('button[aria-label="Continue to next step"]').click();
await page.waitForFunction(() => document.getElementById('py')?.value === '5' && document.getElementById('sp')?.value === 'No', null, { timeout: 8000 });
await page.locator('button[aria-label="Review your application"]').click();
await page.locator('button[aria-label="Submit application"]').click();
await page.waitForTimeout(5000);
st = await storage(() => chrome.storage.local.get('applications'));
assert(st.applications?.some((a) => a.job_id === '101' && a.job_title === 'Frontend Engineer'), 'manual submission logged to tracker');

// --- Popup: fields save as you type (no Save click), even if the popup closes right away
const extId = new URL(sw.url()).host;
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.locator('#city').fill('Austin');
await storage(() => chrome.storage.local.set({ pendingQuestions: { 'do you have a drivers license': { label: 'Do you have a driver\'s license?', kind: 'radio', options: ['Yes', 'No'] } } }));
await popup.reload();
await popup.locator('nav button[data-tab="answers"]').click();
await popup.locator('#pendingList select').selectOption('Yes');
await popup.close();
st = await storage(() => chrome.storage.local.get(['profile', 'answers']));
assert(st.profile?.city === 'Austin' && st.profile?.first_name === 'Jane', 'profile field autosaved without clicking Save');
assert(st.answers?.['do you have a drivers license']?.answer === 'Yes', 'pending answer autosaved without clicking Save');

// --- Tracker page lists applications and updates status
const dash = await ctx.newPage();
await dash.goto(`chrome-extension://${extId}/dashboard.html`);
await dash.waitForSelector('#rows tr td a');
assert(await dash.locator('#rows tr').count() === 1 && (await dash.locator('#statTotal').textContent()) === '1', 'tracker shows the logged application');
await dash.locator('#rows select').selectOption('interviewing');
await dash.waitForTimeout(500);
st = await storage(() => chrome.storage.local.get('applications'));
assert(st.applications[0].status === 'interviewing', 'tracker status change saved');

await ctx.close();
