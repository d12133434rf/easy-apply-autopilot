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
      jobCard: 'li[data-occludable-job-id], div[data-job-id]',
      jobCardIdAttrs: ['data-occludable-job-id', 'data-job-id'],
      jobCardLink: 'a.job-card-container__link, a.job-card-list__title, a[href*="/jobs/view/"]',
      easyApplyButton: 'button.jobs-apply-button, button[aria-label*="Easy Apply"]',
      jobTitle: '.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, .t-24.t-bold',
      company: '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name',
      formElement: '.jobs-easy-apply-form-section__grouping, .jobs-easy-apply-form-element, [data-test-form-element]',
      fieldError: '.artdeco-inline-feedback--error, [data-test-form-element-error-messages]',
      modalDismiss: 'button[aria-label="Dismiss"], button.artdeco-modal__dismiss, button[data-test-modal-close-btn]',
      followCompany: 'input#follow-company-checkbox, input[id*="follow-company"]',
      nextPage: 'button[aria-label="View next page"], button.jobs-search-pagination__button--next',
      typeaheadOption: '[role="listbox"] [role="option"]',
    },
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

  const getModal = () => [...document.querySelectorAll(CONFIG.selectors.modal)].find(isVisible) || null;
  const visibleDialogs = () => [...document.querySelectorAll(CONFIG.selectors.anyDialog)].filter(isVisible);
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
      if (el.disabled || ['hidden', 'file', 'submit', 'button', 'search', 'image', 'reset'].includes(el.type)) continue;
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
    for (const q of questions) q.required = isRequired(q);
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

  async function fillQuestion(q) {
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
        const sent = await waitFor(() => dialogMatching(CONFIG.text.applicationSent), 15000);
        return { result: sent ? 'submitted' : 'unconfirmed' };
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
  function cardId(card) {
    for (const attr of CONFIG.selectors.jobCardIdAttrs) {
      const v = card.getAttribute(attr);
      if (v) return v;
    }
    return null;
  }

  function nextCard() {
    for (const card of document.querySelectorAll(CONFIG.selectors.jobCard)) {
      const id = cardId(card);
      if (id && !state.seen.has(id)) return { card, id };
    }
    return null;
  }

  function firstCardId() {
    const card = document.querySelector(CONFIG.selectors.jobCard);
    return card ? cardId(card) : null;
  }

  async function goToNextPage() {
    const btn = document.querySelector(CONFIG.selectors.nextPage);
    if (!btn || btn.disabled) return false;
    const before = firstCardId();
    btn.click();
    return !!(await waitFor(() => firstCardId() && firstCardId() !== before, 10000));
  }

  function findEasyApplyButton() {
    return [...document.querySelectorAll(CONFIG.selectors.easyApplyButton)].find(
      (b) => !b.disabled && isVisible(b) && CONFIG.text.easyApply.test(`${b.getAttribute('aria-label') || ''} ${b.innerText}`)
    ) || null;
  }

  function readJob(id, card) {
    const pick = (sel) => clean(document.querySelector(sel)?.innerText);
    const cardTitle = clean(card.querySelector(CONFIG.selectors.jobCardLink)?.innerText);
    return {
      job_id: id,
      job_title: dedupeText(pick(CONFIG.selectors.jobTitle) || cardTitle) || 'Unknown title',
      company: pick(CONFIG.selectors.company) || 'Unknown company',
      job_url: `https://www.linkedin.com/jobs/view/${id}/`,
    };
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
      state.appliedIds.add(id);
      await incrementTodayCount();
      await chrome.runtime.sendMessage({ type: 'LOG_APPLICATION', job }).catch(() => {});
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
      </style>
      <div class="p">
        <div class="h"><span>Easy Apply Autopilot</span><span class="badge" id="mode"></span></div>
        <button id="toggle"></button>
        <div class="s" id="status"></div>
        <div class="c" id="counts"></div>
      </div>`;
    root.getElementById('toggle').addEventListener('click', () => (state.running ? stopAutopilot() : runAutopilot()));
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
    if (state.fillBusy) return;
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
    }
  }

  // ===========================================================================
  // Boot: watch the DOM for SPA navigation and the Easy Apply modal
  // ===========================================================================
  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      ensurePanel();
      ensureModalButton();
    }, 300);
  });

  loadData().then(() => {
    ensurePanel();
    ensureModalButton();
    observer.observe(document.body, { childList: true, subtree: true });
  });
})();
