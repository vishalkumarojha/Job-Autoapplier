# PassX-Easeout

## Phase 10 reminders and Android sharing

Set `EXPO_PUBLIC_JOBEMAILER_API_URL` to the deployed jobemailer origin and, for Expo push
token registration, `EXPO_PUBLIC_EAS_PROJECT_ID` to the public EAS project identifier.
The app asks for notification permission only while signed in, then sends its Expo token
to authenticated `POST /api/push/register`. Server credentials and Telegram credentials
never enter the app bundle.

Jobs use the existing `deadline` and `nextReminderAt` fields. The app schedules stable local
deadline/follow-up notifications and cancels them when a deadline is removed or a job is
archived. Follow-up reminder time is edited in the Job Pipeline as an ISO timestamp. This
only reminds the user; it never sends a follow-up email. Android `ACTION_SEND` text is
passed to Smart Intake for review and confirmation; URLs are treated as user input and are
not fetched or scraped.

An Android personal-organiser app built with Expo (bare / prebuild workflow) and Firebase.

> **Status: Phase 0 — stabilization.**
> The repository is being made into a reliable build foundation. No AI features are
> currently enabled. See [Current limitations](#current-limitations).

---

## Project

| | |
|---|---|
| **App name (config)** | `ease-out` |
| **Android package** | `com.ease.out` |
| **Expo SDK** | `54.0.33` |
| **React Native** | `0.81.5` |
| **React** | `19.1.0` |
| **TypeScript** | `~5.9.2` |
| **Gradle** | `8.14.3` (via wrapper) |
| **Android SDK levels** | injected by the Expo root Gradle plugin | see `android/build.gradle` (`rootProject.ext.*`) |
| **Platforms** | **Android only.** `android/` is committed; `ios/` is not. |
| **Entry points** | `index.ts` → `App.tsx` |

### What it does today

A single-user productivity app with Firebase email/password auth and Firestore-backed
data. Implemented screens:

- Dashboard — greeting, screen-time chart, quick-access grid, cross-entity search, today's priorities
- Calendar — day-based task lists
- Password Manager — CRUD + CSV import (⚠️ see [Current limitations](#current-limitations))
- Job Tracker — basic application tracking (Firestore)
- Study Planner, Projects, Profiles, Custom Spaces, Account (with avatar upload)

### Data model

Everything is namespaced per user under `users/{uid}/`:

```
users/{uid}/jobs            job applications
users/{uid}/calendar/{YYYY-MM-DD}/tasks
users/{uid}/passwords
users/{uid}/projects
users/{uid}/profiles
users/{uid}/studyTopics
users/{uid}/aiPlan          legacy, no longer written (see Current limitations)
```

### Firebase

Uses `@react-native-firebase` v23.8.8 for **app, auth, firestore, storage, crashlytics**,
plus `@notifee/react-native` for local/trigger notifications.

Firebase requires native configuration, so this app **cannot run in Expo Go**. It needs a
development build.

### Related external system

The Job Application Emailer (Gmail + Google Sheets automation) is a **separate system** that
lives outside this repository. It is not part of this app and is not wired into the mobile
client yet.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20 LTS or 22 | CI pins Node 20 |
| npm | 10+ | ships with Node 20 |
| JDK | **17** | RN 0.81 / Android Gradle Plugin require JDK 17. Newer JDKs (e.g. 25) commonly fail. |
| Android Studio | Ladybug or newer | provides SDK + emulator |
| Android SDK | see `android/build.gradle` | `compileSdk`/`targetSdk`/`minSdk` come from `rootProject.ext.*`, injected by the Expo root Gradle plugin. Inspect with `./gradlew :app:properties`. Set `ANDROID_HOME`. |
| Android device | Android 7+ | or an emulator |

Verify:

```bash
node -v
java -version
echo $ANDROID_HOME
adb devices
```

---

## Install

```bash
git clone https://github.com/vishalkumarojha/PassX-Easeout.git
cd PassX-Easeout
npm ci --legacy-peer-deps
```

> **Use `--legacy-peer-deps`.** The dependency tree contains peer-dependency conflicts that
> are resolved this way. CI uses the same flag, so local and CI installs match.

`npm ci` installs exactly what `package-lock.json` pins. If you add or change a dependency,
regenerate the lockfile the same way:

```bash
npm install --legacy-peer-deps
```

---

## Firebase setup

Firebase config files are **intentionally not committed**. They are per-developer and
project-specific. `.gitignore` already excludes them.

You must supply these locally:

### 1. `android/app/google-services.json`

Download it from the Firebase console:

> Firebase console → your project → ⚙ Project settings → **Your apps** → Android app
> (`com.ease.out`) → *Download google-services.json*

Place it at:

```
android/app/google-services.json
```

The `com.google.gms.google-services` Gradle plugin is applied in `android/app/build.gradle`,
so **the Android build fails immediately and clearly if this file is missing**. That is
intentional — do not commit a placeholder to work around it.

### 2. Enable Firebase services

For the app to function you also need, in the Firebase console:

- **Authentication** → Email/Password sign-in enabled
- **Firestore** database created
- **Storage** bucket created (used by avatar upload)
- **Crashlytics** → enable Crashlytics reporting when prompted

### 3. Firestore security rules

Security rules are **not** in this repository and there is currently no `firestore.rules`
file. Until rules are authored, configure the database rules in the Firebase console to
restrict access to the authenticated owner:

```text
// TEMPLATE ONLY — review before using. Not a vetted production policy.
match /databases/{database}/documents {
  match /users/{userId}/{document=**} {
    allow read, write: if request.auth != null && request.auth.uid == userId;
  }
}
```

Treat the current state as **insecure by default**: do not put real user data into a
production project until rules are committed and reviewed.

### 4. Android debug keystore

`android/app/debug.keystore` is not committed (`*.keystore` is gitignored). Gradle's
`debug` signing config expects it. Either:

- let Android Studio / Gradle generate a debug keystore on first build, or
- create one:

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore android/app/debug.keystore \
  -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass android -keypass android
```

Never commit a keystore. **Release signing is not set up:** `buildTypes.release` in
`android/app/build.gradle` currently reuses `signingConfigs.debug`, so a release build would
be signed with the debug key. Fixing release signing is out of scope for this phase — do not
ship a release build until it is addressed.

---

## Android development

This is a bare/prebuild project: `android/` is committed, so native changes are made in the
repo rather than regenerated.

```bash
# Point Gradle at your SDK (creates an untracked local.properties)
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

# Build a debug binary and install it on a connected device/emulator
npm run android

# Or start the dev server only, after an initial build
npm start
```

Other scripts:

```bash
npm run ios     # not supported — no ios/ directory is committed
npm run web     # limited; native Firebase modules are unavailable on web
```

There is no Expo Go path. `expo start` alone will not run this app on a device.

---

## Validation

Run these before pushing. They mirror `.github/workflows/ci.yml`.

```bash
# 1. clean, lockfile-exact install
npm ci --legacy-peer-deps

# 2. TypeScript (includes test files — tsconfig has no include/exclude)
npx tsc --noEmit

# 3. unit tests
npm test -- --runInBand

# 4. hardcoded-secret scan
grep -rn "AIzaSy\|sk-[a-zA-Z0-9]\|PRIVATE_KEY" \
  --include="*.ts" --include="*.tsx" --include="*.js" src/

# 5. dependency audit
npm audit --audit-level=high

# 6. no whitespace errors
git diff --check

# 7. jobemailer server suite (separate package, plain node:test)
cd ../jobemailer && npm test && cd -
```

Steps 1, 2, and 3 are the meaningful gates and must pass. Step 4 must produce **no output** to
pass. See [Known blockers](#known-blockers) for the current state of step 5.

Android build check (requires the local prerequisites above):

```bash
cd android && ./gradlew assembleDebug
```

---

## Testing

475 tests across 19 suites, run with `jest-expo` + `@testing-library/react-native`. Both run
in CI via `npm run test:ci`. The `jobemailer` server has its own suite of 426 `node:test`
cases under `../jobemailer/test`.

```bash
npm test              # watch mode
npm run test:ci       # single pass, CI
npm test -- --coverage
```

Test files live beside the code they cover, in a `__tests__` folder.

Two testing constraints are worth knowing before adding a suite:

- **A component test that renders a themed component will fail on import.** `ThemeContext`
  initializes Firebase, and Firebase's web bundle is ESM that Jest cannot transform. The
  fix already in place is the `ThemeContext` mapping in `jest.config.js`, pointed at
  `src/__tests__/support/themeContextStub.tsx`. No new config should be added for this.
- **A test importing something that transitively reaches `src/services/firebase` needs
  `jest.mock('../../services/firebase', ...)`** with a factory. This is why
  `src/api/__tests__/resumes.test.ts` mocks it even though it always injects its own token
  function. Pattern to copy: `src/data/jobs/__tests__/firestore.test.ts`.

Firestore is tested against an in-memory fake (`src/data/jobs/__tests__/fakeFirestore.ts`),
not an emulator, so the suite needs no project config and runs offline.

---

## Environment configuration

**There are no secrets in the client.** One non-secret variable is now read at runtime.

| Variable | Required | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_JOBEMAILER_API_URL` | Only for the Resume Library | Origin of the `jobemailer` Vercel backend, no trailing slash, e.g. `https://job-outreach-vercel.vercel.app` |

Copy `.env.example` to `.env` and fill it in, then restart the dev server — Expo inlines
`EXPO_PUBLIC_*` values into the bundle at build time, so a running dev server will not pick
up a change. Firebase is still configured through native files (`google-services.json`), not
through JS configuration.

No `.env` file is needed to build or run the rest of the app. When the variable is unset the
API layer throws `MissingApiBaseUrlError` naming the exact variable rather than falling back
to a placeholder, so a misconfigured deployment fails loudly instead of calling the wrong
host.

See [Resume index](#resume-index) for what the API layer talks to, including the server-side
variables that `jobemailer` needs (those live in `jobemailer/.env`, never in this repo).

### Secret boundary (important)

Anything in `src/` ships inside the APK and can be extracted by anyone who unzips it.
Therefore:

- **Never** put an API key, token, or credential in `src/`, `app.json`, or `app.config.ts`.
- **Never** call an AI or third-party paid API directly from the app.
- Secrets belong on a server. The mobile app may call a server endpoint; the server holds
  the credential.

The previous client-side Gemini integration was removed for exactly this reason. Future AI
features are planned as a **server-side** integration, so credentials stay off the device.

`.gitignore` already blocks `google-services.json`, `GoogleService-Info.plist`, `.env*`, and
`*.keystore`.

---

## Current limitations

Things that are knowingly incomplete or broken. Fixing them is **not** part of Phase 0.

- **AI features are disabled.** The Goals screen and the dashboard "AI Plan" card no longer
  call any provider. The old client-side Gemini code path (API key embedded in the app) was
  deleted in Phase 0. AI will return as a server-side feature.
- **Password Manager stores passwords in plaintext in Firestore** and shows them in a list.
  This is a real security problem, not a stylistic one. Do not store real passwords in it.
- **No Firestore security rules** are committed — see [Firebase setup](#3-firestore-security-rules).
- **No Firestore composite indexes** are configured. Some compound queries will fail at
  runtime until indexes are added in the Firebase console.
- **`npm audit --audit-level=high` currently fails** — 0 critical, 55 high, all SDK-pinned.
  See [Known blockers](#known-blockers).
- **The Password Manager CSV importer** reads files via `expo-file-system/legacy`. That import
  path is deprecated and is pinned only because the existing importer still depends on it.
- **A stale `ease-out` gitlink** is committed at the repo root (a submodule entry with no
  `.gitmodules`). It is inert but confusing; it should be removed in a separate cleanup.
- **No linting or formatting config.** There is no ESLint or Prettier setup. TypeScript and
  the test suite are the automated quality gates — see [Testing](#testing).

---

## Resume index

The Resume Library is implemented end to end. It reads a **Google Drive folder** as the source
of truth and keeps a **dedicated Sheet tab** as the index, so listing resumes never re-parses
the PDFs.

```
Google Drive folder  ──sync──▶  Sheet tab `Resumes`  ──▶  GET /api/resumes  ──▶  ResumeLibraryScreen
 (PDFs, human truth)            (index + extractedText)     (verifies ID token)    (list / picker)
```

- The mobile app never sees a Drive id, a Drive file name, or extracted PDF text. The server
  projects an allow-list, field by field — never a spread of the row.
- `resumeId` is `rsv_` + `sha256(driveFileId)`, so it is stable and opaque; the raw Drive id
  stays server-side (`driveFileId`, `driveFileName` are dropped in the projection).
- Selecting a resume writes **only** `Job.selectedResumeId`. Nothing is scored, sent, or
  uploaded, and matching/approval fields cannot move as a side effect.

### Client

- `src/domain/resume.ts` — `ResumeSummary`, metadata only, no PDF, no Drive URL, no credentials.
- `src/api/client.ts` — authenticated JSON transport with typed errors, timeout, cancellation.
- `src/api/authToken.ts` — Firebase ID token acquisition, per request, never stored.
- `src/api/resumes.ts` — `GET /api/resumes` client.
- `src/screens/ResumeLibraryScreen.tsx` — Loading / Error / Empty / Loaded states; opens as a
  read-only list from the pipeline header, or as a picker when a `jobId` route param is passed.

### Server (`../jobemailer`, plain ESM, no build step)

- `api/resumes.js` — `GET /api/resumes`. Verifies `Authorization: Bearer <Firebase ID token>`
  with `firebase-admin` **before** reading any configuration. Returns
  `{ schemaVersion: 1, resumes, skipped }`, or `{ error }` with 401 / 404 / 405 / 500.
  The `uid` comes only from the verified token — never from a query parameter or body.
- `lib/resume-cache.js` — row schema, `deriveResumeId`, allow-list projection.
- `lib/resume-sync.js` — `mergeFileIntoCache` / `planSync`: Drive listing joined to the cache.
- `lib/{auth,config,google}.js` — token verification, env config, Drive + Sheets clients.
- `scripts/sync-resume-library.js` — manual sync, dry-run by default, `--write` to apply.
- `test/` — 87 `node:test` cases, all hermetic (injected verifier, fake Sheets).

### Server environment (set in Vercel / `jobemailer/.env`, never in this repo)

| Variable | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | yes | service-account JSON, inline or file path (the three `FIREBASE_ADMIN_*` vars are an alternative) |
| `GOOGLE_RESUME_FOLDER_ID` | yes | Drive folder whose PDFs are the resume list |
| `GOOGLE_RESUME_SHEET_ID` | yes | spreadsheet holding the `Resumes` cache tab |
| `GOOGLE_RESUME_SHEET_TAB` | no | defaults to `Resumes` |

The sheet id is deliberately **not** auto-discovered: nothing in this repo identifies the
spreadsheet, so it must be supplied. `apps-script/Code.gs`, `api/rpc.js`, the Gmail flow and
`Sheet1` are untouched.

### What is deliberately absent

No `targetRole` or version inference from PDF text (they are inputs, not guesses), no PDF bytes
on the device, no matching or scoring, no `lastUsedAt` bookkeeping yet, and no AI of any kind.
See [Current limitations](#current-limitations).

---

## Known blockers

**`npm audit --audit-level=high` fails and cannot be made to pass on Expo SDK 54.**

The audit reports high-severity advisories that reach this project only through
`expo@54.0.33` and `react-native@0.81.5` and their pinned toolchain (`metro`, `@expo/cli`,
`@grpc/grpc-js`, `postcss`, `jest-*`). Every available fix requires a **semver-major** jump —
`expo@57` / `react-native@0.87` / `@react-native-firebase@24+` — i.e. an SDK 55+ migration,
which is explicitly out of scope for Phase 0.

Verified: `--omit=dev` and `--audit-level=critical` do not help, because Expo ships its
build toolchain as runtime `dependencies`, so all advisories are counted regardless.

`npm audit fix --legacy-peer-deps` was evaluated and **rejected**: it clears the criticals but
leaves all the highs, and it silently downgrades `ws` 8.20.0 → 6.2.6, which risks breaking the
Metro dev server.

### Pinned critical advisories (`overrides`)

`package.json` pins four transitive build-time packages to patched versions:

| Package | Pinned | Advisory class removed |
|---|---|---|
| `protobufjs` | `^7.6.6` | arbitrary code execution in `toObject` code generation |
| `tar` | `^7.5.22` | PAX header file smuggling |
| `shell-quote` | `^1.12.0` | quadratic-complexity DoS in `parse()` |
| `websocket-driver` | `^0.7.5` | message-compression resource-limit bypass |

Each override stays inside its dependent's own declared semver range
(`@grpc/proto-loader` wants `^7.2.5`, `@expo/cli` wants `^7.5.2`, `react-devtools-core` wants
`^1.6.1`, `faye-websocket` wants `>=0.5.1`), so nothing is forced out of spec. Result:
**0 critical, 55 high, 13 moderate, 1 low.**

All four are build/dev-time only — none ship in the APK.

Do not remove these overrides without re-running `npm audit --audit-level=high` and confirming
`critical` is still `0`.

### Remaining: 55 high, all SDK-pinned

The residual highs reach this project only through `expo@54.0.33`, `react-native@0.81.5` and
their pinned toolchain (`metro`, `@expo/cli`, `@grpc/grpc-js`, `postcss`, `jest-*`). Every
available fix requires a **semver-major** jump — `expo@57` / `react-native@0.87` /
`@react-native-firebase@24+` — i.e. an SDK 55+ migration, which is out of scope for Phase 0.

The vulnerable *packages* are the same 14 as before the test toolchain was added
(`@grpc/grpc-js`, `@xmldom/xmldom`, `brace-expansion`, `braces`, `browserslist`, `image-size`,
`js-yaml`, `lodash`, `nanoid`, `node-forge`, `picomatch`, `postcss`, `undici`, `ws`). The count
rose from 32 to 55 advisory instances only because `jest`/`jest-expo` pull additional copies of
packages that were already vulnerable — no new vulnerable package was introduced.

Verified: `--omit=dev` and `--audit-level=critical` do not help, because Expo ships its build
toolchain as runtime `dependencies`, so all advisories are counted regardless.

The CI audit step therefore still fails. Closing it requires a decision:

1. schedule the SDK 55+ migration and accept the audit gate being red until then, or
2. replace the blanket `npm audit` gate with a checked-in allowlist of accepted advisory IDs
   that fails the build on anything *new*, or
3. leave CI red on the audit step.

### Known pre-existing issues

- **`@react-navigation` peer conflict.** `package.json` pins `@react-navigation/native` to
  `7.1.28` while `@react-navigation/native-stack` (declared as `"*"`) resolves to `7.14.7`,
  which requires `^7.2.0`. `npm ls` reports this as `invalid`. It is why `--legacy-peer-deps`
  is mandatory. Fixing it means bumping `@react-navigation/native` — out of scope here.
- **`js-yaml` (high, in-range fix available).** Not pinned by the overrides above, since only
  the four criticals were in scope. Cheap follow-up if desired.

---

## CI

`.github/workflows/ci.yml` runs on push/PR to `main`:

1. `npm ci --legacy-peer-deps`
2. `npx tsc --noEmit`
3. `npm run test:ci`
4. hardcoded-secret scan over `src/`
5. `npm audit --audit-level=high`

Steps 1–4 pass. Step 5 fails: 0 critical, 55 high — all SDK-pinned, with no fix available
without an SDK 55+ migration. See [Known blockers](#known-blockers).
