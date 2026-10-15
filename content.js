// content.js — injected on linkedin.com. Only activates on /jobs/* pages
// (LinkedIn is a single-page app, so we inject everywhere and check the path).
(() => {
  'use strict';
  if (window.__easyApplyAutopilot) return;
  window.__easyApplyAutopilot = true;

  // ===========================================================================
  // CONFIG — everything that depends on LinkedIn's DOM lives here.
  // When LinkedIn changes its UI, this is the only block that should need edits.
  // ===========================================================================
  const CONFIG = {
    selectors: {
      modal: '.jobs-easy-apply-modal, div[data-test-modal][role="dialog"]',
      anyDialog: '[role="dialog"], [role="alertdialog"], .artdeco-modal',
      // Job cards are found by these first; if none match, by any link to a job
      // (jobCardLink) and its enclosing <li>.
      jobCard: 'li[data-occludable-job-id], li[data-job-id], div[data-job-id], [data-view-name="job-card"]',
      jobCardIdAttrs: ['data-occludable-job-id', 'data-job-id'],
      jobCardLink: 'a[href*="/jobs/view/"], a[href*="currentJobId="]',
      // Preferred Easy Apply buttons; otherwise any button/link labelled "Easy Apply"
      // that isn't a search filter (excludeApplyButton / filtersBar).
      easyApplyButton: 'button.jobs-apply-button, button[aria-label*="Easy Apply"], a[aria-label*="Easy Apply"]',
      excludeApplyButton: '[aria-pressed], [aria-checked], [role="radio"], [role="checkbox"], [role="switch"], .artdeco-pill, [aria-label*="filter" i]',
      filtersBar: '.search-reusables__filters-bar, #search-reusables__filters-bar, [aria-label*="filters" i]',
      jobTitle: '.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, .t-24.t-bold',
      company: '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name',
      formElement: '.jobs-easy-apply-form-section__grouping, .jobs-easy-apply-form-element, [data-test-form-element]',
      fieldError: '.artdeco-inline-feedback--error, [data-test-form-element-error-messages]',
      modalDismiss: 'button[aria-label="Dismiss"], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]',
      followCompany: 'input#follow-company-checkbox, input[id*="follow-company"]',
      nextPage: 'button[aria-label="View next page"], button.jobs-search-pagination__button--next, button[aria-label*="next page" i]',
      currentPage: '[aria-current="true"], [aria-current="page"]',
      typeaheadOption: '[role="listbox"] [role="option"]',
      // A resume LinkedIn already has on file and has selected for this application.
      selectedDocument: '.jobs-document-upload-redesign-card__container--selected, [class*="document"][aria-checked="true"], [class*="document"] input[type="radio"]:checked',
    },
    // File inputs: matched against label + id + name. First match wins.
    fileRules: [
      { match: /cover.?letter/i, doc: 'coverLetter' },
      { match: /resume|\bcv\b/i, doc: 'resume' },
    ],
    // Matched against a button's aria-label + visible text.
    buttons: {
      submit: /submit application/i,
      review: /\breview\b/i,
      next: /continue to next step|\bnext\b/i,
      discard: /\bdiscard\b/i,
      closeConfirmation: /\bdone\b|\bdismiss\b|not now/i,
    },
    text: {
      easyApply: /easy apply/i,
      alreadyApplied: /\bapplied\b/i,
      applicationSent: /application (was )?sent|your application was sent/i,
      dailyLimit: /easy apply (application )?limit|limit daily submissions|try again tomorrow/i,
      emptySelect: /^select an option$/i,
    },
    // Profile-based answers, tried in order. `kinds` restricts which controls a
    // rule applies to (text | textarea | select | radio | checkbox).
    fieldRules: [
      { match: /first name|given name/i, key: 'first_name', kinds: ['text'] },
      { match: /last name|surname|family name/i, key: 'last_name', kinds: ['text'] },
      { match: /full name|^name$/i, kinds: ['text'], value: (p) => [p.first_name, p.last_name].filter(Boolean).join(' ') },
      { match: /e-?mail/i, key: 'email', kinds: ['text', 'select'] },
      { match: /country code/i, key: 'phone_country', kinds: ['select'] },
      { match: /phone|mobile/i, key: 'phone', kinds: ['text'] },
      { match: /linkedin/i, key: 'linkedin_url', kinds: ['text'] },
      { match: /website|portfolio|github/i, key: 'website', kinds: ['text'] },
      { match: /street|address/i, key: 'address', kinds: ['text'] },
      { match: /\bcity\b|location/i, key: 'city', kinds: ['text'] },
      { match: /\bstate\b|province/i, key: 'state', kinds: ['text', 'select'] },
      { match: /zip|postal/i, key: 'zip', kinds: ['text'] },
      { match: /authori[sz]ed to work|legally (authori[sz]ed|allowed|eligible)|right to work/i, key: 'work_authorized' },
      { match: /sponsorship|require (a )?visa/i, key: 'requires_sponsorship' },
      { match: /salary|compensation|pay expectation/i, key: 'desired_salary', kinds: ['text', 'select'] },
      { match: /notice period/i, key: 'notice_period', kinds: ['text', 'select'] },
      { match: /years.*experience|experience.*years/i, key: 'years_experience', kinds: ['text', 'select'] },
      { match: /highest.*(degree|education)|level of education/i, key: 'education', kinds: ['text', 'select', 'radio'] },
      { match: /cover letter/i, key: 'cover_letter', kinds: ['text', 'textarea'] },
    ],
    timing: {
      waitTimeoutMs: 10000,
      stepDelayMs: [700, 1400],
      maxSteps: 12,
    },
  };

  const DEFAULT_SETTINGS = {
    dryRun: true,            // go through every step but discard instead of submitting
    dailyCap: 25,            // max submitted applications per day
    delaySeconds: 30,        // pause between applications
    followCompany: false,    // uncheck "Follow <company>" before submitting
    defaultSkillYears: '',   // answer for "years with <skill>" when the skill isn't in your profile ('' = ask you)
  };

  // ===========================================================================
  // State + storage
  // ===========================================================================
  const state = {
    running: false,
    seen: new Set(),
    appliedIds: new Set(),
    status: 'Idle',
    session: { applied: 0, dryRun: 0, skipped: 0, needsAnswers: 0 },
    manualFill: false,
    lastSignature: '',
  };
  let profile = {};
  let answers = {};
  let settings = { ...DEFAULT_SETTINGS };

  async function loadData() {
    const d = await chrome.storage.local.get(['profile', 'answers', 'settings', 'applications']);
    profile = d.profile || {};
    answers = d.answers || {};
    settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
    for (const a of d.applications || []) if (a.job_id) state.appliedIds.add(String(a.job_id));
    renderPanel();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.profile || changes.answers || changes.settings)) loadData();
  });

  async function getTodayCount() {
    const { stats } = await chrome.storage.local.get('stats');
    return stats && stats.date === today() ? stats.count : 0;
  }

  async function incrementTodayCount() {
    const count = (await getTodayCount()) + 1;
    await chrome.storage.local.set({ stats: { date: today(), count } });
    return count;
  }

  async function savePending(questions, job) {
    if (!questions.length) return;
    const { pendingQuestions = {} } = await chrome.storage.local.get('pendingQuestions');
    for (const q of questions) {
      const key = normKey(q.label);
      if (!key || answers[key]) continue;
      pendingQuestions[key] = {
        label: q.label,
        kind: q.kind,
        options: optionsOf(q).map((o) => o.text),
        job: job ? `${job.title} @ ${job.company}` : '',
        seenAt: new Date().toISOString(),
      };
    }
    await chrome.storage.local.set({ pendingQuestions });
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = ([a, b]) => a + Math.random() * (b - a);
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const today = () => new Date().toISOString().slice(0, 10);

  // Must match normKey() in popup.js.
  const normKey = (s) => clean(s).toLowerCase().replace(/\brequired\b/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim();

  async function waitFor(fn, timeout = CONFIG.timing.waitTimeoutMs, interval = 200) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  // Interruptible sleep for the long pause between applications.
  async function pause(ms) {
    const end = Date.now() + ms;
    while (state.running && Date.now() < end) await sleep(250);
  }

  // LinkedIn labels often contain the text twice (visible + screen-reader copy).
  function dedupeText(s) {
    s = clean(s);
    const n = s.length;
    for (const [a, b] of [[n / 2, n / 2], [(n - 1) / 2, (n + 1) / 2]]) {
      if (Number.isInteger(a) && a > 0 && s.slice(0, a) === s.slice(b)) return s.slice(0, a).trim();
    }
    return s;
  }

  function isVisible(el) {
    return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function findButton(root, re) {
    if (!root) return null;
    return [...root.querySelectorAll('button')].find(
      (b) => !b.disabled && isVisible(b) && re.test(clean(`${b.getAttribute('aria-label') || ''} ${b.innerText}`))
    ) || null;
  }

  const visibleDialogs = () => [...document.querySelectorAll(CONFIG.selectors.anyDialog)].filter(isVisible);
  // The Easy Apply modal: known selectors first, else any dialog with apply-flow buttons.
  const getModal = () => [...document.querySelectorAll(CONFIG.selectors.modal)].find(isVisible)
    || visibleDialogs().find((d) => findButton(d, CONFIG.buttons.submit) || findButton(d, CONFIG.buttons.next) || findButton(d, CONFIG.buttons.review))
    || null;
  const dialogMatching = (re) => visibleDialogs().find((d) => re.test(d.innerText)) || null;
  const modalSignature = (m) => clean(m.innerText).slice(0, 3000);

  // React tracks input values internally; set through the native prototype setter
  // and fire input/change so React's onChange sees the new value.
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    el.focus();
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  // ===========================================================================
  // Reading the form
  // ===========================================================================
  function labelFor(el) {
    if (el.type === 'radio' || el.type === 'checkbox') {
      const legend = el.closest('fieldset')?.querySelector('legend');
      if (legend) return dedupeText(legend.innerText || legend.textContent);
    }
    const lbl = el.labels?.[0];
    if (lbl) return dedupeText(lbl.innerText || lbl.textContent);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (clean(t)) return dedupeText(t);
    }
    const groupLabel = el.closest(CONFIG.selectors.formElement)?.querySelector('label, legend');
    if (groupLabel) return dedupeText(groupLabel.innerText || groupLabel.textContent);
    return clean(el.placeholder || el.name || '');
  }

  const optionText = (input) => dedupeText(input.labels?.[0]?.innerText || input.labels?.[0]?.textContent || input.value);

  function optionsOf(q) {
    if (q.kind === 'select') {
      return [...q.el.options]
        .filter((o) => o.value && !CONFIG.text.emptySelect.test(clean(o.text)))
        .map((o) => ({ text: clean(o.text), value: o.value }));
    }
    if (q.inputs) return q.inputs.map((i) => ({ text: optionText(i), el: i }));
    return [];
  }

  function controlShown(el) {
    return isVisible(el) || isVisible(el.labels?.[0]) || isVisible(el.closest('fieldset'));
  }

  function collectQuestions(root) {
    const questions = [];
    const groups = new Map();
    for (const el of root.querySelectorAll('input, select, textarea')) {
      if (el.type === 'file') {
        // Upload inputs are usually visually hidden behind an "Upload" button.
        if (el.disabled) continue;
        const label = labelFor(el);
        const haystack = `${label} ${el.id} ${el.name} ${el.getAttribute('aria-label') || ''}`;
        const doc = CONFIG.fileRules.find((r) => r.match.test(haystack))?.doc || null;
        questions.push({ kind: 'file', label: label || doc || 'File upload', el, doc, container: el.closest(CONFIG.selectors.formElement) || el.parentElement });
        continue;
      }
      if (el.disabled || ['hidden', 'submit', 'button', 'search', 'image', 'reset'].includes(el.type)) continue;
      if (el.matches(CONFIG.selectors.followCompany)) continue;
      if (!controlShown(el)) continue;

      const fieldset = el.closest('fieldset');
      if (el.type === 'radio' || (el.type === 'checkbox' && fieldset)) {
        const key = fieldset || `name:${el.name}`;
        if (!groups.has(key)) {
          const q = { kind: el.type, label: labelFor(el), inputs: [], container: fieldset || el.closest(CONFIG.selectors.formElement) };
          groups.set(key, q);
          questions.push(q);
        }
        groups.get(key).inputs.push(el);
        continue;
      }
      const kind = el.tagName === 'SELECT' ? 'select'
        : el.tagName === 'TEXTAREA' ? 'textarea'
        : el.type === 'checkbox' ? 'checkbox'
        : 'text';
      questions.push({ kind, label: labelFor(el), el, container: el.closest(CONFIG.selectors.formElement) || el.parentElement });
    }
    for (const q of questions) q.required = isRequired(q) || q.doc === 'resume';
    return questions;
  }

  function isRequired(q) {
    const els = q.inputs || [q.el];
    if (els.some((e) => e.required || e.getAttribute('aria-required') === 'true')) return true;
    if (q.container?.getAttribute?.('aria-required') === 'true') return true;
    return /\*\s*$|\brequired\b/i.test(q.label);
  }

  function isAnswered(q) {
    switch (q.kind) {
      case 'file':
        return q.el.files.length > 0
          || (q.doc === 'resume' && !!(getModal() || document).querySelector(CONFIG.selectors.selectedDocument));
      case 'text':
      case 'textarea':
        return q.el.value.trim() !== '';
      case 'select': {
        const opt = q.el.options[q.el.selectedIndex];
        return !!opt && !!opt.value && !CONFIG.text.emptySelect.test(clean(opt.text));
      }
      case 'checkbox':
        return q.inputs ? q.inputs.some((i) => i.checked) : q.el.checked || !q.required;
      case 'radio':
        return q.inputs.some((i) => i.checked);
    }
    return false;
  }

  // ===========================================================================
  // Answering
  // ===========================================================================
  const NOT_A_SKILL_QUESTION = undefined;

  // "How many years of experience do you have with Python?" → profile.skills.Python
  function skillYears(label) {
    const m = label.match(/years.*?(?:experience|worked|working)(.*)$/i);
    if (!m || !/\b(with|in|using|of)\b\s+\S/i.test(m[1])) return NOT_A_SKILL_QUESTION;
    const rest = ` ${m[1].toLowerCase().replace(/[?,()/]/g, ' ')} `;
    for (const [skill, years] of Object.entries(profile.skills || {})) {
      if (rest.includes(` ${skill.toLowerCase()} `)) return String(years);
    }
    return settings.defaultSkillYears !== '' ? String(settings.defaultSkillYears) : null;
  }

  function resolveAnswer(q) {
    const key = normKey(q.label);
    if (!key) return null;
    const saved = answers[key]?.answer;
    if (saved != null && saved !== '') return String(saved);

    const years = skillYears(q.label);
    if (years !== NOT_A_SKILL_QUESTION) return years; // null = unknown skill, ask the user

    for (const rule of CONFIG.fieldRules) {
      if (!rule.match.test(q.label)) continue;
      if (rule.kinds && !rule.kinds.includes(q.kind)) continue;
      const v = rule.value ? rule.value(profile) : profile[rule.key];
      if (v != null && String(v).trim() !== '') return String(v);
    }
    return null;
  }

  function pickOption(options, answer) {
    const a = clean(answer).toLowerCase();
    const t = (o) => clean(o.text).toLowerCase();
    return options.find((o) => t(o) === a)
      || options.find((o) => t(o).startsWith(a))
      || options.find((o) => a.length > 2 && t(o).includes(a))
      || null;
  }

  // Attach a file saved in the popup (Profile → Documents) to an upload input.
  async function uploadDocument(q) {
    if (!q.doc) return false;
    const { documents = {} } = await chrome.storage.local.get('documents');
    const doc = documents[q.doc];
    if (!doc) return false;
    const bytes = Uint8Array.from(atob(doc.data), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], doc.name, { type: doc.type }));
    q.el.files = transfer.files;
    q.el.dispatchEvent(new Event('input', { bubbles: true }));
    q.el.dispatchEvent(new Event('change', { bubbles: true }));
    // LinkedIn shows the file name once the upload finishes.
    await waitFor(() => (getModal()?.innerText || '').includes(doc.name), 15000);
    return true;
  }

  async function fillQuestion(q) {
    if (q.kind === 'file') return uploadDocument(q);
    const answer = resolveAnswer(q);
    if (answer == null) return false;

    switch (q.kind) {
      case 'text':
      case 'textarea': {
        setNativeValue(q.el, answer);
        const isTypeahead = q.el.getAttribute('role') === 'combobox' || q.el.hasAttribute('aria-autocomplete');
        if (isTypeahead) {
          const listId = q.el.getAttribute('aria-controls');
          const option = await waitFor(() => {
            const list = listId && document.getElementById(listId);
            const opts = list ? list.querySelectorAll('[role="option"]') : document.querySelectorAll(CONFIG.selectors.typeaheadOption);
            return [...opts].find(isVisible);
          }, 3000);
          option?.click();
        }
        break;
      }
      case 'select': {
        const opt = pickOption(optionsOf(q), answer);
        if (!opt) return false;
        setNativeValue(q.el, opt.value);
        break;
      }
      case 'radio':
      case 'checkbox': {
        if (!q.inputs) {
          // Single checkbox ("I agree…"): answer "yes" to check it.
          if (/^(yes|true|y|1|checked)$/i.test(answer) && !q.el.checked) q.el.click();
          return q.el.checked;
        }
        const wanted = q.kind === 'checkbox' ? answer.split(/\s*;\s*/) : [answer];
        for (const w of wanted) {
          const opt = pickOption(optionsOf(q), w);
          if (!opt) return false;
          if (!opt.el.checked) (opt.el.labels?.[0] || opt.el).click();
        }
        break;
      }
    }
    await sleep(100);
    return isAnswered(q);
  }

  async function fillModal(modal) {
    const questions = collectQuestions(modal);
    let filled = 0;
    const unanswered = [];
    for (const q of questions) {
      if (isAnswered(q)) continue; // LinkedIn pre-fills contact info; don't overwrite
      if (await fillQuestion(q)) filled++;
      else if (q.required) unanswered.push(q);
    }
    return { filled, unanswered, total: questions.length };
  }

  function erroredQuestions(modal) {
    if (!modal) return [];
    return collectQuestions(modal).filter((q) =>
      [...(q.container?.querySelectorAll?.(CONFIG.selectors.fieldError) || [])].some((e) => isVisible(e) && clean(e.innerText))
    );
  }

  const visibleErrors = (modal) =>
    [...modal.querySelectorAll(CONFIG.selectors.fieldError)].filter((e) => isVisible(e) && clean(e.innerText));

  // ===========================================================================
  // Driving the modal
  // ===========================================================================
  function uncheckFollow(modal) {
    const box = modal.querySelector(CONFIG.selectors.followCompany);
    if (box?.checked) (box.labels?.[0] || box).click();
  }

  async function discardApplication() {
    const modal = getModal();
    if (!modal) return;
    const close = modal.querySelector(CONFIG.selectors.modalDismiss) || findButton(modal, /dismiss|close/i);
    close?.click();
    const discard = await waitFor(() => findButton(document, CONFIG.buttons.discard), 4000);
    discard?.click();
    await waitFor(() => !getModal(), 4000);
  }

  async function closeConfirmation() {
    const dlg = dialogMatching(CONFIG.text.applicationSent);
    const btn = dlg && (dlg.querySelector(CONFIG.selectors.modalDismiss) || findButton(dlg, CONFIG.buttons.closeConfirmation));
    btn?.click();
    await sleep(500);
  }

  // Walks the modal step by step. Returns { result, questions? }.
  async function completeApplication() {
    for (let step = 0; step < CONFIG.timing.maxSteps; step++) {
      if (!state.running) return { result: 'stopped' };
      const modal = getModal();
      if (!modal) return { result: 'closed' };

      const { unanswered } = await fillModal(modal);
      if (unanswered.length) return { result: 'needs-answers', questions: unanswered };
      if (!settings.followCompany) uncheckFollow(modal);

      const submit = findButton(modal, CONFIG.buttons.submit);
      if (submit) {
        if (settings.dryRun) return { result: 'dry-run' };
        await sleep(rand(CONFIG.timing.stepDelayMs));
        submit.click();
        const outcome = await waitFor(() => {
          if (dialogMatching(CONFIG.text.applicationSent)) return 'sent';
          const m = getModal();
          if (!m) return 'closed';
          if (visibleErrors(m).length) return 'errors';
          return findButton(m, CONFIG.buttons.submit) ? null : 'moved-on';
        }, 15000);
        if (outcome === 'errors') return { result: 'needs-answers', questions: erroredQuestions(getModal()) };
        return { result: outcome ? 'submitted' : 'unconfirmed' };
      }

      const btn = findButton(modal, CONFIG.buttons.review) || findButton(modal, CONFIG.buttons.next);
      if (!btn) return { result: 'stuck' };
      const before = modalSignature(modal);
      await sleep(rand(CONFIG.timing.stepDelayMs));
      btn.click();

      const outcome = await waitFor(() => {
        const m = getModal();
        if (!m) return 'closed';
        if (visibleErrors(m).length) return 'errors';
        return modalSignature(m) !== before ? 'changed' : null;
      }, 8000);
      await sleep(300);
      const m = getModal();
      if (outcome === 'errors' || !outcome || (m && visibleErrors(m).length)) {
        return { result: 'needs-answers', questions: erroredQuestions(m) };
      }
    }
    return { result: 'stuck' };
  }

  // ===========================================================================
  // Job list loop (auto-apply)
  // ===========================================================================
  const idFromHref = (href) => (href || '').match(/(?:\/jobs\/view\/|currentJobId=)(\d+)/)?.[1] || null;

  function cardId(card) {
    for (const attr of CONFIG.selectors.jobCardIdAttrs) {
      const v = card.getAttribute(attr);
      if (v) return v;
    }
    for (const a of card.querySelectorAll(CONFIG.selectors.jobCardLink)) {
      const id = idFromHref(a.getAttribute('href'));
      if (id) return id;
    }
    return null;
  }

  // All job cards on the page, in order, de-duplicated by job ID.
  function getCards() {
    const cards = new Map();
    const add = (el) => {
      const id = el && cardId(el);
      if (id && !cards.has(id)) cards.set(id, el);
    };
    document.querySelectorAll(CONFIG.selectors.jobCard).forEach(add);
    if (!cards.size) {
      for (const a of document.querySelectorAll(CONFIG.selectors.jobCardLink)) {
        if (a.closest(CONFIG.selectors.anyDialog)) continue;
        add(a.closest('li') || a.parentElement?.parentElement);
      }
    }
    return [...cards].map(([id, card]) => ({ id, card }));
  }

  const nextCard = () => getCards().find((c) => !state.seen.has(c.id)) || null;
  const firstCardId = () => getCards()[0]?.id || null;

  function nextPageButton() {
    const direct = [...document.querySelectorAll(CONFIG.selectors.nextPage)].find(isVisible);
    if (direct) return direct;
    // Numbered pagination: the button after the current page.
    const current = [...document.querySelectorAll(CONFIG.selectors.currentPage)].find((el) => /^\s*\d+\s*$/.test(el.innerText));
    return current?.closest('li')?.nextElementSibling?.querySelector('button') || null;
  }

  async function goToNextPage() {
    const btn = nextPageButton();
    if (!btn || btn.disabled) return false;
    const before = firstCardId();
    btn.click();
    return !!(await waitFor(() => firstCardId() && firstCardId() !== before, 10000));
  }

  function findEasyApplyButton() {
    const cards = getCards().map((c) => c.card);
    const ok = (b) => isVisible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      && CONFIG.text.easyApply.test(clean(`${b.getAttribute('aria-label') || ''} ${b.innerText}`))
      && !b.matches(CONFIG.selectors.excludeApplyButton)
      && !b.closest(CONFIG.selectors.filtersBar)
      && !cards.some((c) => c.contains(b));
    return [...document.querySelectorAll(CONFIG.selectors.easyApplyButton)].find(ok)
      || [...document.querySelectorAll('button, a')].find((b) => ok(b) && clean(b.innerText).length < 40)
      || null;
  }

  // Title/company from the job details pane, falling back to the card text.
  function readJob(id, card) {
    const cards = getCards().map((c) => c.card);
    const titleEl = document.querySelector(CONFIG.selectors.jobTitle)
      || [...document.querySelectorAll('h1, h2')].find((h) => isVisible(h) && !cards.some((c) => c.contains(h)) && !h.closest(CONFIG.selectors.anyDialog) && clean(h.innerText).length > 2);
    let company = clean(document.querySelector(CONFIG.selectors.company)?.innerText);
    for (let node = titleEl; !company && node && node !== document.body; node = node.parentElement) {
      const link = [...node.querySelectorAll('a[href*="/company/"]')].find((a) => clean(a.innerText));
      if (link) company = clean(link.innerText);
    }
    const cardLines = card ? card.innerText.split('\n').map(clean).filter(Boolean) : [];
    const title = dedupeText(clean(titleEl?.innerText)) || dedupeText(cardLines[0] || '');
    company = company || cardLines.slice(1).find((l) => l !== title && !/verification|^viewed|promoted|easy apply/i.test(l)) || '';
    return {
      job_id: id,
      job_title: title || 'Unknown title',
      company: company || 'Unknown company',
      job_url: `https://www.linkedin.com/jobs/view/${id}/`,
    };
  }

  // The job currently open in the details pane (for manual applications).
  function readCurrentJob() {
    const id = idFromHref(location.href);
    if (!id) return null;
    return readJob(id, getCards().find((c) => c.id === id)?.card);
  }

  async function logApplication(job) {
    if (!job || state.appliedIds.has(job.job_id)) return;
    state.appliedIds.add(job.job_id);
    await incrementTodayCount();
    await chrome.runtime.sendMessage({ type: 'LOG_APPLICATION', job }).catch(() => {});
  }

  async function processCard(card, id) {
    state.seen.add(id);
    card.scrollIntoView({ block: 'center' });
    await waitFor(() => clean(card.innerText).length > 0, 3000); // cards render lazily

    const text = clean(card.innerText);
    if (state.appliedIds.has(id) || CONFIG.text.alreadyApplied.test(text)) return 'skipped';
    if (!CONFIG.text.easyApply.test(text)) return 'skipped';

    (card.querySelector(CONFIG.selectors.jobCardLink) || card).click();
    await waitFor(() => location.href.includes(id), 5000);
    await sleep(800);

    const btn = await waitFor(findEasyApplyButton, 6000);
    if (!btn) return 'skipped';
    const job = readJob(id, card);
    setStatus(`Applying: ${job.job_title} @ ${job.company}`);
    btn.click();

    const modal = await waitFor(() => getModal() || dialogMatching(CONFIG.text.dailyLimit), 8000);
    if (!modal) return 'skipped';
    if (CONFIG.text.dailyLimit.test(modal.innerText)) return 'limit';

    const { result, questions = [] } = await completeApplication();

    if (result === 'submitted') {
      await logApplication(job);
      await closeConfirmation();
      return 'applied';
    }

    if (result === 'needs-answers') {
      await savePending(questions, { title: job.job_title, company: job.company });
    }
    if (getModal()) await discardApplication();
    if (result === 'dry-run') return 'dry-run';
    if (result === 'needs-answers') return 'needs-answers';
    if (result === 'stopped') return 'stopped';
    return 'skipped';
  }

  async function runAutopilot() {
    if (state.running) return;
    if (!profile.first_name) {
      setStatus('Fill out your profile in the extension popup first.');
      return;
    }
    state.running = true;
    setStatus(settings.dryRun ? 'Running (dry run — nothing will be submitted)' : 'Running');
    try {
      while (state.running) {
        if (!settings.dryRun && (await getTodayCount()) >= settings.dailyCap) {
          setStatus(`Daily cap of ${settings.dailyCap} reached. Stopped.`);
          break;
        }
        const next = nextCard();
        if (!next && !getCards().length) {
          setStatus("Couldn't find any job cards on this page. LinkedIn's layout may have changed. Click \"Copy debug info\" and send it over.");
          break;
        }
        if (!next) {
          setStatus('Loading next page…');
          if (!(await goToNextPage())) {
            setStatus('No more jobs on this search. Stopped.');
            break;
          }
          continue;
        }

        const outcome = await processCard(next.card, next.id);
        if (outcome === 'limit') {
          setStatus('LinkedIn says you hit the daily Easy Apply limit. Stopped.');
          break;
        }
        if (outcome === 'applied') state.session.applied++;
        else if (outcome === 'dry-run') state.session.dryRun++;
        else if (outcome === 'needs-answers') state.session.needsAnswers++;
        else if (outcome === 'skipped') state.session.skipped++;
        renderPanel();

        if (outcome === 'applied' || outcome === 'dry-run') {
          setStatus(`Waiting ${settings.delaySeconds}s before next job…`);
          await pause(settings.delaySeconds * 1000);
        }
      }
    } catch (err) {
      console.error('[Easy Apply Autopilot]', err);
      setStatus(`Error: ${err.message}. Stopped.`);
    } finally {
      if (/^(Running|Applying|Waiting|Stopping|Loading)/.test(state.status)) setStatus('Stopped.');
      state.running = false;
      renderPanel();
    }
  }

  function stopAutopilot() {
    state.running = false;
    setStatus('Stopping…');
  }

  // ===========================================================================
  // UI: floating control panel + in-modal Autofill button
  // ===========================================================================
  let panelHost = null;

  function setStatus(s) {
    state.status = s;
    renderPanel();
  }

  function ensurePanel() {
    const onJobs = location.pathname.startsWith('/jobs');
    if (!onJobs) {
      panelHost?.remove();
      panelHost = null;
      if (state.running) stopAutopilot();
      return;
    }
    if (panelHost && document.body.contains(panelHost)) return;
    panelHost = document.createElement('div');
    panelHost.id = 'easy-apply-autopilot-panel';
    const root = panelHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .p { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 280px;
             font: 13px/1.4 -apple-system, system-ui, sans-serif; color: #1d1d1f; background: #fff;
             border: 1px solid #d0d0d5; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.15); padding: 12px; }
        .h { display: flex; justify-content: space-between; align-items: center; font-weight: 600; margin-bottom: 8px; }
        .badge { font-size: 11px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
        .dry { background: #fff4d6; color: #7a5600; } .live { background: #fde2e1; color: #9b1c1c; }
        button { width: 100%; padding: 8px; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; color: #fff; background: #0a66c2; }
        button.stop { background: #b42318; }
        .s { margin-top: 8px; color: #444; word-wrap: break-word; }
        .c { margin-top: 6px; color: #666; font-size: 12px; }
        button.link { background: none; color: #0a66c2; width: auto; padding: 0; margin-top: 6px; font-weight: 500; font-size: 12px; }
      </style>
      <div class="p">
        <div class="h"><span>Easy Apply Autopilot</span><span class="badge" id="mode"></span></div>
        <button id="toggle"></button>
        <div class="s" id="status"></div>
        <div class="c" id="counts"></div>
        <button class="link" id="tracker">Open tracker</button> · <button class="link" id="debug">Copy debug info</button>
      </div>`;
    root.getElementById('toggle').addEventListener('click', () => (state.running ? stopAutopilot() : runAutopilot()));
    root.getElementById('debug').addEventListener('click', copyDiagnostics);
    root.getElementById('tracker').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'OPEN_TRACKER' }));
    document.body.appendChild(panelHost);
    renderPanel();
  }

  function renderPanel() {
    const root = panelHost?.shadowRoot;
    if (!root) return;
    const mode = root.getElementById('mode');
    mode.textContent = settings.dryRun ? 'DRY RUN' : 'LIVE';
    mode.className = `badge ${settings.dryRun ? 'dry' : 'live'}`;
    const toggle = root.getElementById('toggle');
    toggle.textContent = state.running ? 'Stop' : 'Start auto-apply';
    toggle.className = state.running ? 'stop' : '';
    root.getElementById('status').textContent = state.status;
    const s = state.session;
    root.getElementById('counts').textContent =
      `This session: ${s.applied} applied · ${s.dryRun} dry-run · ${s.needsAnswers} need answers · ${s.skipped} skipped`;
  }

  // Manual mode: an Autofill button inside the modal; once clicked, it keeps
  // filling each new step until the modal closes.
  function ensureModalButton() {
    const modal = getModal();
    if (!modal) {
      state.manualFill = false;
      state.lastSignature = '';
      return;
    }
    if (state.running) return;

    if (!modal.querySelector('#easy-apply-autopilot-fill')) {
      const btn = document.createElement('button');
      btn.id = 'easy-apply-autopilot-fill';
      btn.type = 'button';
      btn.textContent = '⚡ Autofill';
      btn.style.cssText = 'margin:8px 16px;padding:6px 14px;border-radius:16px;border:0;background:#0a66c2;color:#fff;font-weight:600;cursor:pointer;';
      btn.addEventListener('click', () => {
        state.manualFill = true;
        manualFill(modal, btn);
      });
      (modal.querySelector('.artdeco-modal__header') || modal).appendChild(btn);
    }

    if (state.manualFill) {
      const sig = modalSignature(modal);
      if (sig !== state.lastSignature) manualFill(modal, modal.querySelector('#easy-apply-autopilot-fill'));
    }
  }

  async function manualFill(modal, btn) {
    if (state.fillBusy) {
      state.refillQueued = true; // the step changed mid-fill; run again when done
      return;
    }
    state.fillBusy = true;
    try {
      state.lastSignature = modalSignature(modal);
      const { filled, unanswered } = await fillModal(modal);
      if (unanswered.length) await savePending(unanswered);
      if (btn) {
        btn.textContent = unanswered.length
          ? `⚡ Filled ${filled} · ${unanswered.length} need you`
          : `⚡ Filled ${filled}`;
      }
      state.lastSignature = modalSignature(modal);
    } finally {
      state.fillBusy = false;
      if (state.refillQueued) {
        state.refillQueued = false;
        const m = getModal();
        if (m) setTimeout(() => manualFill(m, m.querySelector('#easy-apply-autopilot-fill')), 0);
      }
    }
  }

  // ===========================================================================
  // Diagnostics: page structure (no field values) for fixing selectors
  // ===========================================================================
  function describe(el) {
    if (!el) return 'none';
    const attrs = [...el.attributes]
      .filter((a) => /^(data-|role$|aria-label$|aria-pressed$|aria-checked$|aria-current$|href$|type$|name$)/.test(a.name))
      .map((a) => `${a.name}="${a.value.slice(0, 70)}"`).join(' ');
    return `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].slice(0, 4).map((c) => '.' + c).join('')} ${attrs}>`;
  }

  function ancestry(el, depth) {
    const out = [];
    for (let i = 0; el && i < depth; i++, el = el.parentElement) out.push(describe(el));
    return out.join('\n      ← ');
  }

  function diagnostics() {
    const lines = [`Easy Apply Autopilot debug · ${new Date().toISOString()}`, `path: ${location.pathname} currentJobId=${idFromHref(location.href)}`];
    for (const [key, sel] of Object.entries(CONFIG.selectors)) {
      if (typeof sel !== 'string') continue;
      try { lines.push(`selector ${key}: ${document.querySelectorAll(sel).length}`); } catch { lines.push(`selector ${key}: INVALID`); }
    }
    const cards = getCards();
    lines.push(`cards found: ${cards.length}`);
    if (cards[0]) lines.push(`first card text: ${clean(cards[0].card.innerText).slice(0, 150)}`);
    const links = [...document.querySelectorAll(CONFIG.selectors.jobCardLink)];
    lines.push(`job links: ${links.length}`);
    if (links[0]) lines.push(`first job link ancestry:\n      ${ancestry(links[0], 10)}`);
    const easy = [...document.querySelectorAll('button, a')].filter((b) => isVisible(b) && /easy apply/i.test(`${b.getAttribute('aria-label') || ''} ${b.innerText}`));
    lines.push(`visible "Easy Apply" elements: ${easy.length}`);
    easy.slice(0, 6).forEach((b) => lines.push(`  - ${ancestry(b, 3)}`));
    lines.push(`chosen Easy Apply button: ${describe(findEasyApplyButton())}`);
    lines.push(`modal detected: ${describe(getModal())}`);
    visibleDialogs().forEach((d, i) => {
      lines.push(`dialog ${i}: ${describe(d)}`);
      [...d.querySelectorAll('button')].slice(0, 10).forEach((b) => lines.push(`    button: ${clean(b.getAttribute('aria-label') || b.innerText).slice(0, 60)}`));
      [...d.querySelectorAll('input, select, textarea')].slice(0, 20).forEach((e) =>
        lines.push(`    field: ${e.tagName.toLowerCase()} type=${e.type} id=${e.id} label="${labelFor(e).slice(0, 80)}" ${describe(e.closest(CONFIG.selectors.formElement) || e.parentElement)}`));
    });
    lines.push(`status: ${state.status}`);
    return lines.join('\n');
  }

  async function copyDiagnostics() {
    const text = diagnostics();
    console.log(text);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setStatus('Debug info copied to clipboard. Paste it to Claude.');
  }

  // ===========================================================================
  // Log applications you submit yourself (manual mode)
  // ===========================================================================
  function trackManualJob() {
    const modal = getModal();
    if (modal && !state.modalWasOpen) state.manualJob = readCurrentJob();
    state.modalWasOpen = !!modal;
  }

  document.addEventListener('click', (e) => {
    if (state.running) return;
    const btn = e.target.closest?.('button');
    const modal = getModal();
    if (!btn || !modal || !modal.contains(btn)) return;
    if (!CONFIG.buttons.submit.test(clean(`${btn.getAttribute('aria-label') || ''} ${btn.innerText}`))) return;
    const job = state.manualJob || readCurrentJob();
    setTimeout(() => {
      const m = getModal();
      if (m && (visibleErrors(m).length || findButton(m, CONFIG.buttons.submit))) return; // didn't go through
      logApplication(job);
    }, 4000);
  }, true);

  // ===========================================================================
  // Boot: watch the DOM for SPA navigation and the Easy Apply modal
  // ===========================================================================
  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      ensurePanel();
      trackManualJob();
      ensureModalButton();
    }, 300);
  });

  loadData().then(() => {
    ensurePanel();
    ensureModalButton();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
