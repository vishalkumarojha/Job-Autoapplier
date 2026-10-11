# Job Outreach on Vercel

## Phase 10 reminders

`POST /api/reminders/run` is a server-only daily sweep configured in `vercel.json` for
09:00 UTC. Vercel Cron must send `Authorization: Bearer $CRON_SECRET`; configure a long,
random `CRON_SECRET` in the Vercel project environment. The route uses Firebase Admin
credentials already used by authenticated endpoints. It skips archived and legacy jobs,
creates deterministic per-user Firestore reminder event claims, and delivers deadline
reminders in the 24 hours before `deadline` and follow-up reminders when `nextReminderAt`
is due for an application with sent-mail lifecycle evidence. It also reports application
status transitions detected between scheduler runs (the first run seeds state only).
It reports follow-up-sent transitions when those lifecycle fields are present in the
canonical Firestore Job; it does not poll the Sheet or invoke its immediate-send trigger.
`nextReminderAt` remains the
canonical follow-up reminder date; the Sheet's `FOLLOW UP TRIGGER` remains an immediate
send trigger and is never invoked by this reminder code.

`POST /api/push/register` requires a Firebase ID token and accepts only `{ token, platform }`.
It derives the user id from the verified token and upserts under `users/{uid}/pushTokens`.
The scheduled sender uses Expo's push service. Optional Telegram delivery requires both
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, and `TELEGRAM_USER_UID`; all three are required
together so a shared deployment cannot send another account's reminders to the configured
chat. These values are server-only. Automated tests inject
fake transports and do not contact Expo, Telegram, Gmail, or Apps Script. A deterministic
event claim is retained after an uncertain delivery outcome to prevent a retry from
duplicating a message; inspect the Firestore event's status during operational recovery.

The cron schedule is deployment configuration only; no live Vercel schedule or provider
delivery has been verified by local tests.

This phone-friendly interface uses the user's existing Google Sheet and Apps Script mailer.

1. In your Apps Script project, replace the code with `apps-script/Code.gs` and add the two HTML files `apps-script/Email.html` and `apps-script/FollowUp.html`. The dashboard bridge (`doGet`/`doPost`) is already merged into Code.gs — do not add a separate file, Apps Script rejects projects where a function is defined twice.
2. In Apps Script Project Settings, create the Script Property `DASHBOARD_API_TOKEN` with a long random secret.
3. Deploy that Apps Script project as a Web app: Execute as *Me*, access *Anyone* (not "Anyone with Google account"), and authorize the Gmail/Sheets scopes. Copy the deployed URL ending in `/exec`.
4. No need to re-enter anything: paste both values once into `.env` (copy `.env.example`). The API also reads Vercel Environment Variables if you prefer them.
5. Redeploy and open the Vercel URL on the phone.

## If you see "Apps Script returned HTTP 401"

The backend reached Apps Script, but Apps Script refused the request. This is
almost always one of these, in this order:

1. The URL still points to an old deployment. Every Apps Script re-deploy
   creates a **new** `/exec` URL, and old URLs keep serving old code. After
   saving the merged `Code.gs`, create a fresh deployment and paste its new URL into
   `.env`.
2. Access is not `Anyone`. Deploy > New deployment > Web app > Who has access
   MUST be `Anyone` (not "Anyone with Google account"). Authorize the Gmail /
   Sheets scopes during deployment, otherwise calls from the server get 401.
3. Workspace account restriction. If the Apps Script project lives on a Google
   Workspace account, the domain admin may block public access so "Anyone"
   silently degrades to 401. Use a personal Gmail account for the script.

Verify quickly: open the `/exec` URL in an incognito window. It should show
`{"ok":true,"service":"Job Outreach API"}`. A Google sign-in page or an
"Unauthorized" message means the access level is wrong.

The browser never receives the Apps Script URL or the secret. The original Email.html, FollowUp.html, Gmail quota guard, statuses, thread IDs, and sending functions remain unchanged.

`POST /api/send` also uses `APPS_SCRIPT_URL` and `APPS_SCRIPT_TOKEN` on the server only. It authenticates the caller with a Firebase ID token and uses the existing Apps Script `send` action, then checks the existing `jobs` action for a matching `Sent` row before recording Firestore lifecycle fields. Keep these variables in Vercel/server `.env` configuration; do not add them to the mobile app.

For authenticated Phase 9 sends, Vercel resolves the canonical Job's `selectedResumeId` against the private Resume Library cache and adds its `driveFileId`, along with the Job's canonical `approvedSubject` and `approvedMessage`, to the existing `send` action data. Apps Script sends the exact approved subject/body and attaches that resolved file. If an approved file is missing or unavailable, the send fails closed; it does not fall back to the global resume. Older dashboard requests without approved fields continue through the existing Email.html template and configured `RESUME_FILE_ID`. Both paths retain the same quota, duplicate, status, and thread handling. The Drive ID stays server-side and is not included in the mobile resume response.

Vercel environment variables are configured once per Vercel project; they are
not entered every time a job is added. After changing either variable, redeploy
the project. To check Apps Script access before Vercel, open the `/exec` URL in
an incognito window after deploying the current bridge: it should return a
small JSON status object.

---

## `GET /api/resumes` (Resume Library)

Authenticated read-only listing of the user's resumes, used by the mobile app's Resume
Library screen. It does not touch Gmail, `api/rpc.js`, `apps-script/Code.gs`, or `Sheet1`.

**Authentication.** Send `Authorization: Bearer <Firebase ID token>`. The token is verified
with `firebase-admin` *before* any other configuration is read; a missing or invalid token
returns `401 {"error":"..."}`. The `uid` used to read the sheet comes only from the verified
token — it is never taken from a query parameter, body, or header. The token itself is never
logged.

**Source of truth.** Resumes are the PDFs in a Google Drive folder. A dedicated Sheet tab
(`Resumes` by default) is the index/cache, including `extractedText`, so future features can
read text without re-parsing the PDFs. Rows are joined by `resumeId = rsv_ + sha256(driveFileId)`
— stable, and not the raw Drive id.

**Response.**

```json
{ "schemaVersion": 1, "resumes": [ { "resumeId": "rsv_…", "resumeLabel": "…", "targetRole": "…",
  "targetRoleFamily": "backend", "version": 3, "isDefault": true, "keywords": ["go"],
  "updatedAt": "2026-02-01T09:00:00.000Z", "lastUsedAt": null } ], "skipped": { "missingText": 0 } }
```

Server-only fields (`driveFileId`, `driveFileName`, `extractedText`, `contentHash`) are never
returned.

**Environment variables.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | service-account JSON (inline or file path); alternatively set `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY` |
| `GOOGLE_RESUME_FOLDER_ID` | yes | Drive folder whose PDFs are the resume list |
| `GOOGLE_RESUME_SHEET_ID` | yes | spreadsheet that holds the `Resumes` cache tab |
| `GOOGLE_RESUME_SHEET_TAB` | no | defaults to `Resumes` |

None of these are committed; `.env` is git-ignored and `.env.example` lists names only. The
sheet id is not auto-discovered — nothing in this repo can identify the spreadsheet.

**Populating the cache.**

```bash
npm run sync:resumes          # dry run: what would be added/updated/skipped
npm run sync:resumes:write    # actually write the sheet
npm test                      # 426 node:test cases, hermetic (no Google or Anthropic access)
```

**Status codes.** `401` unauthenticated, `404` when the resume route is not configured,
`405` non-GET, `500` upstream failure. Every error body is `{"error":"..."}` and nothing
else — the upstream message is logged server-side and never returned.

---

## `POST /api/intake` (Smart Intake)

Authenticated extraction of structured fields from raw job-posting text. The mobile app
pastes or shares a posting, sends it here, and the human reviews the result before anything
is saved. This endpoint does not send email, does not touch Gmail or Apps Script, and does
not select, score, or improve a resume.

**Request.**

```json
{ "rawText": "Senior Backend Engineer — Example Corp …", "source": "linkedin" }
```

`source` is the capture channel, one of `paste`, `share_android`, `manual`, `email`,
`linkedin`, `x`, `referral`, `other`. It is chosen by the caller and never by the model.
`rawText` must be non-empty and at most 20,000 characters; longer input is rejected rather
than truncated.

**Authentication.** Same contract as `GET /api/resumes`: `Authorization: Bearer <Firebase
ID token>`, verified before the body is read and before any configuration is loaded, so an
anonymous probe cannot discover whether the feature is configured.

**Response.**

```json
{ "schemaVersion": 1, "source": "linkedin", "company": "Example Corp",
  "contactName": "Priya Sharma", "contactEmail": "priya.sharma@example.com",
  "role": "Senior Backend Engineer", "jobUrl": "https://example.com/jobs/backend-42",
  "location": "Bangalore / Remote", "notes": "Visa sponsorship available.",
  "deadline": "2026-10-12T00:00:00.000Z",
  "fieldConfidence": { "company": 0.98, "contactName": 0.72, "contactEmail": 0.93,
    "role": 0.99, "jobUrl": 0.98, "location": 0.81, "deadline": 0.88 } }
```

The raw text is not echoed back. Every key not listed here is stripped.

**What the server checks before returning.** Confidence values must be finite and in
`[0,1]` — out-of-range values are rejected, not clamped. Deadlines must be real ISO-8601
dates ("tomorrow", "ASAP", "31 Feb" are rejected, not guessed). `contactEmail` and `jobUrl`
must literally appear in the supplied text; a value that cannot be traced back is dropped to
`null` with confidence `0`. Any field that is `null` carries confidence `0`.

**Environment variables.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key; server-side only |
| `ANTHROPIC_MODEL` | no | defaults to `claude-sonnet-5` |

Plus the Firebase Admin credentials listed above (verified caller identity). The model key
is never sent to a client, never logged, and never stored outside this server.

**Status codes.** `400` the request itself is wrong (empty text, unknown source, too long,
malformed JSON) with a message describing only the caller's own input; `401` unauthenticated;
`404` the endpoint is not configured; `405` non-POST; `500` a fixed
`{"error":"Unable to process job posting"}`. Model output and provider error messages are
logged server-side and never returned, because both can quote the posting.

---

## `POST /api/match` (Resume Matching)

Authenticated scoring of every resume in the library against one confirmed job. The mobile
app calls it from the job detail sheet; the server reads the job, reads the Resume Library,
asks Claude which resume fits best, and persists **only** the selection and the score on that
caller's own job document. It does not approve, send, draft, edit, or improve anything, and
it does not touch Gmail, `api/rpc.js`, `apps-script/Code.gs`, `Sheet1`, or the mobile app's
approval or application status.

**Request.**

```json
{ "jobId": "job-1" }
```

`jobId` must match `^[A-Za-z0-9_-]{1,128}$`; anything else is a `400`. Every other key in the
body — including `uid`, `selectedResumeId`, `matchScore`, and any resume text — is **ignored,
not rejected**. Identity comes from the verified token alone, and the caller never gets to
choose the result.

**Authentication and authorization.** Same contract as the other routes:
`Authorization: Bearer <Firebase ID token>`, verified before the body is read and before any
configuration is loaded. The document path is `users/{verifiedUid}/jobs/{jobId}`; a job that
does not exist, belongs to somebody else, or is a legacy unversioned tracker document all
return the same `404 {"error":"Job not found."}` so a caller cannot probe for ids. A job whose
`intakeStatus` is not `confirmed` returns `409`.

**Candidate selection.** The library is sent in full up to `MATCH_MAX_CANDIDATES` (15).
Rows with no usable `resumeId` or `resumeLabel` are skipped by the cache parser, and rows with
no `extractedText` are excluded as unusable. Only when more than 15 usable resumes exist does
a pre-filter rank them by overlap with the posting (plus a small metadata boost) and keep the
top 15. That pre-filter is a *budget*, not a ranking: the model still decides the order.

**Prompt.** `MATCH_SYSTEM_PROMPT` (in `lib/match.js`) sets 12 rules and marks `<job>`,
`<posting>`, `<candidate>`, `<resume_text>`, `<label>`, `<target_role>`, and `<keywords>` as
untrusted data rather than instructions. It explicitly forbids writing email, editing or
improving a resume, and deciding whether to apply, and asks for exactly one bare JSON object.
Attribute fields are stripped of `<`, `>`, and newlines so a resume label cannot forge a
candidate boundary, and free text is truncated rather than stripped. Drive ids and Drive file
names never enter the prompt.

**Response.**

```json
{ "schemaVersion": 1, "jobId": "job-1", "selectedResumeId": "rsv_alpha", "matchScore": 91,
  "matchBreakdown": [ { "criterion": "must_have", "score": 94, "weight": 0.35,
      "rationale": "Production Go and PostgreSQL work covers every requirement." } ],
  "rankings": [ { "resumeId": "rsv_alpha", "score": 91 }, { "resumeId": "rsv_beta", "score": 82 } ] }
```

`matchBreakdown` always carries the five criteria in order — `must_have`, `nice_to_have`,
`seniority`, `role_alignment`, `technology_alignment` — with server-decided weights summing
to 1. `rationales` from the model are attached per criterion and capped at 240 characters;
a blank rationale becomes `null`. Every value is an integer `0..100`.

**What the server checks before returning.** Nothing is clamped, coerced, or defaulted. An
out-of-range score, a non-integer score, an unknown or duplicate `resumeId`, an empty
`rankings` list, a `selectedResumeId` absent from `rankings`, a selected score that is not the
maximum, a `matchScore` that disagrees with the selected ranking score, or a response that is
not one bare JSON object all produce the same fixed
`500 {"error":"Unable to compute a resume match."}` with **no** write. Rankings are presented
descending — presentation only; the scores are not touched.

**Persistence.** One `update()` carrying exactly `selectedResumeId`, `matchScore`, and
`matchBreakdown`. Approval status, application status, the draft, `resumeSuggestions`,
`dedupeKey`, `updatedAt`, and every sheet/Gmail field are left byte-for-byte unchanged;
re-running the match rewrites only those three fields. `rankings` are returned to the caller
and never persisted, and resume text, `extractedText`, and Drive metadata are never in the
response.

**Environment variables.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key; server-side only |
| `ANTHROPIC_MODEL` | no | defaults to `claude-sonnet-5` (shared with Smart Intake) |

Plus the Firebase Admin credentials and `GOOGLE_RESUME_SHEET_ID` listed above. There is no
separate matching credential: matching reuses the one Anthropic transport (`lib/claude.js`)
and the one Resume Library cache.

**Status codes.** `400` the request itself is wrong (missing or malformed `jobId`, malformed
JSON); `401` unauthenticated; `404` the job is missing, not yours, or legacy, or the endpoint
is not configured; `405` non-POST with an `Allow: POST` header; `409` the job is unconfirmed
or there are no usable resumes to match against; `500` with one of four fixed messages —
`Unable to load this job.`, `The resume library is temporarily unavailable.`,
`Unable to compute a resume match.`, `Unable to save the resume match.` — plus
`Could not verify credentials.` when token verification itself fails. Model output, provider
errors, document paths, and sheet ids are logged server-side and never returned.

**Tests.**

```bash
npm test    # 426 node:test cases, hermetic (no Firebase, no Google, no Anthropic)
```

Matching is covered by `test/match.test.js` (contract, request parsing, candidate selection,
prompt construction, provider boundary, model-output validation) and `test/match-api.test.js`
(authentication, uid isolation, job authorization, configuration, persistence shape, and the
no-leak guarantees).

## `POST /api/suggestions` (Resume Improvement Suggestions)

Authenticated generation of up to four evidence-based suggestions for improving **the
already-selected resume** against **one already-confirmed job**. The mobile app calls it from
the same job detail sheet; the server reads the job's existing match, reads the selected
resume out of the Resume Library, asks Claude what would strengthen it, validates every claim
back against the two source texts, and persists **only** `resumeSuggestions` on that caller's
own job document.

It does not re-match, does not edit a resume, does not approve, send, or draft, and it does
not touch Gmail, `api/rpc.js`, `apps-script/Code.gs`, `Sheet1`, or the mobile app's approval
or application status.

**Request.**

```json
{ "jobId": "job-1" }
```

`jobId` must match `^[A-Za-z0-9_-]{1,128}$`; anything else is a `400`. Every other key in the
body — including `uid`, `resumeId`, and any resume text — is **ignored, not rejected**.
Identity comes from the verified token alone, and the material being judged is loaded
server-side, so a caller cannot supply the advice they receive.

**Authentication and authorization.** Same contract as the other routes:
`Authorization: Bearer <Firebase ID token>`, verified before the body is read and before any
configuration is loaded. The document path is `users/{verifiedUid}/jobs/{jobId}`; a job that
does not exist, belongs to somebody else, or is a legacy unversioned tracker document all
return the same `404 {"error":"Job not found."}`.

**Preconditions.** Suggestions are *derived* from an existing match, so all three must hold,
and none of them is repaired:

| State | Response |
| --- | --- |
| `intakeStatus` is not `confirmed` | `409 This job must be confirmed before suggestions can be generated.` |
| `selectedResumeId` is null | `409 This job has no selected resume. Run a match first.` |
| `matchBreakdown` is null or empty | `409 This job has no match breakdown. Run a match first.` |
| the selected id is absent from the library, or its text is empty | `409 The selected resume is no longer available in the resume library.` |

There is no fallback: the endpoint never falls back to an earlier resume and never runs a
match on the side, because either would answer a different question than the one that was
asked. An empty library is therefore a `409`, not a silent re-selection.

**Prompt.** `SUGGESTION_SYSTEM_PROMPT` (in `lib/suggestions.js`) sets 12 rules and marks
`<job>`, `<posting>`, `<match>`, `<resume>`, `<resume_text>`, and `<label>` as untrusted data
rather than instructions. It forbids inventing skills, experience, metrics, employers,
projects, dates, certifications, education, and years of experience; states that a requirement
the resume does not meet is a gap rather than permission to claim it; asks for exactly one
bare JSON object; and requests no reasoning or chain of thought. Only `resumeId`,
`resumeLabel`, `targetRole`, and `keywords` are named — all four are already public through
`GET /api/resumes`. The Drive file id, the Drive file name, and `extractedText` as a field
never enter the prompt.

**Response.**

```json
{ "schemaVersion": 1, "jobId": "job-1",
  "suggestions": [ { "id": "sug_001", "priority": "high", "category": "skill_emphasis",
    "actionType": "reorder_or_emphasize", "title": "Highlight PostgreSQL work",
    "suggestion": "Move the existing PostgreSQL bullet higher.",
    "jobEvidence": "PostgreSQL is a listed technology.",
    "resumeEvidence": "The resume already demonstrates PostgreSQL in a project." } ] }
```

`priority` is one of `high`, `medium`, `low`; `category` is one of `skill_gap`,
`skill_emphasis`, `experience_alignment`, `project_alignment`, `keyword_coverage`,
`achievement_quantification`, `section_order`, `technology_alignment`; `actionType` is one of
`reorder_or_emphasize`, `add_existing_evidence`, `rewrite_existing_bullet`,
`quantify_existing_result`, `clarify_existing_experience`. Every action type acts on material
the resume already contains — there is no value meaning "claim something new", because such a
value would make fabrication a well-formed request. An empty `suggestions` array is a valid
answer and is stored as `{schemaVersion: 1, suggestions: []}`, distinct from `null`, which
means nobody has asked yet.

**Fabrication safeguards.** Each field of each suggestion is checked back against the source
it cites before anything is written, and a trip is a `500` with no write:

1. *Numeric grounding* — every digit must appear in the source (or be spelled there in words),
   and every spelled-out number next to a measuring unit must appear in the source (or be
   written there as digits). This is what stops an invented `40%` or an invented `3 years`.
2. *Proper-noun grounding* — a capitalised term the source does not contain is a name nobody
   wrote down: an employer, a product, a school. Sentence-initial capitals are checked in the
   two evidence fields and trusted in `title` and `suggestion`, where an ordinary opener would
   otherwise block nearly every legitimate answer.
3. *Credential grounding* — a credential is not a paraphrase opportunity. `resumeEvidence` may
   cite one only if the resume holds it; `title` and `suggestion` may also name one the
   posting states, which is how a gap gets described; `jobEvidence` is exempt because it
   describes the job by design. Only morphology bridges (`certification` ⇄ `Certified`), never
   the substance: a B.Tech does not satisfy a Master's.
4. *"Add a missing term"* — after an instruction verb, a notable token the posting has and the
   resume does not is refused. That is the exact shape of "the job wants Kubernetes, so add
   Kubernetes", which reads as advice and is really an instruction to fabricate.
5. *Vocabulary* — `priority`, `category`, and `actionType` must be members of their own
   controlled list.

**Validation.** Nothing is repaired. A suggestion missing any of its eight fields, carrying a
ninth, using an unknown enum value, with a duplicate or malformed `id`, with an empty field,
or over a length ceiling is a rejection, not a default. A `schemaVersion` the model chooses
that disagrees with the server's is a rejection too; an absent one is filled in. The guard
reason is logged as `[suggestions] fabrication guard: <rule>` and never returned, because it
quotes resume bodies.

**Persistence.** One `update()` carrying exactly `resumeSuggestions`. `company`, `role`,
`matchScore`, `matchBreakdown`, `selectedResumeId`, approval status, application status, the
draft, `dedupeKey`, `updatedAt`, and every sheet/Gmail field are left byte-for-byte unchanged,
so regenerating advice cannot disturb the match it was derived from.

**Environment variables.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key; server-side only |
| `ANTHROPIC_MODEL` | no | defaults to `claude-sonnet-5` (shared with intake and matching) |

Plus the Firebase Admin credentials and `GOOGLE_RESUME_SHEET_ID` listed above. There is no
suggestions credential: the endpoint reuses the one Anthropic transport (`lib/claude.js`), the
one configuration reader (`lib/config.js`), and the one Resume Library cache. No new
environment variable was added for this feature.

**Status codes.** `400` the request itself is wrong (missing or malformed `jobId`, malformed
JSON); `401` unauthenticated; `404` the job is missing, not yours, or legacy, or the endpoint
is not configured; `405` non-POST with an `Allow: POST` header; `409` the four precondition
failures above; `500` with one of four fixed messages — `Unable to load this job.`,
`The resume library is temporarily unavailable.`, `Unable to generate resume suggestions.`,
`Unable to save the resume suggestions.` — plus `Could not verify credentials.` when token
verification itself fails. Model output, provider errors, document paths, and sheet ids are
logged server-side and never returned.

---

## `POST /api/draft` (Outreach Email Draft)

Authenticated generation of **one outreach email draft** for **one already-confirmed job**
using **the resume the match already selected**. The mobile app calls it from the Job
Pipeline; the server reads the job's existing match, reads the selected resume out of the
Resume Library, asks Claude for a subject and a body, validates every claim back against the
material the model was actually shown, and persists **only** `draftSubject`, `draftMessage`,
`draftGeneratedAt`, and `draftEditedByHuman` on that caller's own job document.

It produces a draft and nothing else. It never sends mail, never calls Gmail or Apps Script,
never approves anything, never changes an application or follow-up status, and never touches
the match, the suggestions, the resume, `api/rpc.js`, or `apps-script/Code.gs`. There is no
send path in this endpoint and none is implied by its response.

**Request.**

```json
{ "jobId": "job-1" }
```

`jobId` must match `^[A-Za-z0-9_-]{1,128}$`; anything else is a `400`. Every other key in the
body — including `uid`, `resumeId`, `draftSubject`, `draftMessage`, and `matchScore` — is
**ignored, not rejected**. Identity comes from the verified token alone, and the material the
model writes from is loaded server-side, so a caller cannot supply the words they receive.

**Authentication and authorization.** Same contract as the other routes:
`Authorization: Bearer <Firebase ID token>`, verified before the body is read and before any
configuration is loaded. The document path is `users/{verifiedUid}/jobs/{jobId}`; a job that
does not exist, belongs to somebody else, or is a legacy unversioned tracker document all
return the same `404 {"error":"Job not found."}`.

**Preconditions.** A draft is written *from* an existing match, so all four must hold, and
none of them is repaired:

| State | Response |
| --- | --- |
| `intakeStatus` is not `confirmed` | `409 This job must be confirmed before a draft can be generated.` |
| `selectedResumeId` is null | `409 This job has no selected resume. Run a match first.` |
| `matchBreakdown` is null or empty, or `matchScore` is missing or not a number | `409 This job has no match result. Run a match first.` |
| the selected id is absent from the library, or its text is empty | `409 The selected resume is no longer available in the resume library.` |

There is no fallback: the endpoint never falls back to an earlier resume and never runs a
match on the side, because either would produce an email the user never asked for.
`resumeSuggestions` is *optional context*, never a precondition — a job that has never asked
for suggestions still has a match and a resume to draft from, and the `<suggestions>` block is
simply omitted.

**Prompt.** `DRAFT_SYSTEM_PROMPT` (in `lib/draft.js`) sets 13 numbered rules, marks
`<job>`, `<posting>`, `<contact>`, `<match>`, `<suggestions>`, `<resume>`, `<resume_text>`,
and `<label>` as untrusted data rather than instructions, and forbids inventing skills,
experience, employers, projects, dates, certifications, education, years of experience,
metrics, percentages, and recipient names. It asks the model to mention the company and the
exact role, to keep the opening non-generic, to avoid unearned superlatives, to address the
named contact (or "Hiring Team" when there is none), to sign with the candidate's name exactly
as the resume spells it, to omit dates, deadlines, salary figures, reference numbers, and the
job URL, to output exactly one bare JSON object, and to produce no chain of thought. Only
`resumeId`, `resumeLabel`, `targetRole`, and `keywords` are named — all four are already
public through `GET /api/resumes`. The Drive file id, the Drive file name, and
`extractedText` as a field never enter the prompt.

**Response.**

```json
{ "schemaVersion": 1, "jobId": "job-1",
  "draftSubject": "Senior Backend Engineer — Example Corp application",
  "draftMessage": "Hi Priya,\n\nI'm reaching out regarding …",
  "generatedAt": "2026-10-06T12:00:00.000Z" }
```

`generatedAt` is the **server's** clock, never the model's: the model is asked for a subject
and a body only, and an object that carries a timestamp back is rejected as an unknown field.

**Fabrication safeguards.** The subject and the body are each checked back against the
*same truncated blocks the prompt received*, so a claim past a truncation point is judged
against what the model actually saw rather than against the full document. Six guards run,
in this order, and any trip is a `500` with no write:

1. *Numeric grounding* — every digit in the draft must appear in the material as a whole
   token, or be spelled there in words; every spelled-out number next to a measuring unit
   must appear there, or be written as digits. Tokens, not substrings: a source containing
   `84` must not ground a claim of `8 years`.
2. *No internal detail* — provider names, `match score`, `match breakdown`, resume
   suggestions, `schema version`, `api key`, `AI-generated`, prompt references, and any bare
   `n / n` fraction are refused. The email has to read as written by the candidate.
3. *Credential grounding* — the draft speaks in the candidate's voice, so only the resume
   can support a credential claim; the posting naming a Master's does not mean this
   candidate has one. A generic word ("my degree") is satisfied by any credential the resume
   spells out; a specific one must match its own family, and only morphology bridges
   (`certification` ⇄ `Certified`), never the substance.
4. *Proper-noun grounding* — a capitalised term the material does not contain is a name
   nobody wrote down. Mid-sentence capitals are always checked (that is where invented
   employers appear); sentence-initial capitals are checked in the message and skipped in the
   subject, which is a fragment rather than a sentence. Greetings, sign-offs, pronouns, and
   contractions are exempt wherever they sit.
5. *Technology grounding* — the whole draft is scanned against a curated list of
   unambiguous product and language names, which is what catches a lower-case stack name
   like `terraform` that the capitalisation check cannot see.
6. *No unearned superlatives* — `perfect fit`, `ideal candidate`, any guarantee, any
   percentage of fit. These are never checkable against supplied material.

**Validation.** Nothing is repaired. A missing `schemaVersion`, a `schemaVersion` that
disagrees with the server's, a ninth field, an empty or oversized field, a `Subject:` prefix,
markup or a code fence, a control character, or prose wrapper text ("Sure, here is your
draft:") is a rejection rather than a default. The guard reason is logged as
`[draft] fabrication guard: <rule>` and never returned, because it can quote resume bodies.

**Persistence.** One `update()` carrying exactly `draftSubject`, `draftMessage`,
`draftGeneratedAt`, and `draftEditedByHuman: false`. `company`, `role`, `contactName`,
`contactEmail`, `jobUrl`, `location`, `notes`, `rawText`, `rawSource`, `deadline`,
`intakeStatus`, `selectedResumeId`, `matchScore`, `matchBreakdown`, `resumeSuggestions`,
`approvalStatus`, `applicationStatus`, `dedupeKey`, `sheetRowId`, `sheetSyncStatus`,
`gmailThreadId`, `emailSentOn`, `followUpStatus`, and `updatedAt` are left byte-for-byte
unchanged. `draftEditedByHuman` is written as part of the same update, so a fresh draft and
the flag that says nobody has touched it yet are atomic.

**Environment variables.**

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Anthropic API key; server-side only |
| `ANTHROPIC_MODEL` | no | defaults to `claude-sonnet-5` (shared with intake, matching, and suggestions) |

Plus the Firebase Admin credentials and `GOOGLE_RESUME_SHEET_ID` listed above. There is no
draft credential: the endpoint reuses the one Anthropic transport (`lib/claude.js`), the one
configuration reader (`lib/config.js`), and the one Resume Library cache. No new environment
variable was added for this feature.

**Status codes.** `400` the request itself is wrong (missing or malformed `jobId`, malformed
JSON); `401` unauthenticated; `404` the job is missing, not yours, or legacy, or the endpoint
is not configured; `405` non-POST with an `Allow: POST` header; `409` the four precondition
failures above; `500` with one of four fixed messages — `Unable to load this job.`,
`The resume library is temporarily unavailable.`, `Unable to generate the outreach draft.`,
`Unable to save the outreach draft.` — plus `Could not verify credentials.` when token
verification itself fails. Model output, provider errors, document paths, and sheet ids are
logged server-side and never returned.

**Tests.**

```bash
npm test    # 426 node:test cases, hermetic (no Firebase, no Google, no Anthropic)
```

Suggestions are covered by `test/suggestions.test.js` (contract, request parsing, selected
resume lookup, prompt construction, provider boundary, structural validation, and every
fabrication guard with the paraphrases that must survive them) and
`suggestions-api.test.js` (authentication, uid isolation, the three `409` preconditions,
configuration, what is and is not sent to the model, persistence shape, and the no-leak
guarantees).

Outreach drafting is covered by `test/draft.test.js` (contract, request parsing, prompt
construction, the source-text/prompt equivalence the guards depend on, the provider
boundary, structural validation, every fabrication guard, and the legitimate drafts those
guards must let through) and `test/draft-api.test.js` (authentication, uid isolation, the
four `409` preconditions, configuration, what is and is not sent to the model, the four-key
persistence shape, the proof that no approval, send, or status field is ever written, and the
no-leak guarantees).
