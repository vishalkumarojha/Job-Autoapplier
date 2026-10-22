# JOB AGENT — CURRENT STATE AND ENVIRONMENT AUDIT

**Audit date:** 2026-10-11
**Auditor mode:** read-only. No external service was contacted, no deploy, no email, no Apps Script/Drive/Sheets/Firestore write, no Telegram, no push token registered.
**Method:** source inspection + offline test/typecheck runs only. Prior summaries were not trusted; every claim below is derived from the current working tree.

Secret handling: this report never prints secret values. Environment variables are reported as `SET`, `MISSING`, or `ABSENT`/`UNKNOWN` only.

---

## 1. Executive Summary

The project is **substantially implemented in code and offline-verified, but not configured and not live-verified.**

- Two repositories exist and are on `main`:
  - Mobile app: `/home/arno/Desktop/Projects/Automation/PassX-Easeout`
  - Backend: `/home/arno/Desktop/Projects/Automation/jobemailer`
- Both have **large uncommitted working trees** — the newest work is not committed. `.env.example` is **untracked** in both repos.
- **Offline verification passes**: backend `568/568` tests, mobile `499/499` tests across `24` suites, and mobile `tsc --noEmit` is clean (exit 0).
- **Configuration is almost entirely absent**:
  - Mobile has **no `.env`** file at all.
  - Backend `.env` has only `APPS_SCRIPT_URL` and `APPS_SCRIPT_TOKEN` set locally; **no** Firebase/Google/Anthropic/cron variables.
  - **No `google-services.json`**, **no `eas.json`**, **no `android/app/debug.keystore`**, **no `android/local.properties`**.
  - `ANDROID_HOME` points at `/home/arno/Android/Sdk`, which **does not exist**. No `sdkmanager`/`emulator`. `adb` is installed.
- **BLOCKED items**: Android build (missing Google services config + invalid Android SDK path + likely JDK mismatch), any live Firebase/Google/Anthropic call, Vercel deploy state, Apps Script deployment state, push/Telegram.

Bottom line: **the feature surface is built and unit-tested; nothing is wired to real services yet.** The smallest path to value is (a) obtain Firebase Android config to make the app run at all, then (b) provide the backend credential set in Vercel/local `.env` to exercise AI + resume + send.

---

## 2. Repository State

### 2.1 Paths

| Repo | Path | Branch | Remote |
|---|---|---|---|
| Mobile | `/home/arno/Desktop/Projects/Automation/PassX-Easeout` | `main` | `github.com/vishalkumarojha/PassX-Easeout.git` |
| Backend | `/home/arno/Desktop/Projects/Automation/jobemailer` | `main` | `github.com/vishalkumarojha/Jobemailer.git` |

Both paths exist and are `git` repositories. The parent `/home/arno/Desktop/Projects/Automation` is also a `git` repo (it appears to track the two children as gitlinks: `A`/`m` entries for `PassX-Easeout` and `jobemailer`). There is a stray empty `api/push/` directory at the Automation root.

### 2.2 Mobile `PassX-Easeout`

- Latest commit: `357508d Phase 4: BackHeader/BottomNav all screens, Crashlytics, @notifee notifications, Gemini AI daily plan, CI/CD pipeline, input validation, security hardening`
- Branch is up to date with `origin/main`.
- **Uncommitted — modified:** `.github/workflows/ci.yml`, `App.tsx`, `README.md`, `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/java/com/ease/out/MainActivity.kt`, `MainApplication.kt`, `package-lock.json`, `package.json`, `src/components/dashboard/QuickAccessGrid.tsx`, `src/context/AuthContext.tsx`, `src/screens/DashboardScreen.tsx`, `src/screens/features/GoalsScreen.tsx`, `src/screens/features/PasswordManagerScreen.tsx`, `src/services/NotificationService.ts`, `src/types/navigation.ts`
- **Uncommitted — deleted:** `src/services/GeminiService.ts`
- **Untracked:** `.env.example`, `TECHNICAL_AUDIT.md`, `android/app/src/main/java/com/ease/out/ShareIntentModule.kt`, `jest.config.js`, `src/__tests__/`
- Stray empty file `Untitled file.js` exists at the repo root.

Notable structure (all present):
- API layer: `src/api/{client,authToken,errors,intake,resumes,match,suggestions,draft,approval,send,push}.ts`
- Domain/data: `src/domain/{job,resume}.ts`, `src/data/jobs/{firestore,types}.ts`
- Screens: `LoginScreen`, `SignupScreen`, `WelcomeScreen`, `DashboardScreen`, `JobIntakeScreen`, `JobIntakeReviewScreen`, `JobPipelineScreen`, `ResumeLibraryScreen`, plus feature screens.
- Components: `components/jobs/{JobCard,JobForm,ResumeMatchSection,ResumeSuggestions,OutreachDraftSection,ApplicationReviewSection,DeadlineChip,StageBadge}.tsx`
- Services: `firebase.ts`, `NotificationService.ts`, `ShareIntent.ts`, `shareContent.ts`
- Native Android share module: `android/.../ShareIntentModule.kt` (registered in `MainApplication.kt:27`), `MainActivity.kt:21,27` capture logic, `AndroidManifest.xml:24-28` `ACTION_SEND`/`text/plain` intent filter.

### 2.3 Backend `jobemailer`

- Latest commits: `f75a9ae test version 0.0.2`, `44ef709 test version 0.0.1`, `ae4199c test version`
- Branch up to date with `origin/main`.
- **Uncommitted — modified:** `README.md`, `api/rpc.js`, `package.json`, `vercel.json`; **deleted** `apps-script/ApiBridge.gs`
- **Untracked:** `.env.example`, `.gitignore`, `api/{approval,draft,intake,match,resumes,send,suggestions}.js`, `api/push/`, `api/reminders/`, `apps-script/{Code.gs,Email.html,FollowUp.html}`, `lib/`, `package-lock.json`

Notable structure (all present): `lib/{config,auth,google,claude,intake,match,suggestions,draft,approval,jobs,send,reminders,resume-cache,resume-sync}.js`, `api/*` handlers, `scripts/sync-resume-library.js`, `apps-script/Code.gs` (legacy dashboard bridge + `send` action), 21 test files under `test/`.

> The bulk of the backend (all Phase 5–10 endpoints, `lib/`, `apps-script/Code.gs`) is **untracked** — it exists on disk and is tested, but is not committed.

---

## 3. Verified Test Results

All commands below are read-only/offline. No network calls were observed; tests inject fakes.

| Check | Command | Result |
|---|---|---|
| Backend tests | `npm test` in `jobemailer` (`node --test "test/*.test.js"`) | **PASS — 568 tests, 568 pass, 0 fail, 0 skipped** |
| Mobile tests | `npx jest --runInBand` in `PassX-Easeout` | **PASS — 24 suites, 499 tests, 0 fail** |
| Mobile typecheck | `npx tsc --noEmit` in `PassX-Easeout` | **PASS — exit 0, no diagnostics** |
| Mobile lint | — | **N/A** — no `lint` script defined in `package.json` |
| Backend lint | — | **N/A** — no lint script/config |
| Android build | — | **BLOCKED** (see §9) |
| Live/E2E | — | **NOT VERIFIED / BLOCKED** |

Notes:
- Mobile test run emits a React `act(...)` console warning and a `forwardRef` stack trace from `OutreachDraftSection`, but the suite still reports PASS. These are warnings, not failures.
- Passing unit tests do **not** prove any production integration works. No Firebase, Google, Anthropic, Apps Script, or Expo service was contacted.

---

## 4. Completion Matrix

Legend: `IMPLEMENTED IN CODE` = source exists; `LOCAL TESTS PASS` = covered by passing tests; `CONFIGURED LOCALLY` = required local var/file present; `DEPLOYED` = pushed to a live host (not verifiable here); `LIVE VERIFIED` = actually exercised against real services (none).

| # | Capability | Code | Local tests | Config | Live | Blocker / next action |
|---|---|---|---|---|---|---|
| 1 | Paste/share job text | YES — `JobIntakeScreen.tsx`, `shareContent.ts`, `ShareIntent.ts`, `ShareIntentModule.kt` | PASS | Partial (share needs native build) | NOT VERIFIED | Needs runnable Android build |
| 2 | Firebase sign-in + ID token | YES — `AuthContext.tsx`, `authToken.ts` | PASS | **NO `google-services.json`** | BLOCKED | Add Firebase Android app config |
| 3 | Smart Intake | YES — `api/intake.js`, `lib/intake.js`, `lib/claude.js`, mobile `api/intake.ts` | PASS | **NO `ANTHROPIC_API_KEY`, no credential, no base URL** | BLOCKED | Set Vercel + mobile env |
| 4 | Resume Library sync/listing | YES — `api/resumes.js`, `lib/google.js`, `scripts/sync-resume-library.js` | PASS | **NO SA/FOLDER/SHEET IDs** | BLOCKED | Create Sheet + share Drive folder |
| 5 | Resume matching | YES — `api/match.js`, `lib/match.js`, `ResumeMatchSection.tsx` | PASS | Same as #3/#4 | BLOCKED | Config + confirmed job |
| 6 | Suggestions | YES — `api/suggestions.js`, `lib/suggestions.js`, `ResumeSuggestions.tsx` | PASS | Same | BLOCKED | Requires existing match |
| 7 | Outreach draft | YES — `api/draft.js`, `lib/draft.js`, `OutreachDraftSection.tsx` | PASS | Same | BLOCKED | Requires match |
| 8 | Human review/approval | YES — `api/approval.js`, `lib/approval.js`, `ApplicationReviewSection.tsx` | PASS | Same + Sheet | BLOCKED | Config |
| 9 | `POST /api/send` | YES — `api/send.js`, `lib/send.js` | PASS | Local `.env` has Apps Script URL/token only | BLOCKED | Needs SA/Sheet for resume + matching token |
| 10 | Apps Script handoff | YES — `Code.gs` `send`/`add_` via `doPost` | PASS (contract test) | `DASHBOARD_API_TOKEN` property unknown | BLOCKED | Deploy + set property = `APPS_SCRIPT_TOKEN` |
| 11 | Gmail delivery | External (Apps Script/Gmail) | Contract-tested with fakes | Not configured | NOT VERIFIED | Requires #10 |
| 12 | Approved subject/body integrity | YES — `approvedApplicationContent_` (`Code.gs:272`), `send.js` field map | PASS | — | NOT VERIFIED | Live test with approved draft |
| 13 | Selected resume attachment | YES — `approvedResumeFileId` flow (`Code.gs:178`, `send.js:32`) | PASS | Needs Drive ids | NOT VERIFIED | Live test |
| 14 | Gmail thread ID persistence | YES — `Code.gs:367/372`, `writeSendFields` | PASS | Needs Firestore | NOT VERIFIED | Live test |
| 15 | Firestore lifecycle update | YES — `lib/jobs.js`, `firestore.ts` | PASS | No Admin creds | BLOCKED | Service account |
| 16 | Duplicate-send rejection | YES — `claimSend`, `sendPreconditionFailure`, Apps Script duplicate guard | PASS | — | NOT VERIFIED | Live test |
| 17 | Deadline/follow-up scheduler | YES — `api/reminders/run.js`, `lib/reminders.js`, `vercel.json` cron | PASS | Missing `CRON_SECRET` | BLOCKED | Set cron secret |
| 18 | Push notifications | YES — `push/register.js`, `App.tsx`, `NotificationService.ts` | PASS | No `EXPO_PUBLIC_EAS_PROJECT_ID`, no gservices | BLOCKED | EAS project + FCM |
| 19 | Telegram (optional) | YES — `reminders.js:55`, `config.js:203` | PASS | Absent | OFF (expected) | Optional |
| 20 | Android share runtime/build | Code YES (`ShareIntentModule.kt`) | Untested natively | No gservices/SDK/keystore | BLOCKED | Fix Android toolchain |

---

## 5. Environment Variables — Complete Inventory

All names below are **derived from source**, not from the prompt. Status reflects the local machine only. Vercel/Apps Script remote values are `UNKNOWN` (not verifiable without signing in / contacting services).

### 5.1 Mobile variables (read by `PassX-Easeout`)

| Name | Required? | Read by | Belongs in | Local status | Breaks without it | Secret? |
|---|---|---|---|---|---|---|
| `EXPO_PUBLIC_JOBEMAILER_API_URL` | Required for any backend call | `src/config/env.ts:20,40` | mobile `.env` | **MISSING** (no `.env`) | All API calls throw `MissingApiBaseUrlError`; UI still renders | No (bundled) |
| `EXPO_PUBLIC_EAS_PROJECT_ID` | Optional | `App.tsx:110` | mobile `.env` | **MISSING** | Push token registration skipped (`if (projectId)`) | No |

Firebase client config is **not** read from env; `@react-native-firebase` auto-initializes from the native `google-services.json`.

### 5.2 Backend variables (read by `jobemailer`)

| Name | Required? | Read by | Belongs in | Local status | Breaks without it | Secret? |
|---|---|---|---|---|---|---|
| `APPS_SCRIPT_URL` | Required for `/api/send` + `/api/rpc` | `lib/config.js:188`, `api/rpc.js:7` | Vercel + backend `.env` | **SET** | send/rpc 404/500 | No (endpoint) |
| `APPS_SCRIPT_TOKEN` | Required for `/api/send` + `/api/rpc` | `lib/config.js:189`, `api/rpc.js:7` | Vercel + backend `.env` | **SET** | send/rpc fail | **YES** |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Credential (alternative A) | `lib/config.js:58,225` | Vercel | **ABSENT** | Admin auth + Drive/Sheets fail | **YES** |
| `FIREBASE_ADMIN_PROJECT_ID` | Credential (alternative B) | `lib/config.js:53` | Vercel | **ABSENT** | auth fails | No |
| `FIREBASE_ADMIN_CLIENT_EMAIL` | Credential (alternative B) | `lib/config.js:54` | Vercel | **ABSENT** | auth fails | No |
| `FIREBASE_ADMIN_PRIVATE_KEY` | Credential (alternative B) | `lib/config.js:51,57` | Vercel | **ABSENT** | auth fails | **YES** |
| `GOOGLE_RESUME_FOLDER_ID` | Required for sync | `lib/config.js:143` | Vercel | **ABSENT** | sync fails; `/api/resumes` 404 | No |
| `GOOGLE_RESUME_SHEET_ID` | Required for resumes/match/draft/approval/send | `lib/config.js:144` | Vercel | **ABSENT** | those routes 404 | No |
| `GOOGLE_RESUME_SHEET_TAB` | Optional (default `Resumes`) | `lib/config.js:145` | Vercel | **ABSENT** | uses `Resumes` | No |
| `ANTHROPIC_API_KEY` | Required for AI features | `lib/config.js:107` | Vercel | **ABSENT** | intake/match/suggestions/draft 404 | **YES** |
| `ANTHROPIC_MODEL` | Optional (default `claude-sonnet-5`) | `lib/config.js:116`, `lib/claude.js:40` | Vercel | **ABSENT** | uses default | No |
| `CRON_SECRET` | Required for reminders | `lib/config.js:201` | Vercel | **ABSENT** | `/api/reminders/run` 503 | **YES** |
| `TELEGRAM_BOT_TOKEN` | Optional | `lib/config.js:203` | Vercel | **ABSENT** | Telegram off | **YES** |
| `TELEGRAM_CHAT_ID` | Optional | `lib/config.js:204` | Vercel | **ABSENT** | Telegram off | Yes (sensitive) |
| `TELEGRAM_USER_UID` | Optional | `lib/config.js:205` | Vercel | **ABSENT** | Telegram off | No |

**Credential rule (from `lib/config.js:50-83`):** supply **either** `GOOGLE_SERVICE_ACCOUNT_JSON` **or** all three `FIREBASE_ADMIN_*` split fields. The same service account is used for Firebase Admin **and** the Google Drive/Sheets APIs.

**Telegram rule (`lib/config.js:206-207`):** if any of the three Telegram vars is set, all three must be set, or config throws.

### 5.3 Apps Script Script Properties (not `.env`)

| Name | Required? | Read by | Belongs in | Local status | Breaks without it | Secret? |
|---|---|---|---|---|---|---|
| `DASHBOARD_API_TOKEN` | Required by the bridge | `apps-script/Code.gs:584` (`doPost`) | **Apps Script → Project Settings → Script Properties** | **UNKNOWN** (cannot read remotely) | `doPost` returns `{ok:false,error:'Unauthorized'}` | **YES** |

> The backend sends `APPS_SCRIPT_TOKEN`; `Code.gs` compares it to the Script Property `DASHBOARD_API_TOKEN`. **These two values must be identical**, and `DASHBOARD_API_TOKEN` is **not present in `jobemailer/.env.example`** (see §11).

### 5.4 Not environment variables (files / console settings)

- `android/app/google-services.json` — Firebase Android config for package `com.ease.out` (required by `com.google.gms.google-services` plugin).
- `android/app/debug.keystore` — referenced by `android/app/build.gradle:102`; not present.
- `android/local.properties` or a valid `ANDROID_HOME` — required to build.
- EAS project ID (`app.json` has only the legacy `slug: "snack-a594c37f-…"`; no `extra.eas.projectId`).

---

## 6. Proposed Mobile `.env` Template

Template only — **do not overwrite the existing file** (there is none). Client-safe values only; no server secrets.

```dotenv
# Origin of the jobemailer backend. No trailing slash. Not a secret:
# Expo inlines EXPO_PUBLIC_* into the app bundle.
EXPO_PUBLIC_JOBEMAILER_API_URL=https://<your-vercel-project>.vercel.app

# Public EAS project id used to obtain an Expo push token. Identifier, not a secret.
# Optional: push registration is skipped when unset.
EXPO_PUBLIC_EAS_PROJECT_ID=<your-eas-project-uuid>
```

Do **not** place here: `ANTHROPIC_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `APPS_SCRIPT_TOKEN`, `CRON_SECRET`, `TELEGRAM_*`, or any private key.

---

## 7. Proposed Backend `.env` Template

Template only. Marked for local `jobemailer` development. `[secret]` = must never be committed.

```dotenv
# ── Apps Script bridge (required for /api/send, /api/rpc) ──
APPS_SCRIPT_URL=https://script.google.com/macros/s/<deployment-id>/exec
APPS_SCRIPT_TOKEN=replace_locally_do_not_commit   # [secret] must equal Apps Script DASHBOARD_API_TOKEN

# ── Firebase Admin + Google APIs credential (choose ONE form) ──
# Form A (preferred):
GOOGLE_SERVICE_ACCOUNT_JSON=replace_locally_do_not_commit   # [secret] raw or base64 JSON
# Form B (only if A is empty):
FIREBASE_ADMIN_PROJECT_ID=
FIREBASE_ADMIN_CLIENT_EMAIL=
FIREBASE_ADMIN_PRIVATE_KEY=   # [secret] \n-escaped

# ── Google Drive / Sheets (Resume Library) ──
GOOGLE_RESUME_FOLDER_ID=replace_locally_do_not_commit
GOOGLE_RESUME_SHEET_ID=replace_locally_do_not_commit
GOOGLE_RESUME_SHEET_TAB=Resumes

# ── Anthropic (Smart Intake / Match / Suggestions / Draft) ──
ANTHROPIC_API_KEY=replace_locally_do_not_commit   # [secret]
ANTHROPIC_MODEL=

# ── Reminders cron ──
CRON_SECRET=replace_locally_do_not_commit   # [secret]

# ── Telegram (optional; set all three or none) ──
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_USER_UID=
```

Note: `jobemailer/.env` is git-ignored (`.gitignore:1`) and is **not tracked**; `.env.example` is untracked (not yet committed).

---

## 8. Vercel Variables and Dashboard Setup

Required production variables, grouped by feature (all belong to the **jobemailer** Vercel project; scopes = Production by default in Vercel):

- **Firebase Admin / Firestore:** `GOOGLE_SERVICE_ACCOUNT_JSON` **or** `FIREBASE_ADMIN_PROJECT_ID` + `FIREBASE_ADMIN_CLIENT_EMAIL` + `FIREBASE_ADMIN_PRIVATE_KEY`.
- **Google Drive & Resume Library Sheet:** `GOOGLE_RESUME_FOLDER_ID`, `GOOGLE_RESUME_SHEET_ID`, optional `GOOGLE_RESUME_SHEET_TAB`.
- **Apps Script / Gmail bridge:** `APPS_SCRIPT_URL`, `APPS_SCRIPT_TOKEN`.
- **Anthropic:** `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL`. (Without it, AI routes return 404 and nothing else changes.)
- **Cron / reminders:** `CRON_SECRET` (plus the Vercel cron in `vercel.json`).
- **Telegram (optional):** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_USER_UID`.
- **Push:** no dedicated Vercel variable; Expo push tokens are stored in Firestore via `/api/push/register`.

Deployment facts from source:
- `vercel.json` declares function `maxDuration` values and one cron: `/api/reminders/run` at `0 9 * * *`.
- Vercel CLI is **not installed** locally; no `.vercel` project link was found. Remote variable scope and values are **UNKNOWN** and were not verified. Do not assume anything is set remotely.

---

## 9. Android / Firebase / EAS Prerequisites

| Item | Required by | Status |
|---|---|---|
| `android/app/google-services.json` | `com.google.gms.google-services` plugin (`android/app/build.gradle:184`); RNFirebase auto-init | **MISSING** — build will fail / Firebase will not init |
| Firebase Android app with package `com.ease.out` | `app.json:19`, `build.gradle:90-92`, manifest | **UNKNOWN** (console) — must exist in Firebase console |
| Firebase Auth (Email/Password enabled) | `AuthContext.tsx` | **UNKNOWN** |
| Firebase Firestore | `firestore.ts`, backend `lib/jobs.js` | **UNKNOWN** |
| Firebase Storage | `AuthContext.tsx:89` (profile photos) | **UNKNOWN** |
| `android/app/debug.keystore` | `android/app/build.gradle:100-106` | **MISSING** |
| JDK 17 | React Native / AGP | **BLOCKED** — local Java is **OpenJDK 25**; AGP expects JDK 17; Gradle wrapper is `8.14.3` |
| `JAVA_HOME` | Gradle | Set to `/home/arno/.sdkman/candidates/java/current` (Java 25) — likely incompatible with this RN/AGP combo |
| Android SDK | Gradle | **BLOCKED** — `ANDROID_HOME=/home/arno/Android/Sdk` does **not exist**; `ANDROID_SDK_ROOT` unset; no `sdkmanager`/`emulator` |
| `adb` | Device deploy | **PRESENT** (`/usr/bin/adb`, v37.0.0) |
| Gradle wrapper | `android/gradlew` | **PRESENT** (8.14.3) |
| `android/local.properties` | SDK path | **MISSING** |
| `eas.json` | EAS build profiles | **MISSING** |
| EAS project ID | `EXPO_PUBLIC_EAS_PROJECT_ID` / push | **MISSING** (`app.json` has no `extra.eas.projectId`) |
| `expo-notifications` / `@notifee` / Crashlytics | notifications | Dependencies installed (`package.json`) |

Conclusion: **Android build is BLOCKED** as-is. A device/emulator run also cannot use **Expo Go** because `@react-native-firebase/*` and Notifee are native modules requiring a dev/prod build.

---

## 10. Google Drive / Sheets / Apps Script Setup

What the code requires (all server-side, from `.env.example` and `lib/`):

- **Drive folder:** `GOOGLE_RESUME_FOLDER_ID` — the `…/folders/<ID>` segment. Share with the service account as **Viewer**. PDFs only are listed (`lib/google.js:50`).
- **Sheet:** `GOOGLE_RESUME_SHEET_ID` (`…/spreadsheets/d/<ID>`). Share with the service account as **Editor** (the sync writes; `ensureResumeTab` may create the tab). Tab name from `GOOGLE_RESUME_SHEET_TAB` (default `Resumes`).
- **Service account:** from Firebase console → Project settings → Service accounts → Generate private key. Same SA used for Admin auth and Drive/Sheets. Scopes used: `drive.readonly`, `spreadsheets`.
- **Apps Script deployment:** `APPS_SCRIPT_URL` must be the deployed `/exec` URL (not `/dev`), access = "Anyone" (see `api/rpc.js:16-19` diagnostics). The bridge uses `GmailApp`/`Gmail` and `DriveApp`.
- **Token matching:** backend `APPS_SCRIPT_TOKEN` == Apps Script Script Property `DASHBOARD_API_TOKEN`. `Code.gs` (line 584) rejects mismatches.
- **Token storage:** `APPS_SCRIPT_TOKEN` lives in the backend `.env`/Vercel; `DASHBOARD_API_TOKEN` lives in Apps Script Script Properties. No call was made to either.

No Apps Script deployment, Drive share, or Sheet was created/verified. Remote status: **UNKNOWN**.

---

## 11. Missing, Conflicting, or Undocumented Configuration

1. **`DASHBOARD_API_TOKEN` is undocumented.** It is required by `apps-script/Code.gs:584` but absent from `jobemailer/.env.example`. It must match `APPS_SCRIPT_TOKEN`; document it in the Apps Script setup section.
2. **`.env.example` files are untracked** in both repos, so a fresh clone gets no templates.
3. **`google-services.json` is referenced by the build but excluded** (`.gitignore:45`) and does not exist — expected for secrets, but nothing documents where to place it.
4. **`android/app/debug.keystore` is referenced** by `build.gradle:102` but missing; debug builds will fail signing.
5. **Model name:** `.env.example` and `lib/claude.js:40` default to `claude-sonnet-5`. Ensure this exact model id is valid for the account, or set `ANTHROPIC_MODEL`.
6. **`EXPO_PUBLIC_JOBEMAILER_API_URL` has no default by design** (`src/config/env.ts:15-17`); unset means every API call fails loudly — not a bug, but a config requirement.
7. **`app.json` `slug` is a leftover Snack id** (`snack-a594c37f-…`) and there is no EAS `projectId`; EAS/Expo tooling may need a real slug/project.
8. **Parent repo tracks child repos as gitlinks** (`Am PassX-Easeout`, `Am jobemailer`) with no visible `.gitmodules`; commit/deploy behavior here is ambiguous.
9. **Local backend `.env` is heavily incomplete** (only `APPS_SCRIPT_URL` + `APPS_SCRIPT_TOKEN`), so local runs of `/api/intake`, `/api/resumes`, `/api/match`, etc. return 404.
10. **`api/rpc.js` still uses raw `process.env`** (legacy path) rather than `lib/config.js`; harmless but an inconsistent config pattern.

---

## 12. Prioritized Remaining Work

Ordered, smallest-impact-first. "Obtain" = a value/file only you can produce.

**P0 — Make the app runnable at all**
1. Create the Firebase Android app (`com.ease.out`) and obtain `google-services.json`; place at `android/app/google-services.json`.
2. Install a valid **JDK 17**; point `JAVA_HOME` at it.
3. Install the **Android SDK** (or fix `ANDROID_HOME` to an existing path); create `android/local.properties` with `sdk.dir`.
4. Generate a debug keystore (or let `expo run:android` create one) so signing succeeds.

**P1 — First backend-backed flow**
5. Deploy `jobemailer` to Vercel (or run locally) and set the credential variables (§8).
6. Provide `EXPO_PUBLIC_JOBEMAILER_API_URL` in the mobile `.env`.
7. Deploy `apps/script/Code.gs` as a web app; set Script Property `DASHBOARD_API_TOKEN` == `APPS_SCRIPT_TOKEN`.

**P2 — Resume Library + AI**
8. Create the Drive folder + Sheet; share with the service account; set `GOOGLE_RESUME_FOLDER_ID` / `GOOGLE_RESUME_SHEET_ID`.
9. Run `npm run sync:resumes` (dry run) then `npm run sync:resumes:write` to populate the cache.
10. Set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`).

**P3 — Lifecycle features**
11. Set `CRON_SECRET`; confirm the Vercel cron from `vercel.json`.
12. Optional Telegram vars.
13. Set `EXPO_PUBLIC_EAS_PROJECT_ID`; register push tokens.

**P4 — Housekeeping**
14. Commit the currently uncommitted backend `lib/`, `api/*`, `apps-script/Code.gs`, `.env.example`, and mobile `.env.example`/tests/native module.
15. Document `DASHBOARD_API_TOKEN`; add `eas.json`; fix `app.json` slug.

---

## 13. Safe End-to-End Test Plan

Do these in order; stop if any step fails. Each stage is independently safe.

**Stage A — Backend config sanity (offline, no external calls)**
1. `node -e "import('./lib/config.js').then(m=>{try{m.intakeConfig();console.log('intake OK')}catch(e){console.log(e.message)}})"` in `jobemailer` — prints only variable **names**, never values.
2. Repeat for `resumeLibraryConfig`, `sendConfig`, `reminderConfig`.

**Stage B — Local backend boot (no deploy)**
3. Start the Vercel dev server locally (`npx vercel dev`) **after** setting `.env`. Do not deploy.
4. `GET /api/resumes` with no token → expect `401`. With a valid token → expect `200`.

**Stage C — Auth smoke test (mobile)**
5. Build/run on an emulator; sign up one test user; confirm the Dashboard renders (no API call needed).

**Stage D — Intake (one controlled request)**
6. Paste a **non-sensitive** job text; confirm extraction fields and confidence render. No email is sent.

**Stage E — Resume + AI chain (after P2)**
7. Open Resume Library → expect the synced list.
8. Confirm a job → Run match → Generate suggestions → Generate draft. Inspect only; do not approve.

**Stage F — Approval (no send)**
9. Approve then immediately verify `approvalStatus`; do **not** press Send yet.

**Stage G — Send (only with explicit human authorization)**
10. Use one address **you control**. Confirm exactly one row in the Sheet, correct subject/body, correct attachment, `gmailThreadId` stored.
11. Press Send again → expect duplicate rejection (409).

**Stage H — Reminders**
12. Manually invoke `/api/reminders/run` with `Authorization: Bearer $CRON_SECRET` on a disposable job.

Never point this at a real recruiter address during testing.

---

## 14. What I Need to Provide or Configure Manually

You must obtain/provide (none of these are in the repo, by design or by omission):

1. `google-services.json` (Firebase Android app, package `com.ease.out`).
2. A Firebase service-account key → `GOOGLE_SERVICE_ACCOUNT_JSON` (or the 3 split fields).
3. Google Drive **resume folder ID**, shared with the service account (Viewer).
4. Google **Resume Library Sheet ID**, shared with the service account (Editor).
5. Anthropic API key (+ optional model id).
6. Apps Script web-app `/exec` URL and its `DASHBOARD_API_TOKEN` Script Property (must equal `APPS_SCRIPT_TOKEN`).
7. `CRON_SECRET` (long random).
8. Optional Telegram bot token / chat id / your Firebase UID.
9. EAS project ID (for push).
10. Local toolchain: **JDK 17**, Android SDK path, debug keystore.
11. Vercel project + the environment variables from §8.

---

## 15. Final Readiness Verdict

| Explicit question | Answer |
|---|---|
| Can the mobile app open now? | **No — BLOCKED.** No `google-services.json`, no valid Android SDK (`ANDROID_HOME` path missing), JDK 25 instead of 17, no debug keystore. Expo Go cannot run the native Firebase/Notifee modules. The **UI code itself needs no backend secrets to render** (API URL is read lazily at call time only), but native Firebase config is required to launch. |
| Can it authenticate? | **No — BLOCKED.** Requires `google-services.json` + Firebase Auth (Email/Password) enabled. Code is implemented and unit-tested. |
| Can it reach a backend? | **No — not configured.** Mobile has no `.env`; `EXPO_PUBLIC_JOBEMAILER_API_URL` is unset, so calls fail immediately. Do not guess a production URL. |
| Can AI intake/matching/drafting work? | **Not live.** Implemented and unit-tested; blocked on `ANTHROPIC_API_KEY`, credential, Sheet, and mobile base URL. |
| Can the Resume Library load? | **Not live.** Blocked on credential + folder/sheet IDs + a sync run. |
| Can approved sending work? | **Not live.** Local `.env` has Apps Script URL/token, but send also needs the credential + Sheet (resume resolution) and a deployed, token-matched Apps Script. |
| Can Android build/share work? | **No — BLOCKED.** Share code exists, but the Android toolchain and Firebase config are missing. |
| Smallest set for the first local app launch? | (1) Add `google-services.json`; (2) JDK 17; (3) working Android SDK + `local.properties`; (4) debug keystore. No backend secrets needed to reach the sign-in screen. |
| Smallest set for the first safe end-to-end test? | Above + (5) backend deployed with credential/Sheet/Anthropic + Apps Script token, (6) mobile `EXPO_PUBLIC_JOBEMAILER_API_URL`, (7) a populated Resume Library, then run Stages B–G with a test address. |

**Minimum to launch the mobile UI** ≠ **minimum to run the system.** The UI needs only the native Firebase file and a working Android toolchain — it can render without backend secrets. The complete system additionally needs the backend credential set, Google Drive/Sheets, Anthropic, the Apps Script bridge, and the mobile API base URL.

**Overall status: IMPLEMENTED IN CODE + LOCAL TESTS PASS; CONFIGURED LOCALLY: almost nothing; DEPLOYED: not verifiable; LIVE VERIFIED: nothing.**

---

## 16. Ordered Checklist

- [ ] Provide `google-services.json` → `android/app/google-services.json`
- [ ] Install JDK 17; set `JAVA_HOME`
- [ ] Install Android SDK / fix `ANDROID_HOME`; create `android/local.properties`
- [ ] Generate/obtain `debug.keystore`
- [ ] Create Firebase service account → `GOOGLE_SERVICE_ACCOUNT_JSON`
- [ ] Create Drive folder (`GOOGLE_RESUME_FOLDER_ID`) + Sheet (`GOOGLE_RESUME_SHEET_ID`); share with SA
- [ ] Create Anthropic key → `ANTHROPIC_API_KEY`
- [ ] Deploy `apps-script/Code.gs`; set `DASHBOARD_API_TOKEN` = `APPS_SCRIPT_TOKEN`
- [ ] Deploy backend to Vercel with §8 variables
- [ ] Put `EXPO_PUBLIC_JOBEMAILER_API_URL` (+ optional `EXPO_PUBLIC_EAS_PROJECT_ID`) in mobile `.env`
- [ ] Run `npm run sync:resumes` (dry) → `--write`
- [ ] Set `CRON_SECRET`; optional Telegram + EAS push
- [ ] Commit the uncommitted backend/mobile work and the `.env.example` templates
- [ ] Execute the Safe E2E plan (Stages A–H), never against a real recruiter address

---

*Report saved to `/home/arno/Desktop/Projects/Automation/JOB_AGENT_CURRENT_STATE_AND_ENV_AUDIT.md`. No project or environment files were modified.*
