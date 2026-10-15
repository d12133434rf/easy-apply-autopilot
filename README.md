# Easy Apply Autopilot

Chrome extension (Manifest V3) that applies to LinkedIn Easy Apply jobs automatically, using your saved profile and a reusable answer bank.

> ⚠️ Automating applications violates LinkedIn's User Agreement and can get your account restricted. The extension ships in **dry-run mode**. Keep it there until you've checked its answers, and keep the daily cap low.

## How it works

1. Fill out your profile in the extension popup.
2. Run a LinkedIn job search (tip: turn on the "Easy Apply" filter) and click **Start auto-apply** in the panel at the bottom right.
3. For each job card it:
   - skips jobs that aren't Easy Apply or that you've already applied to
   - opens the job and clicks Easy Apply
   - fills every step from your profile and answer bank, then clicks Next → Review → Submit
   - unchecks "Follow company" (configurable)
   - logs the application (title, company, URL, date)
   - waits `delaySeconds`, then moves on to the next card and the next page
4. **It never guesses.** If a required question has no answer, it discards that application and puts the question under **Answers** in the popup. Answer it once and it's reused from then on.
5. It stops when you click Stop, when it hits your daily cap, when the results run out, or when LinkedIn shows its own daily Easy Apply limit.

Manual mode: open any Easy Apply modal yourself and click **⚡ Autofill**. It fills the current step and keeps filling each new step until the modal closes.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest |
| `content.js` | Modal detection, form filling, auto-apply loop, on-page panel. **All LinkedIn selectors and text patterns are in the `CONFIG` block at the top.** |
| `background.js` | Supabase auth, profile/answer sync, application logging, free-tier gating |
| `popup.html/js` | Profile, answer bank, settings, account |
| `supabase/migrations/0001_init.sql` | Schema, RLS, signup trigger, tracker limit enforced in the database |
| `test/` | End-to-end test: a mock LinkedIn page built with React (controlled inputs) |

## Setup

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. Optional cloud sync: create a Supabase project, run `supabase/migrations/0001_init.sql`, then set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `background.js`. With those left blank, the extension runs in local-only mode.

## How answers are chosen (in order)

1. **Answer bank**: an exact match on the normalized question label (you add these from the Answers tab).
2. **Skill years**: "How many years of experience with X?" → `skills` in your profile (`Python: 5`). Unknown skills use "Default years" if you set it; otherwise the question is asked.
3. **Profile rules** (`CONFIG.fieldRules`): name, email, phone, location, work authorization, sponsorship, salary, education, and so on.

Fields LinkedIn pre-fills (contact info) are left alone.

## Resume and cover letter

Add them under **Profile → Documents** in the popup (PDF, DOC or DOCX, up to 2 MB). They're stored only in this browser.
- **Resume:** if LinkedIn already has one of your resumes selected, it's kept. Otherwise yours is uploaded. If a job requires a resume and you haven't added one, the job is skipped and flagged in the Answers tab.
- **Cover letter:** uploaded whenever the job has a cover-letter upload field. If a job asks for a typed cover letter instead, the text from your profile is used.

## When LinkedIn changes its UI

Edit `CONFIG` in `content.js`. Fields are matched by **label text** rather than generated IDs, so most changes only affect `CONFIG.selectors` (modal, job cards, buttons). Run `cd test && npm install && npm test` to check the logic still works. The mock page only reflects LinkedIn's DOM as of this writing, so also verify on the real site in dry-run mode.

## Monetization

- Free plan: syncs up to 10 applications to the cloud tracker. This is enforced by a Postgres trigger, so editing the extension can't bypass it. Users can read `subscription_status` but can't write it.
- Pro: unlimited tracker. `TODO(stripe)` markers show where Checkout and the webhook go. The webhook needs a server (Railway or a Supabase Edge Function). Nothing else needs a backend yet.
