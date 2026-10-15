// dashboard.js — application tracker (reads chrome.storage.local.applications).

const STATUSES = ['applied', 'interviewing', 'offer', 'rejected', 'withdrawn'];
const FREE_VISIBLE = 10;

const $ = (id) => document.getElementById(id);
let applications = [];
let isPro = false;

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

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function visibleApplications() {
  // Free plan shows the most recent 10; everything is still recorded.
  const sorted = [...applications].sort((a, b) => b.applied_at.localeCompare(a.applied_at));
  return isPro ? sorted : sorted.slice(0, FREE_VISIBLE);
}

function render() {
  const now = Date.now();
  const today = new Date().toDateString();
  $('statTotal').textContent = applications.length;
  $('statToday').textContent = applications.filter((a) => new Date(a.applied_at).toDateString() === today).length;
  $('statWeek').textContent = applications.filter((a) => now - new Date(a.applied_at) < 7 * 864e5).length;
  $('statInterview').textContent = applications.filter((a) => a.status === 'interviewing').length;
  $('statOffer').textContent = applications.filter((a) => a.status === 'offer').length;

  const hidden = applications.length - visibleApplications().length;
  $('upgrade').hidden = hidden <= 0;
  $('upgradeText').textContent = `Free plan shows your ${FREE_VISIBLE} most recent applications. ${hidden} older one${hidden === 1 ? ' is' : 's are'} saved. Upgrade to Pro to see them all.`;

  const q = $('search').value.trim().toLowerCase();
  const status = $('statusFilter').value;
  const rows = visibleApplications().filter((a) =>
    (!q || `${a.job_title} ${a.company}`.toLowerCase().includes(q)) && (!status || a.status === status));

  if (!rows.length) {
    $('rows').replaceChildren(el('tr', {}, [el('td', {
      colspan: '5', class: 'empty',
      text: applications.length ? 'No applications match.' : 'No applications yet. They appear here as soon as one is submitted.',
    })]));
    return;
  }

  $('rows').replaceChildren(...rows.map((a) => {
    const select = el('select', {}, STATUSES.map((s) => el('option', { value: s, text: s[0].toUpperCase() + s.slice(1) })));
    select.value = a.status || 'applied';
    select.addEventListener('change', () => chrome.runtime.sendMessage({ type: 'UPDATE_APPLICATION', job_id: a.job_id, status: select.value }));
    return el('tr', {}, [
      el('td', { class: 'muted', text: fmtDate(a.applied_at) }),
      el('td', {}, [el('a', { href: a.job_url, target: '_blank', rel: 'noopener', text: a.job_title })]),
      el('td', { text: a.company }),
      el('td', {}, [select]),
      el('td', {}, [el('button', {
        class: 'del', title: 'Delete', text: '✕',
        onclick: () => confirm(`Remove "${a.job_title}" from the tracker?`) && chrome.runtime.sendMessage({ type: 'DELETE_APPLICATION', job_id: a.job_id }),
      })]),
    ]);
  }));
}

function exportCsv() {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Date', 'Job title', 'Company', 'Status', 'URL'].join(',')];
  for (const a of visibleApplications()) lines.push([a.applied_at, a.job_title, a.company, a.status, a.job_url].map(esc).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  el('a', { href: url, download: `applications-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  URL.revokeObjectURL(url);
}

async function load() {
  const [{ applications: apps = [] }, state] = await Promise.all([
    chrome.storage.local.get('applications'),
    chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => null),
  ]);
  applications = apps;
  isPro = state?.subscription === 'pro';
  render();
}

$('search').addEventListener('input', render);
$('statusFilter').addEventListener('change', render);
$('exportCsv').addEventListener('click', exportCsv);
$('upgradeBtn').addEventListener('click', () => alert('Pro upgrades are coming soon.'));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.applications || changes.subscription)) load();
});

load();
