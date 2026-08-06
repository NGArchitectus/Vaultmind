# Archimind / Vaultmind — Session Handover Notes

> Read at the start of every session for technical context on tricky areas.

---

## Code quality pass (2026-06-03, complete)

XSS fix in PDF viewer, 82 error-leak routes standardised, duplicate CORS removed, Resend singleton, vault useMemo/useCallback, AI timeout named constants. See git log for details.

---

## Parked refactoring items

- **B3** Rate limiter — plain in-memory `Map`. 2026-06-23: added a 10-min eviction sweep (`_rateLimitSweep`, `.unref()`) so it can't grow unbounded; still resets on restart and isn't shared across instances (use `express-rate-limit`/Redis only if you scale to multiple instances).
- **B6** No PDF magic byte check on upload — add `if (buffer.slice(0,4).toString() !== "%PDF")` check after base64 decode.
- **C1** ✅ DONE (2026-06-23): `callClaude` renamed to `askGemini` across all 23 references (client only; the `/api/claude` route name is unchanged).
- **C4** `api()`/`apiBlob()` duplicate auth logic — extract shared `authorisedFetch()` base.
- **D1** App.js god component — PARTIAL (2026-06-24): App.js 2,195 → 1,817 lines. Extracted the **safe, separable** pieces: `VaultPdfViewer` → `components/VaultPdfViewer.jsx`; the Pass-3 prompt → `prompts.js` (`buildAnswerPrompt`); auth → `hooks/useAuth.js` (handleSignOut stayed — it resets app-wide state); citation page-resolution → `citations.js` (`findPageInVaultIndex`/`findPageByClauseNumber`, parametrized). **Deliberately NOT extracted:** the vault-management + indexing + `askQuestion` Q&A orchestration. They share `statusMsg`/`progress`/`stage` state, so they're one coupled subsystem — splitting into separate hooks would force two hooks to share `useState`. Left in App.js to protect the pipeline (Nathan's call). Prompt + citation changes were staging-tested (answers/citation pages unchanged). Build verified via `CI=false node node_modules/react-scripts/bin/react-scripts.js build`; hook/component cross-refs checked for `no-undef` (the build does NOT fail on an undefined-but-rendered component).
- **D2** ✅ DONE (2026-06-24): ProjectsSection.jsx (was ~3,985 lines) split into `client/src/components/projects/` — one file per component (`ProjectDetail`, tabs `DrawingsTab`/`DocumentsTab`/`ProductsTab`/`emails`/`TransmittalTab`/`PlaceholderTab`, `QABar`, plus leaf components `EditableField`/`ProjectCard`/`NewProjectForm`/`DrawingRow`/`PdfViewerModal`/`badges`) + shared `toast.js` (module-level dispatcher) and `projectHelpers.js`. `ProjectsSection.jsx` is now a ~110-line shell (project list + `ProjectDetail`). Verbatim moves; client build compiles green. ⚠️ `QABar` calls `askGemini` (project Q&A) — staging-test it. Verify component cross-references on any future split: the build does NOT flag an undefined-but-rendered component (caught one: `DrawingsTab` rendered `<TransmittalTab>` without importing it).
- **D3** ✅ DONE (2026-06-24): server/index.js (was ~6,100 lines) split into `routes/` (one router per domain), `middleware/` (auth, rateLimit), and `helpers/` (clients, email, r2, gemini, serverError, schedulers). `index.js` is now ~160 lines (app setup + `/api/claude` + router mounts + schedulers). All moves were verbatim — behaviour unchanged. The projects domain was further sub-split: `routes/projects.js` (core: CRUD, consultants, u-values, notes, todos, transmittals/revisions, categories, project-products) and **`routes/projectsAi.js`** (the Gemini/embedding sub-features: drawing content search, agreement extract/ask, email ingest/ask/search/reembed — **staging-test these when refining Projects**).
- **D4** Vaults not DB-backed — R2 ListObjects on every load. Future: add `vaults` Supabase table.

---

## Tricky technical areas

### mupdf — must not be removed
- `/api/extract-text` — mupdf structured text powers QA Pass 1. pdf-lib has no text extraction.
- `/api/extract-pages` — runs mupdf in `server/workers/extractPages.worker.js`. WASM abort kills only the worker; main process falls back to pdf-lib. Do not move out of the worker.

### answerPrompt — cannot be edited with Edit tool
Single very long line in `App.js`. Use a Python replacement script:
```python
with open("client/src/App.js", "r", encoding="utf-8") as f:
    content = f.read()
content = content.replace('OLD_ANCHOR', 'NEW_ANCHOR')
with open("client/src/App.js", "w", encoding="utf-8") as f:
    f.write(content)
```
Write the script to a `.py` file and run it — do not use `python -c` with double-quoted Bash strings (backslash escaping breaks).

### App.js vault section JSX
`{appSection === "vault" && <div>...`. Closing `}` must be on same line as `</div>`: `</div>}{/* comment */}`. Newline between them causes render bug.

### AnswerRenderer prop name
Use `text=` not `answer=`.

### Supabase RLS policy pattern
Always: `USING (true) WITH CHECK (true)`. Never: `WITH CHECK (auth.role() = 'authenticated')`.

### Route ordering in server/routes/*
Specific routes before wildcard `:id`/`*` routes. E.g. `/api/expenses/settings` before `/api/expenses/:id`.
**Express `*` matches ACROSS slashes** — a wildcard route like `DELETE /api/vaults/*` also matches `/api/vaults/X/pdfs/f.pdf`. Second latent instance of this class fixed 2026-07-20: vault file-delete always hit the wildcard vault-delete first (silently no-op'd pre-audit; honest 404 "Not found" after the 2026-06-24 audit guard) — fixed by registering `DELETE /api/vaults/*/pdfs/:filename` **before** `DELETE /api/vaults/*` in `routes/vaults.js` (guard kept as safety net). Registration order is checkable: `require("./routes/vaults").stack` layer order is match order.

### react-pdf v10 gotchas (PDFAnnotator.jsx)
- Worker must use `.mjs` extension
- `onRenderSuccess` has no `{ height }` — read from DOM: `pageWrapperRef.current.querySelector("canvas").offsetHeight`
- PDFs served as base64 through API (not presigned R2 URLs — CORS blocks direct R2 access)

### Resend lazy singleton
`getResend()` returns `null` if `RESEND_API_KEY` not set — `sendEmail()` skips silently. Both `RESEND_API_KEY` and `RESEND_FROM` are set on Railway (2026-06-12): production sends from `Archimind <noreply@archimind.co.uk>`, staging from `admin@archimind.co.uk`. Domain is verified in Resend — any `@archimind.co.uk` address works as the from. **Send-only**: no inbound mail is set up, replies bounce (Cloudflare email forwarding is the future option if needed).

### Custom domain + CORS (2026-06-12)
`archimind.co.uk` bought on Cloudflare (DNS lives there); bare domain 308-redirects to `www.archimind.co.uk`; Vercel production = `main` branch. Old `.vercel.app` URLs still work. **Any new frontend origin (e.g. a staging-branch preview URL) must be added to `corsOptions.origin` in `server/index.js`** — symptom of a missing origin: page loads and login works, but vaults/data silently fail to load. Cloudflare DNS records for Vercel must stay "DNS only" (grey cloud). Share links use `window.location.origin` so they follow whatever domain the user is on. Outstanding: Supabase Auth → URL Configuration may still point at the old vercel.app address (affects password-reset/confirmation email links only).

### Q&A pipeline robustness (2026-06-11, working — do not regress)
- **Pass 1 JSON parsing**: Gemini wraps long heading strings onto a second line (raw newline inside a JSON string literal = illegal). `sanitizeJsonControlChars` cleans inside-string control chars before parse; `salvageScoring` recovers truncated JSON by closing brackets. Both inside `askQuestion()`. Failure-only `[Scoring]` console.warn diagnostics — keep them.
- **General provisions** (chapter-matching, 2026-06-12): found server-side by the extract-pages worker (`scanGeneral: true` in the request body). It scans live document text for "General …" headings using font info (mupdf `toStructuredText().asJSON()` — a line counts only if **bold or ≥1.2× body text size**), and keeps hits in the **same chapter as a requested page**. Chapter detection: a page's chapter = the most common clause-number prefix printed on it ("3.36" → 3, "B1.2" → B1); pages with no clause numbers inherit — requested pages look back, heading pages look forward. Safety net: a requested page whose chapter yields no General section falls back to the nearest **preceding** General heading. Caps unchanged: +12 pages/doc, 15MB client byte budget. Returns `generalSections[{page,title}]`; client appends titles to PRIORITY SECTIONS in Pass 3 — without that, Gemini ignores the extra pages. **Do not reintroduce a page-distance cap** — the old ≤10-page rule failed both ways (ADM v1's M4(3) chapter spans 38 pages, so its General provisions sat 19 pages from the requested content and was dropped, while neighbouring chapters' sections leaked in). **Do not source general provisions from the vault index** — indexes built before the title@page dedupe fix collapsed duplicate heading titles; a collapsed index also stops Pass 1 requesting the right chapter's pages at all, which the worker scan cannot rescue — fix is re-indexing (Part M vault done 2026-06-12; others may still be stale).
- **Gemini hard limit**: ~20MB request. `400 INVALID_ARGUMENT` = payload too big; oversized payloads can also crash the Railway container (502, no CORS headers) or hang to timeout. `/api/claude` error log includes payload MB; client logs `[Pass3] Sending ~X MB` before the call. Pass 2 enforces a **15MB byte budget**: if extracted docs total more, every doc's page list is scaled down proportionally, dropping lowest-priority pages (Set insertion order = priority); general provisions pages survive because the server scan re-adds them on re-extraction.
- **Citation click → page resolution** (3 tiers in `handleCitationClick`): (1) `findPageByClauseNumber` — text-search the PDF for a line-anchored clause number (3.36, B1); paragraph numbers are unique per document so this beats heading matching (AD Part M has identical "General provisions" headings in M4(2) and M4(3)); doc text cached in `docTextCacheRef`. (2) `findPageInVaultIndex` — 4-level heading match, type-aware: Diagram/Table/Figure citations only match same-type index headings. (3) `citationPageMap` fallback.
- **NHBC wrong-page fix — clause-number density tie-break (2026-06-17)**: `findPageByClauseNumber` used to open the **first** page with a line starting with the clause number. NHBC chapters open with a **Figure Reference Table** that lists every figure's associated clause number; mupdf linearises that table cell-by-cell so each clause number lands at a **line start**, and that table sits *before* the real clause — so "first match wins" opened the reference table (e.g. 6.1.6.2 → p197 instead of p204; 6.1.17.3 → p197 instead of p229). Fix: among all line-start matches, pick the page with the **fewest clause-style numbers** (`/\d+(?:\.\d+){2,}/g` density) — the real clause page is sparse, the reference/contents table is dense; ties keep the earliest page (original behaviour). **Verified on real PDFs**: NHBC now opens the correct pages; **Approved Documents are unchanged** (Part M + Part B Vol 2, 592 clauses, 0 changes — AD has no dense clause tables so density is 0 throughout). Do not revert to `pages.find(...)`. Residual: the separate, accepted "clause cited on a cross-reference page" limitation still applies (sparse early page that merely mentions the clause).

### Roles & access (2026-06-12)
Three roles, stored in Supabase **`app_metadata.role`** (`user` | `admin` | `hr`) — **never `user_metadata`** (that's user-editable → privilege-escalation; migrated 2026-06-12). Server reads `req.user.app_metadata.role`; client reads `session.user.app_metadata.role`. Role is set only by admins via `/api/admin/users` (writes `app_metadata`). After a role change the user must **log out/in** to refresh the token.
- `requireAdmin` — admin only (expenses, fees, notification settings, mileage, quiz, user management, logo/colours).
- `requireTimesheetManager` — admin **or** hr. Applied ONLY to timesheet-review endpoints: `GET /api/admin/timesheets/submissions`, `GET/PATCH /api/admin/timesheets`, approve/reject/unlock, and `GET /api/admin/users` (read, for names). HR is hard-walled from everything else server-side; the client also hides Fee Review, the expenses tab and notification settings for HR (`isAdmin` vs `isHr`/`canReview` in `TimesheetsSection`).

### RLS — every table is server-only (2026-06-12)
All client data access goes through the server (service key, bypasses RLS); the browser uses Supabase **only for auth** (zero `supabase.from()` calls). So every public table has RLS **enabled with no permissive policy** = deny-all to the anon/authenticated browser key. The wide-open `USING(true)`/`"Auth access"` policies and RLS-off tables (incl. `projects`, `project_emails`, `staff_rates`) were locked down via SQL. **Do not add a permissive `USING(true)` policy** — if a feature ever needs direct browser table access, write a per-user policy (`auth.uid() = user_id`, like `quiz_stats`) instead.

### Timesheets — dates, overtime, notifications (2026-06-12)
- **BST date bug (fixed):** `isoDate()` must build `YYYY-MM-DD` from **local** date parts, never `toISOString()` (UTC shifts Mon→Sun in British Summer Time → server rejects as weekend / entries land a day early). Fixed in all 5 timesheet/expense client files. Don't reintroduce `toISOString().split("T")[0]` for entry dates.
- **Overtime:** `timesheets.overtime_hours` / `overtime_minutes` columns. **Tracked separately** — never added into the weekly total or the 37.5/45 warnings. Job (project) entries only; cleared when an entry becomes a category. Shown per-entry, as a weekly figure, in admin review, and in the report.
- **Notification settings:** 5 office-wide on/off toggles stored as JSON in `app_settings` (key `notification_settings`), missing keys default ON. `isNotificationEnabled(key)` gates each send. Events: timesheet_submitted/expense_submitted/unlock_requested → admins; expense_decided/timesheet_rejected → submitter (`getUserEmail`). Admin-only panel in `AdminPanel`.
- **Email hardening:** `escapeHtml()` wraps all user text in notification email HTML; expense POST + unlock-request are rate-limited. Receipt uploads: 10 MB cap, magic-byte type check (PDF/JPG/PNG/WEBP/HEIC), served as `attachment`.

---

### Admin section — tabs + notification routing (2026-06-13, live on main)
- `AdminSection.jsx` is **tabbed**: Users / Notifications / Quiz / Branding (logo+colours) / ArchiSync. Each group wrapped in `{adminTab === "x" && (<>…</>)}`; tab bar mirrors the TimesheetsSection tab style. Default tab: Users.
- **Notification routing**: the `NotificationSettings` UI **moved out of `TimesheetsSection.jsx`** into Admin's Notifications tab. Each of the 5 events now has **two toggles, Admin + HR** (was a single on/off). Server `notification_settings` (JSON in `app_settings`) changed shape `bool` → `{ admin, hr }`; `getNotificationSettings()`/`normaliseNotificationValue()` read old bool + new object (backward-compatible, **no SQL**). New helpers `getHrEmails()` and `notificationRecipients(key)`; all 5 send sites build recipients from the toggles.
- ⚠️ **Behaviour change**: `expense_decided` and `timesheet_rejected` used to email the *submitter*; they now email Admin/HR per the toggles and **default to OFF** — staff no longer get an automatic "expense approved / timesheet returned" email. Turn on in Admin → Notifications if wanted. Spec/plan: `docs/superpowers/*/2026-06-13-admin-tabs-notification-routing*`.

### Timesheets analytics & export (2026-06-13, live on main)
- Client-only. Shared helpers in `client/src/utils/reportExport.js` (`datePreset`, `endOfCurrentWeek`, `toCsv`, `downloadCsv`, `filterSummary`). PDF export = **browser print-to-PDF** via `client/src/printReport.css` (imported once in `index.js`): print shows only `.print-area`, hides `.no-print`, reveals `.print-only-header`.
- `TimesheetReport.jsx` (HR+admin): date presets, **default range now ends end-of-current-week** (was `isoDate(new Date())`, which hid the live week + time logged ahead), category + billable/non-billable filters, **Group-by** (week/project/person/category → drives primary chart via `fEntries`/`groupedData`), utilisation card, Export PDF + Download CSV.
- `FeeReview.jsx` (admin only): project/person/date filters (`filteredEntries`), Export PDF + CSV. Spec/plan: `docs/superpowers/*/2026-06-13-timesheets-analytics-export*`.

---

### Timesheet clarity + weekly reminder (2026-06-19, live on main)
- **Entry page (Option C):** `TimesheetsSection.jsx` header + `EntryRow` + `DraftRow` use two fixed **132px** column groups — "Time worked" and "Overtime" (amber `#8a6a3a` text, `#fbf3e6`/`#e3cfa6` boxes). Project rows show OT boxes; category/leave rows show a muted `n/a`; widths are identical across header/entry/draft so columns line up. **Presentational only** — overtime is still project-only and excluded from the weekly total.
- **Weekly reminder — pure logic:** `server/lib/timesheetReminder.js` (+ `node --test` suite `timesheetReminder.test.js`). A 15-min `setInterval` (`reminderTick`, just after `app.listen`) fires **once** on the configured UK day at/after the configured time, guarded by `app_settings` key `timesheet_reminder_state` (`last_sent_week` = the week's Monday) so restarts/ticks never double-send. UK time via `Intl` `Europe/London` (BST-safe).
- **Recipients:** non-admin/HR staff (`isRemindableRole`) with ≥1 outstanding week (status not `submitted`/`approved`) from the cut-off up to the current week. Cut-off = `app_settings` key `timesheet_reminder` `.track_from` (default `2026-07-01`), floored per user at their account-creation week. Per-week label: Draft / Not started.
- **Email:** built with the existing `notificationEmailHtml("Timesheets", …)` wrapper; toned-down (non-caps, unhighlighted) "please complete timesheets each week…" note; "Open Archimind" button → `PUBLIC_APP_URL` env (default `archimind.co.uk`).
- **Admin UI:** `TimesheetReminderSettings` in AdminSection → Notifications tab — enabled toggle, day (Mon–Fri), time (30-min steps), cut-off date, and a **"Send a test reminder to my email"** button. Endpoints (all `requireAdmin`): `GET/PUT /api/admin/timesheet-reminder` and `POST /api/admin/timesheet-reminder/test` (sends only to the requester and **bypasses the role filter** so an admin can preview against their own account).
- **Settings keys (no SQL):** `timesheet_reminder` `{enabled,day,time,track_from}` and `timesheet_reminder_state` `{last_sent_week}` in `app_settings`.
- **Limitations (accepted):** if the server is down for the **whole** configured day, that week is skipped (no catch-up). Note: with a future cut-off (e.g. default 1 Jul before July), the test/scheduler correctly find zero outstanding weeks — set the cut-off earlier to test the email now. Spec/plan: `docs/superpowers/*/2026-06-19-timesheet-clarity-and-reminder*`.

---

### Weekly HR timesheet report (2026-06-19, live on main)
- **What:** every week a PDF + Excel of everyone's logged hours is emailed to HR (`getHrEmails()`). Default **Monday 08:00 UK**, covering the **previous** week; day/time/coverage (previous/current) all configurable.
- **Pure logic:** `server/lib/timesheetReminder.js` gained `addWeeks(monday,n)`; `server/lib/hrReport.js` has `buildHrReportModel({entries,expected,statusByUser})` → `{people, byProject, totals}` (+ `round1`, `statusLabel`). Each `people[]` entry carries a **`projects[]`** per-person breakdown (`{label, hours, overtime}`, sorted by hours) — added 2026-06-19 so the report shows what each person worked on. Both `node --test`-covered (`hrReport.test.js`). **`expected`** = non-admin/HR staff (`isRemindableRole`) so zero-loggers show **0 / Not started**; anyone who logged hours is folded in regardless of role. Hours are decimals.
- **Renderers:** `server/lib/hrReportRender.js` — `renderReportPdf` (**pdfkit**, new dep, committed into `server/node_modules` per repo convention) and `renderReportExcel` (ExcelJS). PDF + Excel **Summary** "By person" list each person then **indented sub-rows per job** (`person.projects`); a practice-wide "Hours by project" table follows; Excel **Detail** sheet has every entry.
- **Orchestration (`index.js`):** `gatherHrReportData` → `runHrReport(onlyEmail?)` → `sendEmail` (now accepts an `attachments` passthrough to Resend). Second 15-min `setInterval` (`hrReportTick`, beside `reminderTick`) reuses `isReminderDue`; idempotent via `app_settings` key `hr_report_state` (`last_sent_week` = send-week Monday).
- **Settings keys (no SQL):** `hr_report` `{enabled,day,time,coverage}` (defaults Mon/08:00/previous) and `hr_report_state`.
- **Admin UI:** `HrReportSettings` in AdminSection → Notifications tab (third panel) — enabled, day, time, week-covered, and **"Send a test report to my email"** (`POST /api/admin/hr-report/test` → `runHrReport(req.user.email)`, sends only to the requester). Endpoints: `GET/PUT /api/admin/hr-report`.
- **`sendEmail` change:** signature now `{to,subject,html,text,attachments}`; existing callers (no attachments) unaffected. Spec/plan: `docs/superpowers/*/2026-06-19-weekly-hr-timesheet-report*`.

---

### Pre-launch timesheets/expenses batch (2026-06-23, live on main)

Specs/plans: `docs/superpowers/specs/2026-06-23-timesheets-expenses-prelaunch-tweaks-design.md`, `docs/superpowers/plans/2026-06-23-searchable-project-picker.md`, `…-expense-claims.md`.

- **Searchable project picker** — `client/src/components/ProjectPicker.jsx` replaces the old `<select>` everywhere projects are chosen (timesheet rows, expenses form, quick-fill). Type-to-search on job number + name; recently-used pinned top via `GET /api/timesheets/recent-projects` (pure helper `server/lib/recentProjects.js`). Categories moved to `client/src/categories.js` (now 11 labels incl. Maternity/Paternity/Compassionate/Medical/Unpaid/Unauthorised/Other), reached via an "Other" bar (pass `hideOther` for projects-only, as the expenses form does). Categories are **labels only** — no pay/allowance logic.
- **Per-row Full day / Half day** buttons on every entry row (`DayShortcut`) — set that row's time worked to 7h30 / 3h45. Presentational; the day-level quick-fill is unchanged.
- **Daily 7.5h cap (NEW INVARIANT — do not regress):** a single day's **time worked** (overtime EXCLUDED) must not exceed **7h 30m**. Client shows a per-day warning + **blocks the week's Submit**; server **rejects** an over-cap week in `POST /api/timesheets/submit`. Pure helper + tests: `server/lib/timesheetValidation.js` (`daysOverCap`). Excess belongs in Overtime.
- **Overtime now allowed on ALL rows (REVERSES the old "overtime is project-only" rule):** every entry row (project *and* category) has overtime fields; switching to a category no longer clears overtime. Overtime is still tracked separately and excluded from the daily cap and weekly total.
- **Expense claims (replaces one-at-a-time expenses):** new `expense_claims` table (RLS **deny-all**, server-only — never add a permissive policy); `project_expenses.claim_id` links line items. Lifecycle `draft → submitted → approved | rejected` (claim owns status; per-expense `status/reviewed_*` columns are now legacy/unused). Staff build a draft claim (`ExpensesTab.jsx`) and submit once; admin approves/rejects the **whole claim** (`AdminExpensesPanel`). Endpoints under `/api/expense-claims` (staff) and `/api/admin/expense-claims` (admin). On submit, admins get **one PDF** (summary + each receipt on its own page) via `server/lib/expenseClaimPdf.js` (pdf-lib; JPG/PNG embedded, PDF merged, **HEIC/WEBP attached separately**). Admin PDF at `GET /api/admin/expense-claims/:id/pdf`. All prior expense data was test data, cleared at migration.
- **Admin password generator (Option A — show once, never stored):** `server/lib/passwordGen.js` (two construction words + letter→digit swaps, all lowercase). `GET /api/admin/suggest-password` fills the new-user field; `POST /api/admin/users/:uid/password` resets an existing user and returns the new password once.
- **Cleanup/audit:** removed the dead `GET /api/expenses` (staff list), `GET /api/admin/expenses`, per-expense admin approve/reject + `notifyExpenseDecision` (superseded by claims). Added a periodic eviction sweep to the in-memory `rateLimitMap`. Audit confirmed every `/api` route is `requireAuth` except the intentional public `GET /api/shared-answers/:id`; client uses Supabase for auth only (RLS lockdown intact); no hardcoded secrets.

---

### Admin Review — week grouping + manual reminder button (2026-07-10, live on main)

- **UI (`AdminPanel` in `TimesheetsSection.jsx`):** the timesheets review list is grouped under one collapsible bar per week, newest first, covering every week from the reminder cut-off (`timesheet_reminder.track_from`) to the current week — including weeks with no rows at all. Header shows the week range, an IN PROGRESS tag on the current week, and a tally badge ("X of Y submitted", green when complete, red otherwise). Weeks containing anything awaiting action (status `submitted` or `unlock_requested`) auto-open on load (one-shot via `openInitRef`); person rows inside a week are unchanged (expand/approve/reject/unlock as before — the per-row week string was dropped as redundant). Weeks older than the cut-off render from submissions alone, with no tally/strip (history only). Date filters hide whole week groups; the staff filter narrows rows but **tallies/strips stay office-wide** by design.
- **"Not submitted" strip:** when a tracked week has missing staff, a red strip under the rows names them (drafts count as not submitted — they appear as a DRAFT row *and* a chip) with a **Send reminder to N staff** button. First click flips to an inline confirm ("Confirm — email N staff"); no sent-state is tracked, so clicking twice sends twice — the confirm step is the guard. Available to admin **and** HR. The button is **hidden on the in-progress week** (names still shown) — see the prior-weeks-only rule below.
- **Prior-weeks-only rule (2026-07-13 — do not regress):** failure-to-complete reminder emails only ever list weeks **strictly before the current week** — `chaseableWeeks` in `lib/timesheetReminder.js` (node --test covered) caps enumeration at `addWeeks(currentWeekMonday, -1)`; `computeReminderRecipients` uses it, so the Friday/any-day scheduler, the admin test-send, and the manual button all follow it. Rationale: with the auto-reminder moved to Monday, the old "up to and including the current week" rule (fine for the original Fri-16:00 design) chased people for the week that had just started. Consequence to remember: a **Friday**-configured reminder no longer nudges for the week ending that day — it becomes chaseable the following Monday. Display logic (`buildWeekStatus` tallies, IN PROGRESS strip, `firstOutstandingWeek` page-opening) deliberately still includes the current week — the rule is for emails only.
- **Server (`routes/timesheets.js`):** two new routes, both `requireTimesheetManager`:
  - `GET /api/admin/timesheets/outstanding` → `{ currentWeek, trackFrom, weeks: [{ week, expected, outstanding: [{id, name, label}] }] }`, newest first. Built by `buildWeekStatus` in `lib/timesheetReminder.js` (node --test covered): expected = non-admin/HR staff, floored at their account-creation week — **the same rules as the reminder emails**, so the tally, the chips, and the button's recipients can never disagree. Client degrades gracefully if this call fails (weeks render from submissions, no tallies).
  - `POST /api/admin/timesheets/remind` `{week}` (rate-limited 5/min) → filters `computeReminderRecipients` output through `filterRecipientsToWeek` and sends via the shared loop. Each recipient gets the existing branded email listing **all** their outstanding weeks, not just the clicked one. Works regardless of the Friday auto-reminder's enabled toggle (that gates the scheduler only).
- **Refactor note:** the email-send loop was extracted from `runTimesheetReminders` into `sendReminderEmails(recipients)` (`helpers/schedulers.js`); `runTimesheetReminders` now composes it and the Friday scheduler path is behaviour-identical.
- **Caution:** staging shares the production DB and real staff emails — the remind button on staging emails real people. No SQL. Spec discussion was verbal (visual-companion brainstorm); no spec doc by Nathan's choice.

---

## Outstanding issues (as of 2026-06-19)

1. **Clause-number citation can hit a cross-reference** (LOW, accepted) — `findPageByClauseNumber` opens the first page where a line starts with the clause number; occasionally a cross-reference/table entry. Future fix: prefer match followed by sentence text, or nearest the section's vault-index heading.
2. **Multi-clause blocks not combining** (LOW) — same-subject clauses across sections stay separate citation blocks.
3. **Wide table extraction** (KNOWN LIMITATION) — mupdf linearises text, loses column structure.
4. **Email work** (PARKED) — summaries not stored in DB; relevance threshold (0.35) needs tuning.
5. **Timesheets follow-up** (deferred) — the unlock-*granted* email still isn't sent (only the 5 routed events).
6. **Vault Q&A misses definitions on appendix pages** (TO INVESTIGATE, flagged 2026-06-24) — a definition lookup returned no answer when the term is defined on an **appendix page** of the document. Likely a coverage gap: appendix pages/headings may not be surfaced by the Pass-1 heading index, not pulled into Pass-2 page extraction, or not indexed at all. Pipeline-sensitive — diagnose **evidence-first on the real document** (reproduce extraction with the repo's mupdf, per `reference_mupdf_local_diagnostics`), confirm root cause before any change, and **staging-test before main**.

_Closed 2026-06-19: PDF Compare (Revit schedule test passed) and stale Approved-Doc vault re-indexing — both previously items 1 & 3._

---

## Launch readiness review backlog (flagged 2026-06-25, review post-launch)

Raised in a pre-launch security/business review. Nathan chose to **defer these and review later** — none block the initial internal launch. Grouped by lens.

**Security / operational**
1. **Public share endpoint `id` type** — confirm `shared_answers.id` in Supabase is a `uuid` (unguessable), not a sequential integer. The public `GET /api/shared-answers/:id` (no auth) returns only `question`/`answer`/`vault_name` and 404s unless a future `expires_at` is set, so exposure is bounded — but a sequential id would let logged-out users enumerate non-expired shares. Also confirm the `expires_at` DB default (the insert never sets it). UUID = proper fix.
2. **AI spend cap** — `/api/claude` is per-user rate-limited (20/min) and model-allowlisted, but rate limits cap *burst*, not *monthly spend*. Set a **Google Cloud billing budget + alert** (and a Railway usage alert) on the `GEMINI_API_KEY` project. Optionally audit rate-limit coverage on the secondary Gemini routes (`projectsAi` drawing/agreement/email, `quiz`, `schedule`) — all login-gated, mixed limits.
3. **Single-instance assumptions** — the in-memory rate limiter and the in-server reminder/HR-report schedulers assume one Railway instance. Keep Railway pinned to a single instance, or move to a shared store (Redis/DB) before scaling out.
4. **PDF upload magic-byte check (B6, still open)** — vault PDF uploads lack a `%PDF` header check.
5. **`npm audit`** on client + server (note: server commits `node_modules`).
6. **Monitoring** — no error tracking/uptime alerting; a Railway crash (502 / missing CORS) is currently noticed only via user complaint. Consider Sentry + an uptime check.

**Config to confirm (dashboards)**
7. **Supabase Auth → URL Configuration** — Site URL + redirect allow-list must be `archimind.co.uk`, not an old `*.vercel.app`, or password-reset / email-confirmation links break.
8. **Backups** — Supabase is on the **free tier → backups unavailable** (Nathan, 2026-06-25); enable daily backups / PITR **if/when upgraded to Pro** (timesheets/expenses are payroll-adjacent). **R2 holds nothing important yet** (Nathan) — revisit versioning / lifecycle rules when real client PDFs live there.

**Business / legal (needs a specialist, not code)**
9. **Confidentiality → Google Gemini** — Q&A *and* embeddings send document text to the **AI Studio developer API** (`generativelanguage.googleapis.com`, `x-goog-api-key`). On that API, *free tier* content may be used for product improvement and human-reviewed; *paid tier* = no training, limited retention. **Confirm the `GEMINI_API_KEY` project has billing enabled (paid tier).** For the strongest confidential posture (DPA, contractual no-training, data residency) consider **Vertex AI** (`aiplatform.googleapis.com`). Note: RAG is *not* a privacy mechanism — retrieved page text is transmitted to Google on every question.
10. **UK GDPR** — holding staff personal data (timesheets/expenses/emails) + client-confidential project material; needs a privacy notice, lawful basis, retention policy, and documented sub-processors (Supabase / Railway / Cloudflare / Google / Resend).
11. **Professional liability** — the AI gives building-regs guidance with known limits (cross-reference citation pages, wide-table extraction, etc.); add a visible "assistant — verify against the source" disclaimer, and check PI insurance + content licensing (e.g. NHBC standards).

---

## Planned features (spec'd, not yet built)

- **Timesheets — "Unpriced Extra" works tracking** (spec 2026-06-30): a tickbox on **project** timesheet lines marking work not covered by the current fee, **categorised** via a per-project, grow-on-the-fly list of "extra-types" (+ optional note). Counts as normal worked time (tag only — no cap/total/pay change). Tracked in **Fee Review**, per project, grouped by extra-type, in the PDF/CSV export. New table `project_extra_types` + `timesheets.unpriced_extra`/`extra_type_id` columns; submit blocked if an extra line has no type. Full build-ready detail (data model, endpoints with file:line refs, UI, validation, SQL run-order, staging tests): **`docs/superpowers/specs/2026-06-30-timesheet-unpriced-extras-design.md`**. Run the SQL first, then deploy server (Railway) + client (Vercel).
