# PassX-Easeout — Complete Technical Audit

> **Status:** Read-only codebase analysis. No files were modified, no packages installed, no commits made.
> **Scope:** Full technical audit of the PassX-Easeout Expo / React Native repository, plus an assessment of its integration surface with the external Job Application Emailer.
> **Method note:** `node_modules` was **not installed**, so `tsc`, a build, and the app could not be run. All build/type claims are derived from `package.json`, `package-lock.json` (776 packages), static source reading, and Expo's published SDK 54 changelogs. Every claim that could not be verified is explicitly flagged.

---

**Repo:** `/home/arno/Desktop/Projects/Automation/PassX-Easeout` → `github.com/vishalkumarojha/PassX-Easeout`
**Branch:** `main` · **Commits: 1** (`357508d`) · **Tracked files: 89** · **Working tree: clean**

---

## Table of Contents

1. [Repository structure](#1-repository-structure)
2. [Current application state](#2-current-application-state)
3. [Technology audit](#3-technology-audit-observed-not-assumed)
4. [Important files](#4-important-files)
5. [Existing architecture diagram](#5-existing-architecture-as-observed)
6. [Job Tracker integration assessment](#6-job-tracker-integration-assessment)
7. [Share-to-tracker assessment](#7-share-to-tracker-assessment)
8. [API integration assessment](#8-api-integration-assessment)
9. [Notification assessment](#9-notification-assessment)
10. [Data model recommendation](#10-proposed-job-tracker-data-model)
11. [Resume Library integration](#11-resume-library-integration)
12. [Security and secrets](#12-security-and-secrets-boundaries-only--no-hardening-implemented)
13. [Risks and technical debt](#13-risks-and-technical-debt)
14. [Recommended development order](#14-recommended-development-order)
15. [Executive summary](#15-executive-summary)
16. [READY FOR IMPLEMENTATION](#ready-for-implementation)

---

## 1. Repository structure

### What this actually is

**Not the default Expo scaffold.** The `App.tsx`, `README.md`, `assets/snack-icon.png`, and `components/AssetExample.js` are Snack leftovers, but everything under `src/` is hand-written and substantial (~4,000 lines across 13 screens, 5 components, 3 services, 2 contexts).

This is a **general-purpose personal-organizer app** (passwords, calendar, projects, study planner, goals, profiles, custom workspaces, screen-time analytics) that happens to contain a rudimentary job tracker. It was **not** built as an AI job-application agent.

### Directory-by-directory

| Path | Responsibility |
|---|---|
| `App.tsx` | **The single most important file.** Root component. Wraps everything in `CrashlyticsErrorBoundary` → `AuthProvider` → `ThemeProvider` → `NavigationContainer` → `RootNavigator`. Contains the entire navigation graph, the auth gate, and an inline error-boundary class. Also defines a **second, duplicate** `RootStackParamList` at line 31. |
| `index.ts` | `registerRootComponent(App)`. Standard Expo entry. |
| `app.json` | Static Expo config. **No `plugins` array, no `scheme`, no `bundleIdentifier`, no `extra`.** `newArchEnabled: true`, Android `edgeToEdgeEnabled: true`, `predictiveBackGestureEnabled: false`. |
| `src/screens/` | 13 screens. `WelcomeScreen`, `LoginScreen`, `SignupScreen` (auth, typed props) + `DashboardScreen`, `AccountScreen` (top level) + 9 under `src/screens/features/`. |
| `src/components/` | `BackHeader` (46 L), `BottomNav` (123 L), `CustomButton` (48 L), `CustomInput` (59 L), `BottomTab.tsx` (**0 bytes**), plus `dashboard/QuickAccessGrid.tsx`, `dashboard/ScreenTimeChart.tsx`, `dashboard/UpcomingTasks.tsx` (**0 bytes**). |
| `src/context/` | `AuthContext.tsx` (Firebase Auth + Firestore profile), `ThemeContext.tsx` (light/dark, persisted to Firestore). **The only state management in the app.** |
| `src/services/` | `firebase.ts` (7 L — just re-exports `auth`, `firestore`), `GeminiService.ts` (95 L — direct Gemini REST call), `NotificationService.ts` (130 L — notifee local/trigger facade). **No HTTP client, no API abstraction.** |
| `src/constants/colors.ts` | 8 tokens. `primary: '#20B2AA'`. |
| `src/types/navigation.ts` | `RootStackParamList` — **duplicated** from `App.tsx`. Only 3 screens import it. |
| `assets/` | `icon.png`, `adaptive-icon.png`, `splash-icon.png`, `favicon.png`, `snack-icon.png` (unused). Note `adaptive-icon.png` and `splash-icon.png` are byte-identical (both 17,547 B). |
| `android/` | **Committed bare Android project** (prebuild output). 89 tracked files include the full `android/` tree. **No `ios/` directory exists at all.** |
| `.github/workflows/ci.yml` | 40 lines. `npm ci --legacy-peer-deps` → `npx tsc --noEmit` → secret grep → `npm audit --audit-level=high`. **The secret grep currently fails.** |
| `components/AssetExample.js` | Dead Snack demo, plain JS, zero imports. |
| `Untitled file.js` | **0 bytes**, tracked at repo root. |
| `ease-out/` | **Empty directory in the worktree; tracked in git as mode `160000` (gitlink) with no `.gitmodules`.** Broken submodule entry. |
| `node_modules/` | **Absent.** |

### There are no hooks, utilities, API routes, or tests

Zero `src/hooks/`. Zero `src/utils/`. Zero API/backend code in this repo. Zero test files. Zero `__tests__`. No `babel.config.js`, `metro.config.js`, `.eslintrc`, `.prettierrc`, `jest.config`, `eas.json`, `firebase.json`, or Firestore rules/indexes.

---

## 2. Current application state

### Implemented (real, Firestore-backed, actually works)

1. **Firebase email/password auth** — signup, login, logout, session restore via `onAuthStateChanged`, `users/{uid}` profile doc, profile-photo upload to Firebase Storage + `updateProfile` (`AuthContext.tsx`).
2. **Theme** — light/dark with Firestore-persisted preference (`ThemeContext.tsx`).
3. **Job Tracker** — realtime `onSnapshot` on `users/{uid}/jobs`, create, 5-state status transitions, delete, detail modal (`JobTrackerScreen.tsx`).
4. **Calendar** — month grid, `calendar/{YYYY-MM-DD}/tasks` subcollection, add/toggle/delete.
5. **Projects CRUD**, **Profiles CRUD** (+ outbound `Linking.openURL`), **Study topics CRUD** (+ default roadmap), **Custom Spaces CRUD** (workspaces + nested tasks).
6. **Password vault** — CRUD, clipboard copy, show/hide, CSV import → Firestore `batch()`.
7. **Dashboard** — greeting, avatar, cross-collection search over 5 collections, "Today's Priorities" aggregation, screen-time bar chart, quick-access grid, custom floating bottom nav.
8. **Account** — photo picker, dark-mode toggle, logout.
9. **Local notifications** — permission request, channel creation, immediate display, trigger-schedule API, cancel API.
10. **Crashlytics boundary** — `getDerivedStateFromError` + `recordError` + `log`.
11. **Gemini service** — prompt builder + API call + response line-parser.

### Partially implemented

| Area | State |
|---|---|
| **AI features** | `GeminiService` is a complete, working module. **Both call sites pass a fake key** (`'AIzaSyDummyReplaceMe'`) and swallow the error: `catch { /* silently skip if key not set */ }` (`DashboardScreen.tsx:168`). The AI-plan UI **always** renders the empty state. Functionally dead. |
| **Notifications** | Service is complete and clean. But `scheduleDeadlineNotification`, `cancelNotification`, and `parseDeadlineToDate` have **zero call sites** (verified by grep across `src/` + `App.tsx`). **No job deadline ever produces a notification.** The only live notification is the AI-plan one — which is itself dead. |
| **Password CSV import** | Implemented but **will throw at runtime.** See Risk C2. |
| **Notifications toggle** | `AccountScreen.tsx:16` — local `useState` only. Not persisted, not wired to `NotificationService`. |
| **Account stats** | Renders literal `"—"` (`AccountScreen.tsx:122-134`). |
| **Screen time** | Only accrues while `ScreenTimeChart` is mounted, i.e. only while on the Dashboard. |
| **Bottom nav highlighting** | `GoalsScreen` passes `activeRoute="Goals"`, `PasswordManagerScreen` passes `"PasswordManager"` — neither exists in `BottomNav`'s 4-item `NAV_ITEMS`, so **no tab is highlighted** on 5 of the 9 screens that use it. |

### Placeholder / demo

- `components/AssetExample.js`, `Untitled file.js`, `src/components/BottomTab.tsx`, `src/components/dashboard/UpcomingTasks.tsx`, `ease-out/` — all dead, three are 0 bytes.
- `README.md` — **still the verbatim Expo Snack template.** No project docs whatsoever.
- Hotlinked third-party images: `img.freepik.com` in `WelcomeScreen:21`, `LoginScreen:59`, `SignupScreen:70`; `i.pravatar.cc` in `DashboardScreen:252`, `AccountScreen:106`.
- `.github/workflows/ci.yml` — its "Check for hardcoded secrets" step greps for `AIzaSy` in `src/`. Both `DashboardScreen.tsx:19` and `GoalsScreen.tsx:12` contain it → **this step exits 1 on current `main`.** The single commit message claims "security hardening"; the gate it added is red.

### Not implemented

Job intake from shared/pasted text · resume library · resume matching · resume improvement suggestions · draft outreach generation · review/approval queue · any Vercel API client · **any environment-variable mechanism whatsoever** · push token registration · Telegram · share target · deep links · local/offline persistence · tests · lint · formatting · iOS target · Firestore security rules or indexes.

### Specific answers

- **Authentication:** Yes — Firebase Auth, email/password only. No Google sign-in, no Apple sign-in, no biometric re-auth, no session expiry handling.
- **Persistent storage:** **Firestore only**, as the sole datastore. Realtime listeners per screen. **No AsyncStorage, no SQLite, no MMKV, no SecureStore.** Theme pref is persisted to Firestore rather than locally. There is **no offline cache** — every screen is empty when offline.
- **API/backend:** None in this repo.
- **Notification infrastructure:** Partial — see §9.
- **Share functionality:** None.
- **Job tracking:** A basic CRUD tracker exists (`JobTrackerScreen.tsx`). It has no intake, no resume, no matching, no draft, no approval, no Gmail linkage, no reminders, and its schema does not match the Sheet (see §6).

---

## 3. Technology audit (observed, not assumed)

### Versions — declared vs. resolved

| Package | `package.json` | Lockfile | Assessment |
|---|---|---|---|
| `expo` | `~54.0.33` | **54.0.33** | SDK 54 |
| `react` | `19.1.0` | 19.1.0 | ✅ |
| `react-native` | `0.81.5` | 0.81.5 | ✅ correct for SDK 54 |
| `typescript` | `~5.9.2` | 5.9.3 | ✅ |
| `@react-navigation/native` | `7.1.28` | 7.1.28 | pinned |
| `@react-navigation/native-stack` | **`*`** | 7.14.7 | ⚠️ floating |
| `@react-native-firebase/{app,auth,crashlytics,firestore,storage}` | `^23.8.8` | 23.8.8 | native modules |
| `@notifee/react-native` | `^9.1.8` | 9.1.8 | local notifications |
| `expo-blur` | `~15.0.8` | 15.0.8 | ✅ SDK 54 |
| `expo-clipboard` | `~8.0.8` | 8.0.8 | ✅ SDK 54 |
| `expo-document-picker` | `~14.0.8` | 14.0.8 | ✅ SDK 54 |
| **`expo-image-picker`** | `^55.0.13` | **55.0.13** | ❌ **SDK 55 package in an SDK 54 app.** SDK 54 = `17.x` |
| **`expo-notifications`** | `^55.0.13` | **55.0.13** | ❌ **SDK 55 package.** SDK 54 = `0.32.x`. Also **0 imports** |
| `expo-status-bar` | `~3.0.9` | 3.0.9 | ⚠️ **0 imports** |
| **`expo-file-system`** | **ABSENT** | 19.0.21 (transitive via `expo`) | ❌ **phantom dependency** |
| `react-native-paper` | `4.9.2` | 4.9.2 | ⚠️ **0 imports** |
| `papaparse` | `*` | 5.5.3 | ⚠️ **0 imports** — hand-rolled CSV parser used instead |
| `react-native-calendars` | `*` | 1.1314.0 | floating |
| `react-native-chart-kit` | `*` | 6.12.0 | floating |
| `react-native-svg` | `15.12.1` | 15.12.1 | transitive peer of chart-kit |

*Verified against the npm registry: `expo-notifications` SDK-54 line is `0.32.17`; `expo-image-picker` SDK-54 line is `17.0.11`.*

### Stack summary

- **Language:** TypeScript, `strict: true`, `.tsx` throughout. Exactly one stray `.js` file (`components/AssetExample.js`, dead).
- **Navigation:** **React Navigation v7 `native-stack`. NOT Expo Router.** One flat stack, `headerShown: false` globally, no tabs, no nested stacks. Bottom nav is a hand-rolled `position: 'absolute'` view inside each screen.
- **Styling:** `StyleSheet.create` per screen. Two competing systems: static `colors.ts` + runtime `ThemeContext` tokens. No NativeWind / Tamagui / styled-components.
- **State management:** React Context + `useState` only. No Redux / Zustand / Jotai / MobX / React Query.
- **Storage / DB:** Cloud Firestore, exclusively.
- **Networking:** bare global `fetch`. No axios, no React Query, no client abstraction.
- **Notifications:** `@notifee/react-native` (local + trigger). `expo-notifications` installed but unused.
- **Sharing:** none.
- **Icons / UI:** `@expo/vector-icons` (Ionicons) only. `react-native-paper` installed but unused.
- **Testing:** **none.** No jest, no testing library, no test files.
- **Linting/formatting:** **none.** CI runs only `npx tsc --noEmit`.
- **Build config:** static `app.json`; committed `android/` (bare/prebuild); **New Architecture on**; Hermes on; edge-to-edge on. **No `ios/`.**

---

## 4. Important files

Ordered by how much you must understand before writing code.

| File | Lines | What it does | Touch? | Extension point |
|---|---|---|---|---|
| **`App.tsx`** | 150 | Navigation graph, auth gate, error boundary, duplicate param list | **Leave alone except to register routes** | Add `JobPipeline`, `Intake`, `ResumeLibrary` `Stack.Screen`s. **Fix the duplicated type by importing from `src/types/navigation.ts`.** |
| **`src/types/navigation.ts`** | 15 | Canonical `RootStackParamList` | Safe to edit | **Every new route goes here.** Make this the single source of truth. |
| **`src/context/AuthContext.tsx`** | 112 | Firebase session + profile | **Leave alone** | Nothing needed for job features. Note the listener leak at line 41. |
| **`src/context/ThemeContext.tsx`** | 96 | Light/dark tokens, Firestore-persisted | Safe to read; avoid changing | All new UI should consume `useTheme()`. |
| **`src/services/firebase.ts`** | 7 | Re-exports `auth`, `firestore` | Safe to extend | The `firestore` export is the seam a new repository layer would use. |
| **`src/services/NotificationService.ts`** | 130 | notifee facade: permission, channel, immediate, trigger, cancel | **Best-structured service in the repo.** Safe to extend | `scheduleDeadlineNotification` is already written and unused — **wire it to the new Job model rather than rewriting it.** |
| **`src/services/GeminiService.ts`** | 95 | Direct Gemini REST call with caller-supplied key | **⚠️ Must be removed before any AI work.** This is the anti-pattern | Its prompt-building discipline is worth keeping; its transport must be deleted. |
| **`src/screens/features/JobTrackerScreen.tsx`** | 265 | Existing CRUD tracker. **Takes no props at all** — no `navigation`, no `BackHeader`, no `BottomNav` → **dead-end screen with no visible exit** | **Recommend leaving untouched** and building a parallel screen | Reference for card/badge/modal patterns only. Its `JobApplication` interface is the wrong shape (§10). |
| **`src/screens/DashboardScreen.tsx`** | 465 | Hardcoded Gemini key; cross-collection search; priorities aggregation | **⚠️ Line 19 must go.** Otherwise leave alone | Priority aggregation will eventually read the new pipeline stages. |
| **`src/components/BottomNav.tsx`** | 123 | Hand-rolled absolute-positioned tab bar | Leave alone for now | Will need a real tab navigator eventually. |
| **`src/components/BackHeader.tsx`** | 46 | Themed back header | **Reuse as-is** for every new screen | ✅ Direct reuse |
| **`src/constants/colors.ts`** | 8 | Static tokens | Safe | Reconcile with the `#24B6B8` hardcodes. |
| **`android/app/src/main/AndroidManifest.xml`** | 25 | **Single intent-filter (MAIN/LAUNCHER).** No `ACTION_SEND`. No share/deep-link filters. No `POST_NOTIFICATIONS` | Must change for Share-to-Tracker (§7) | Add `ACTION_SEND` + `text/plain`; add `queries` for `SEND` |
| **`app.json`** | 31 | Static Expo config, no plugins/scheme/extra | Must become `app.config.ts` for env vars (§8) | `plugins`, `scheme`, `extra` |
| **`.github/workflows/ci.yml`** | 40 | Only quality gate — **currently red** | Must fix before anything else | Add a real secret-allowlist mechanism |
| **`src/screens/features/PasswordManagerScreen.tsx`** | 267 | Contains the **runtime-throwing** FileSystem import | Bug to fix; otherwise leave alone | — |

---

## 5. Existing architecture (as observed)

```text
PassX-Easeout  (Expo SDK 54 / RN 0.81.5 / New Arch / Android-only bare)
│
├── index.ts ──► App.tsx
│                  │
│                  └── CrashlyticsErrorBoundary (class, inline)
│                        │
│                        └── AuthProvider ──────────────┐  Firebase Auth (email/password)
│                              │                        │  Firestore users/{uid}
│                              └── ThemeProvider ──────┤  Firestore preferences.darkMode
│                                    │                │
│                                    └── NavigationContainer
│                                          │
│                                          └── RootNavigator  (auth gate: user == null ?)
│                                                │
│                                                ├── [auth]  Welcome → Login ⇄ Signup
│                                                │
│                                                └── [app]   Dashboard (root)
│                                                             ├── CalendarScreen ─┐
│                                                             ├── ProjectsScreen        │
│                                                             ├── AccountScreen         │ each screen
│                                                             ├── PasswordManagerScreen │  owns its own
│                                                             ├── JobTrackerScreen      │  realtime
│                                                             ├── GoalsScreen           │  onSnapshot +
│                                                             ├── StudyPlannerScreen    │  local useState
│                                                             ├── ProfilesScreen        │
│                                                             └── CustomSpacesScreen   ─┘
│
├── "Bottom nav"  ── NOT navigation. A <View position:absolute> inside each screen.
│                   4 items + centre FAB → CustomSpaces. Rendered by 7 screens.
│                    Absent from JobTrackerScreen and AccountScreen.
│
├── State
│   ├── Context:  AuthContext, ThemeContext        (the ONLY global state)
│   └── Screen-local useState everywhere else.    No store, no server-state cache.
│
├── Services (src/services/)
│   ├── firebase.ts          → re-export { auth, firestore }
│   ├── NotificationService  → @notifee  (local + trigger) ⚠️ scheduling never called
│   └── GeminiService        → fetch() DIRECT to generativelanguage.googleapis.com
│                              with ?key= from a hardcoded literal   ⚠️⚠️
│
├── Persistence ── Cloud Firestore ONLY. No local cache, no offline.
│   └── users/{uid}/
│         ├── (profile, preferences)
│         ├── jobs/                    ← Job Tracker
│         ├── calendar/{YYYY-MM-DD}/tasks/
│         ├── aiPlan/{YYYY-MM-DD}/
│         ├── studyTopics/  projects/  profiles/
│         ├── passwords/                ← PLAINTEXT
│         ├── spaces/{id}/tasks/
│         └── screenTime/{YYYY-MM-DD}/
│
├── Native
│   ├── android/  (committed; google-services + crashlytics gradle plugins)
│   └── ios/      ── DOES NOT EXIST
│
└── External network calls (outbound, from the device)
    ├── Firebase Auth / Firestore / Storage
    ├── Crashlytics
    ├── generativelanguage.googleapis.com   ⚠️ key in query string, from client
    ├── img.freepik.com, i.pravatar.cc      (hotlinked images)
    └── ── NO call to the jobemailer Vercel system exists ──
```

**There is no `jobemailer` connection in this repo.** Zero references to `/api/rpc`, Vercel, Apps Script, or Sheets.

---

## 6. Job Tracker integration assessment

### Where a Job Tracker already is

`src/screens/features/JobTrackerScreen.tsx`, registered as route `JobTracker` in `App.tsx:124`. Reached from `QuickAccessGrid` (`QuickAccessGrid.tsx:9`) and from Dashboard priorities (`DashboardScreen.tsx:115`).

### Recommendation: build a **new, parallel screen** — do not extend the existing one

Extending `JobTrackerScreen.tsx` in place would require rewriting its interface, its status enum, its detail modal, and its Firestore writes simultaneously. A parallel `JobPipeline` screen leaves the working tracker untouched and gives the AI agent a clean, correctly-shaped surface.

- **Likely location:** `src/screens/JobPipelineScreen.tsx` (top-level `src/screens/`), registered in `App.tsx` **and** `src/types/navigation.ts`.
- **Navigation changes:** add 2–4 entries to `RootStackParamList`; add matching `Stack.Screen`s inside the authenticated branch (`App.tsx:120-133`). Optionally add a `QuickAccessGrid` tile. **No structural navigation change is required** — the existing flat stack accommodates this.
- **Do not** put it behind the custom `BottomNav`; that component's item list is hardcoded and its `activeRoute` prop already mis-highlights on 5 screens.

### Reusable components that exist

| Component | Reuse quality |
|---|---|
| `BackHeader` | ✅ Excellent — themed, `rightElement` slot for actions |
| `useTheme()` | ✅ Use for all colors; do **not** use `colors.ts` directly (breaks dark mode) |
| `BottomNav` | ⚠️ Works, but adds the absolute-position/edge-to-edge problems |
| `CustomButton` / `CustomInput` | ⚠️ Hardcode `colors.*`, ignore theme — dark-mode-broken |
| Card / badge / modal / empty-state `StyleSheet` blocks | ❌ Not extracted; must be copy-adapted. Copy-paste is the existing house style, unfortunately. |

### Components that would need to be created

`JobCard` (with stage badge) · `StageBadge` · `IntakeTextArea` (multiline paste target) · `FieldEditor` (label + value + confidence indicator + "was extracted / you edited this") · `ResumePicker` (ranked list with match score) · `DraftEditor` (message + subject, editable, with a modified flag) · `ApprovalBar` (the hard human gate — disabled until required fields validate) · `DeadlineChip` · `EmptyState` · `SyncBadge` (Firestore ⇄ Sheet state).

### State / data layer

**None exists.** Every screen talks to Firestore directly, inline, in a `useEffect`. There is no repository pattern, no data-access layer, no query abstraction.

**Recommendation:** introduce `src/domain/job.ts` (types + enums, zero imports) and `src/data/jobs/` (a `JobsRepository` interface + a Firestore implementation). Screens depend on the interface, not on Firestore. This is the single highest-leverage structural change, because it is what lets you later add a Vercel-backed implementation without touching screens.

### Is local storage sufficient initially?

**Yes — and no.** Specifically:

- Firestore is already the live datastore and gives realtime sync for free, so a Firestore-backed repository is sufficient for v1 of the pipeline.
- But **offline capture matters** for this product: the core flow is "see a job on LinkedIn → capture it," and users are frequently offline or on poor data. A local write-ahead buffer is genuinely valuable. Currently there is **no AsyncStorage / SQLite / MMKV in the project at all**, so this would be a new capability.
- **Recommendation:** ship Firestore-first. Add an offline outbox later. Do not introduce SQLite in the first cut.

### Should the app eventually talk to Vercel directly?

**Yes for reads of legacy state; no for anything privileged.** See §8 and §12 — the existing `/api/rpc` has **no caller authentication**, which is a blocker (Risk C5).

### Does a backend abstraction already exist?

**No.** `src/services/` has no HTTP client, no base-URL config, no auth, no error normalization, no request/response types. This must be built.

---

## 7. Share-to-tracker assessment

### Is the current Expo project technically prepared? **No.**

| Capability | Observed state |
|---|---|
| React Native `Share` API | ❌ Not imported anywhere in `src/` or `App.tsx` |
| `expo-sharing` | ❌ Not in `package.json` |
| Android share intents | ❌ `AndroidManifest.xml` has **exactly one** `<intent-filter>`: `MAIN`/`LAUNCHER`. No `android.intent.action.SEND`, no `android.intent.category.DEFAULT`, no `text/plain` mime type |
| Android `<queries>` | ⚠️ Declares only `VIEW` + `BROWSABLE` + `https`. Nothing for `SEND` (needed on Android 11+ for share-target discovery) |
| iOS share extensions | ❌ **Impossible — no `ios/` directory exists at all** |
| Deep linking | ❌ No `scheme` in `app.json`; no `Linking.getInitialURL`; no `Linking.addEventListener('url', …)` anywhere |
| Universal / App Links | ❌ No `intentFilters`, no `associatedDomains`, no `assetlinks.json` |
| **Clipboard** | ✅ **`expo-clipboard@8.0.8` is installed and already used** (`PasswordManagerScreen:10,137`, `ProfilesScreen:8,102`) |
| URL handling (outbound) | ⚠️ Only `Linking.openURL(item.link)` in `ProfilesScreen:146` |
| URL handling (inbound) | ❌ None |

**One important constraint:** `expo.modules.updates.ENABLED` is `false` in the manifest, and share intents **cannot be received in Expo Go at all** — any share-target work requires `expo run:android` against the committed `android/` folder. The committed bare Android project means this path is available, but it is real native work with a native build loop.

### Simplest viable approach, in order

**V0 — Clipboard paste (recommended first).** Works today with **zero native code**. User long-presses → Copy in LinkedIn/X/browser → opens the app → Intake screen calls `Clipboard.getStringAsync()`. `expo-clipboard` is already a dependency. This also matches the existing external dashboard's UX exactly (paste → parse → review → confirm), so the two halves of the product feel identical. **This is the right first move.**

**V1 — Android share target.** Add an `ACTION_SEND` + `text/plain` intent-filter to `MainActivity`, add `SEND` to `<queries>`, read `intent.extraText`, hand off to the Intake screen. Moderate effort; requires a dev build; not verifiable in Expo Go.

**V2 — iOS Share Extension.** Requires generating `ios/`, a Share Extension target, and an App Group for shared state. High effort. **Defer — there is no iOS target in this repo at all.**

**Deep linking** is not required for any of V0–V2 and should be deferred.

---

## 8. API integration assessment

### Does an abstraction exist that could support Vercel?

**No.** Concretely, `src/services/` contains three files:

- `firebase.ts` — two re-exports. Not an abstraction; a convenience alias.
- `NotificationService.ts` — a **good** facade over a local-only capability. Genuinely reusable as a *shape* precedent, but not an HTTP abstraction.
- `GeminiService.ts` — **actively harmful as a precedent.** It is a direct client→provider call with a caller-supplied key interpolated into the query string. This is precisely the pattern that must not be repeated for Claude.

There is no HTTP client, no base URL, no auth, no interceptor, no timeout, no retry, no error normalization, and no request/response types.

### Where API URLs and env vars should eventually live (recommendation)

```text
app.config.ts                        ← NEW; becomes the config entry, replaces static app.json
  └─ reads process.env.EXPO_PUBLIC_* at build time
  └─ exposes them via extra: { apiBaseUrl, … }

src/config/env.ts                    ← NEW; single module that reads Constants.expoConfig.extra
  └─ validates required keys  └─ throws loudly at boot if missing
  └─ THE ONLY FILE permitted to touch process.env or Constants

src/api/client.ts                    ← NEW; owns base URL, timeouts, JSON, error normalization
src/api/jobs.ts                      ← feature clients; use client.ts only
src/api/intake.ts
src/api/resumes.ts
```

**Hard rule:** the `EXPO_PUBLIC_` prefix must be reserved **exclusively** for non-secret values — in practice, only the Vercel base URL. `ANTHROPIC_API_KEY` must exist **only** as a Vercel environment variable, read only inside `api/*.js` on the server, and must never appear in `app.json`, `app.config.ts`, `package.json`, or any file under `src/`.

### Where the Claude logic should live: **not in this repo**

This repository is the mobile client. The AI layer belongs in the `jobemailer` Vercel project as new route(s) beside `api/rpc.js` — e.g. `api/intake.js`, `api/match.js` — reusing its established pattern (`api/rpc.js:1` `process.loadEnvFile('.env')`, `api/rpc.js:7` env-only secrets, `api/rpc.js:11` server-side token injection). This keeps the mobile app and the legacy mailer in one deployable and avoids creating a third service.

### ⚠️ Blocker discovered in the external system

`jobemailer/api/rpc.js` performs **no caller authentication whatsoever**. It accepts any POST, injects the Apps Script token server-side, and forwards. Anyone who learns the Vercel URL can call `action: 'send'`. That is fine for a private browser dashboard you open yourself. **It is not acceptable as a public mobile API** — a shipping APK's endpoint is public knowledge. Before the app calls it, `/api/rpc` (or a new sibling route) needs caller auth: Firebase ID token verification is the natural choice, since the app already has Firebase Auth.

---

## 9. Notification assessment

| Question | Observed answer |
|---|---|
| Expo push notifications configured? | **No.** `expo-notifications@55.0.13` is installed (wrong SDK line) and has **zero imports**. No `plugins` entry in `app.json`. `getExpoPushTokenAsync` / `getDevicePushTokenAsync` are never called. No `projectId`, no EAS config, no FCM/APNs setup. |
| Device token registration? | **None.** No `notifee.getToken()`, no token document in Firestore, no registration call anywhere. |
| Notification permissions handled? | **Partially, and poorly.** `requestNotificationPermission()` is called once at `App.tsx:101` on app mount — before login, unconditionally, before the user has seen any reason to allow notifications. Its boolean return is **discarded**. There is no rationale flow, no "why we need this", no handling of denial, no deep-link to system settings. `POST_NOTIFICATIONS` is not declared in the tracked manifest (it arrives via notifee's manifest merge). |
| A notification service abstraction? | **Yes, and it's the best one in the repo.** `src/services/NotificationService.ts` — clean functional API, correct channel setup (`easeout_reminders`, HIGH importance), and errors are caught and warned rather than thrown. This is the right place to add reminder logic. |
| Background tasks? | **None.** No `expo-background-task`, no `expo-task-manager`, no `TaskManager`, no headless JS, no WorkManager. `expo.modules.updates.ENABLED` is `false`. Notifee `TimestampTrigger`s are the only mechanism that survives process death — and those only work once the app has been opened after scheduling. |
| Scheduled / local notifications? | **API exists; zero usage.** `scheduleDeadlineNotification`, `cancelNotification`, and `parseDeadlineToDate` have **no call sites** (grep-verified). There is **no code path from any Job deadline to any notification** — the tracker stores `deadline` as a free-text string and never touches the notification service. Separately, `parseDeadlineToDate` is unsuitable for AI-extracted deadlines, which should be real ISO dates rather than `"tomorrow"`. |

**Practical implication:** local deadline reminders are the cheapest win in the whole roadmap — the code is already written and unused. It needs a typed `deadline: string /* ISO */` field (see §10) and a call site. Push and Telegram should come much later.

---

## 10. Proposed Job Tracker data model

> **This is a recommendation, adapted from what was found — not an implementation.**

Three observed facts drove the shape:

1. The current mobile model is `{companyName, role, link, deadline, status, notes}`.
2. The Sheet model is `{id, company, contactName, contactEmail, role, jobLink, source, location, notes, trigger, emailSentOn, status, followUpTrigger, followUpSentOn, followUpStatus, threadId}`.
3. **`id` in the Sheet is the row number, and `del_()` calls `s.deleteRow(id)` — so every delete shifts all subsequent row numbers.** A row number is **not a stable identifier** and must never be used as a primary key.

The model therefore separates **agent-owned fields** (the AI pipeline writes these) from **Sheet-mirror fields** (Apps Script owns these; the app reads them).

```text
Job                                     ← Firestore users/{uid}/jobs/{jobId}
│
├── id                                  Firestore doc id. App-generated. STABLE.
├── schemaVersion                       1
├── dedupeKey                           normalized company|role|host(jobUrl)
│                                      survives Sheet row shifts; the real join key
│
├── ── Intake (agent-owned) ────────────────────────────────────────────
├── rawText                             exact pasted/shared text, verbatim
├── rawSource                           'paste' | 'share_android' | 'manual' | 'email'
├── capturedAt
├── intakeStatus                        'unparsed' | 'parsed' | 'needs_review' | 'confirmed'
├── fieldConfidence                     { company: 0.98, contactEmail: 0.41, … }
│
├── ── Structured job (agent-owned, mirrors Sheet cols 1-8) ───────────
├── company                             ← Sheet col 1
├── contactName                         ← Sheet col 2
├── contactEmail                        ← Sheet col 3   ⚠️ PII
├── role                                ← Sheet col 4
├── jobUrl                              ← Sheet col 5   (renamed from `link`)
├── source                              ← Sheet col 6   vocabulary: LinkedIn|X|Email|Referral|Other
├── location                            ← Sheet col 7
├── notes                               ← Sheet col 8
├── deadline                            ISO-8601 string | null
│                                      ⚠️ THE SHEET HAS NO DEADLINE COLUMN.
│                                      Decide: add a col 16, or keep it mobile-only.
├── deadlineSource                      'extracted' | 'user_entered' | 'unknown'
├── contactEmailSource                  'extracted' | 'user_entered' | 'unknown'
│
├── ── Resume matching ─────────────────────────────────────────────────
├── selectedResumeId                    → resumes/{resumeId} | null
├── matchScore                          0..100 | null
├── matchBreakdown                      { mustHave, niceToHave, seniority } | null
├── resumeSuggestions                   ResumeSuggestion[]  (PROPOSED edits, never auto-applied)
│
├── ── Outreach draft ──────────────────────────────────────────────────
├── draftMessage
├── draftSubject
├── draftGeneratedAt
├── draftEditedByHuman                  boolean  (true the moment a human types)
│
├── ── Approval gate (HARD REQUIREMENT) ────────────────────────────────
├── approvalStatus                      'draft' | 'pending_review' | 'approved' | 'rejected'
├── approvedAt
├── approvedBy                          uid
│                                      Apps Script `send`/`sendFollowUp` must be
│                                      UNREACHABLE unless this === 'approved'.
│
├── ── Sheet mirror (Apps-Script-owned; app reads, rarely writes) ─────
├── sheetRowId                          int | null   ⚠️ UNSTABLE across deletes — cache only
├── sheetSyncStatus                     'never' | 'pending' | 'synced' | 'conflict' | 'error'
├── sheetSyncedAt
│
├── ── Application lifecycle (Sheet cols 9-15) ────────────────────────
├── applicationStatus                   superset of the Sheet vocabulary; needs an
│                                      explicit mapping table (see Risk M4)
├── gmailThreadId                       ← Sheet col 15
├── emailSentOn                         ← Sheet col 10
├── followUpStatus                      'none' | 'due' | 'sent'
├── followUpCount                       int (Sheet tracks only the latest — this is better)
├── followUpLastSentAt
│
├── ── Reminders ───────────────────────────────────────────────────────
├── reminderDeadlineNotifId             string | null  → NotificationService notifId
├── nextReminderAt                      ISO | null
│
└── ── Timestamps ──────────────────────────────────────────────────────
    ├── createdAt
    ├── updatedAt
    └── archivedAt                      soft delete; `delete_()` in the Sheet is a hard
                                        deleteRow and renumbers everything
```

### Changes from the originally proposed list, and why

- **`selectedResume` → `selectedResumeId`** (an ID, not an embedded object — the Resume Library is a separate cache; see §11).
- **Added `dedupeKey`.** Because Sheet row IDs shift on delete, a content-derived key is needed to reconcile the two systems. The existing system already has `duplicate_()` logic; `dedupeKey` mirrors it.
- **Added `approvalStatus` + `approvedAt` + `approvedBy`** as a first-class, separate field from `applicationStatus`. The human-approval hard requirement should be representable in the data model itself, not just in UI logic — so the gate survives a refactor, a new client, or a bug.
- **Split intake / structured / matching / draft / mirror / lifecycle** into explicit groups, because **three different systems write to this record** (the app, the AI layer, and Apps Script). Without explicit ownership the record will drift.
- **Added `draftEditedByHuman`** so the AI never silently overwrites a human edit.
- **`archivedAt`** instead of hard delete.
- **Kept `rawText`** — it's what you re-run intake against when extraction improves.

### ⚠️ Open question requiring a decision

The mobile `JobStatus` enum (`Applied / No Response / Interview / Rejected / Offer`) and the Sheet's status vocabulary (matched by regex `/^sent/i` and `/(sent|failed|skipped|blocked)/i` in `Code.gs:551`) **do not overlap meaningfully**. `Applied` matches neither. **A mapping table is required before these two systems ever exchange status.**

---

## 11. Resume Library integration

### What the mobile app actually needs

**Only metadata. Never the PDF.**

```text
ResumeSummary                        ← a projection, not the document
├── resumeId                         stable key used in Job.selectedResumeId
├── resumeLabel                      "Backend — Go — v3"
├── targetRole                       "Backend Engineer"
├── targetRoleFamily                 'backend' | 'frontend' | 'devops' | 'data' | …
├── version                          int or semver
├── isDefault                        boolean
├── keywords[]                       for cheap local pre-filtering BEFORE calling the AI
├── driveFileId                      OPAQUE TOKEN — never a URL, never downloaded
├── driveOwner                       'me'  → implies the server holds the Drive auth
├── updatedAt
└── lastUsedAt
```

The app needs `resumeId`, `resumeLabel`, `targetRole`/`keywords` (to render a ranked list and to pre-filter), and `matchScore` **per job** (which lives on the Job, not on the resume). `driveFileId` is a reference the app **hands to the server** and never dereferences.

### Where this enters the architecture

```text
Google Drive (PDFs) +  Google Sheet (index/cache)
        │
        │  server-side only — Drive auth never reaches the device
        ▼
Vercel  ── api/resumes.js        ← NEW route, lives in jobemailer, reads its own Sheet
        │     returns ResumeSummary[] (NO driveFileId exposed to unauthenticated callers
        │                                     unless caller auth proves the user)
        ▼
PassX-Easeout
        └── src/api/resumes.ts   → fetch summaries
              └── ResumeLibraryScreen  → ranked list, select, compare
                    └── Job.selectedResumeId  ← the only thing persisted on the Job
                          │
                          ▼
              "Send application" → Vercel → Apps Script → Gmail
              (Apps Script already resolves RESUME_LINK / RESUME_FILE_ID server-side
               in Code.gs:24-25 — the PDF never enters the app)
```

**The good news, observed:** `Code.gs:25` already has `RESUME_FILE_ID` and `getResumeBlob_()` at `Code.gs:178`, and `RESUME_LINK` at `Code.gs:24` is always in the email body. **The attachment pipeline already exists and works.** The app never needs to touch a PDF.

**Recommendation:** the Resume Library screen should be **read-only in the app.** Editing resumes is a Drive/Sheets activity, done on desktop. A mobile resume *editor* would be a large, wrong-scope project.

---

## 12. Security and secrets (boundaries only — no hardening implemented)

### Client-side (untrusted — ships inside the APK/JS bundle, readable by anyone who unzips it)

Everything in `src/`, `App.tsx`, `index.ts`, `app.json`, and `android/`.

### Server-side (trusted)

`jobemailer/api/*.js` — i.e. `api/rpc.js` on Vercel.

### Secrets — must exist server-side only

| Secret | Where it is now | Where it must be |
|---|---|---|
| Anthropic / Claude API key | *nowhere* | Vercel env var, read only in `api/*.js` |
| `APPS_SCRIPT_TOKEN` | ✅ `jobemailer/.env` (gitignored) | stays there |
| `APPS_SCRIPT_URL` | ✅ `jobemailer/.env` (gitignored) | stays there |
| `DASHBOARD_API_TOKEN` (Apps Script property) | ✅ Apps Script project | stays there |
| Telegram bot token | *nowhere* | Vercel env var |
| Google service-account JSON | *nowhere* | Vercel env var |
| **Gemini API key** | ❌ **`src/screens/DashboardScreen.tsx:19` and `src/screens/features/GoalsScreen.tsx:12`, hardcoded literal** | **must be deleted from client code** |

### 🔴 Currently violating the boundary

`GeminiService.ts:68` calls `https://generativelanguage.googleapis.com/...?key=${apiKey}` **directly from the device**. Even though the value is the dummy `AIzaSyDummyReplaceMe`, **the pattern is exactly the one that must never be repeated with Claude**: a key literal in `src/`, shipped in the bundle, with the key in the URL. This must be removed *before* any AI work begins — otherwise it becomes the copy-paste template for the Claude integration.

### Public / semi-public configuration (not secrets)

- `google-services.json` — ships in the APK by design. Not a secret. It is currently gitignored and absent, so `@react-native-firebase` and notifee cannot initialize on a fresh clone.
- The Vercel base URL — public by nature. Only the *path* to AI endpoints should be non-guessable, not the host.
- `app.json` contents, `assets/`, iconography.

### Sensitive data currently handled in the client

- **Plaintext passwords in the Firestore `passwords` collection** (`PasswordManagerScreen.tsx:76-81`). No encryption, no hashing. A password manager that stores plaintext is the most serious data-handling issue found in this audit.
- `Contact email` will be PII once intake lands.
- `rawText` will contain whatever the user pastes — potentially their own correspondence.

### APIs that must NEVER be called directly from the mobile app

1. **Anthropic Messages API** — key would be extracted from the bundle.
2. **Google Apps Script `/exec` URL** — `DASHBOARD_API_TOKEN` lives in the script; calling `/exec` from the app exposes an unauthenticated mail trigger.
3. **Telegram Bot API `sendMessage`** — the bot token is the credential.
4. **Google Drive API with service-account credentials** — full account compromise.
5. **Firebase Admin SDK** — bypasses all security rules.

### ⚠️ Cannot be determined from this repository

**Firestore and Storage security rules do not exist in this repo** (`firebase.json`, `firestore.rules`, and `.rules` files are all absent). Therefore it **cannot be determined** whether the database is protected by console-managed rules or is effectively open. Either way, the rules are unreviewable and unversioned, which for a store holding passwords is unacceptable on its own. **This must be checked in the Firebase Console before any data model work begins.**

---

## 13. Risks and technical debt

### 🔴 Critical

| # | Issue | Evidence |
|---|---|---|
| **C1** | **CI is red on `main`.** The "Check for hardcoded secrets" step greps `src/` for `AIzaSy`; two files match → step exits 1. The repo's only quality gate fails, on the same commit that claims to have added hardening. | `.github/workflows/ci.yml:28-33`; verified by running the identical grep |
| **C2** | **Runtime crash in Password CSV import.** `import * as FileSystem from 'expo-file-system'` then `FileSystem.readAsStringAsync(...)`. In SDK 54 the modern FS API became the default root export and the old API moved to `expo-file-system/legacy`; the root-level `readAsStringAsync` is documented as **"Deprecated… This method will throw in runtime."** Additionally `expo-file-system` is a **phantom dependency** — absent from `package.json`, present in the lockfile only because `expo` depends on it. | `PasswordManagerScreen.tsx:9,96`; confirmed against Expo's SDK 54 changelog + docs |
| **C3** | **Wrong-SDK Expo packages.** `expo-notifications@55.0.13` and `expo-image-picker@55.0.13` are **SDK 55** packages in an **SDK 54** app (correct lines: `expo-notifications@0.32.x`, `expo-image-picker@17.x` — both verified against the npm registry). `expo-image-picker` **is** imported (`AccountScreen.tsx:8`) and calls the deprecated-and-in-55-removed `MediaPicker.MediaTypeOptions.Images`. | `package.json:24-25`; lockfile; Expo changelogs |
| **C4** | **Plaintext passwords in Firestore, with no rules file in the repo.** | `PasswordManagerScreen.tsx:76-81`; no `firestore.rules` anywhere |
| **C5** | **`jobemailer/api/rpc` has no caller authentication.** Any POST is forwarded with the Apps Script token injected server-side, including `action: 'send'`. Safe as a private dashboard; **unacceptable once a mobile app calls it**, because an APK's endpoint URL is public. | `jobemailer/api/rpc.js:5-25` |

### 🟠 High

| # | Issue |
|---|---|
| **H1** | **`google-services.json` absent** (gitignored) → `@react-native-firebase` auth/firestore/storage/crashlytics and notifee **cannot initialize**. A fresh clone cannot sign in, which means *nothing* works. |
| **H2** | **`android/app/debug.keystore` absent** (gitignored via `*.keystore`) but referenced by `android/app/build.gradle:120`. A fresh clone cannot assemble a debug build. |
| **H3** | **`node_modules` not installed and no documented setup steps.** `README.md` is the Snack template. The only build validation is CI. |
| **H4** | **Broken git submodule entry.** `ease-out` is tracked at mode `160000` with no `.gitmodules`; `git submodule status` fails with `fatal: no submodule mapping found`. |
| **H5** | **Firestore composite indexes missing** (no `firestore.indexes.json`). `DashboardScreen.tsx:99-104` uses `where('status','in',[…])` and `ScreenTimeChart.tsx:50-51` uses `where('date','in',[7 values])` — both require composite indexes and will throw `FAILED_PRECONDITION: missing index` at runtime. |
| **H6** | **Client-side Gemini key + direct provider call** — the anti-pattern that must not be copied for Claude. |
| **H7** | **No environment-variable mechanism at all.** Zero occurrences of `process.env`, `EXPO_PUBLIC_`, `expo-constants`, `Constants.expoConfig`, or `extra`. There is currently nowhere legitimate for an API URL to live, so Claude work would inevitably hardcode one. |
| **H8** | **Firestore ⇄ Sheet schema divergence, and Sheet row IDs are unstable.** `jobs_()` returns `id` = row number; `del_()` calls `deleteRow`, renumbering everything. Any sync keyed on `sheetRowId` alone will corrupt data. |
| **H9** | **`RootStackParamList` duplicated** — `App.tsx:31` and `src/types/navigation.ts:1`. `App.tsx` does not import the shared type. Divergence is a matter of time. |
| **H10** | **Silent error swallowing.** `DashboardScreen.tsx:168` (`catch { /* silently skip */ }`), `:235` (`catch {/* ignore */}`). Meanwhile `CalendarScreen.addTask`, `CustomSpacesScreen` and `StudyPlannerScreen` have `finally` blocks with **no `catch` at all** → unhandled promise rejections on write failure. |
| **H11** | **No tests, no lint, no format** — zero regression safety net on ~4,000 lines. |
| **H12** | **Listener leak in `AuthContext`.** `fetchUserProfile` returns an unsubscribe function, but the caller at `AuthContext.tsx:41` discards it. The `users/{uid}` Firestore listener is never torn down. (`ThemeContext` gets this right.) |

### 🟡 Medium

| # | Issue |
|---|---|
| **M1** | **StyleSheet duplication.** Every screen redeclares its own card/badge/input/modal/empty-state styles — roughly a third of total LOC. No shared UI kit. New screens will copy-paste, per house style. |
| **M2** | **`navigation: any` in 9 of 13 screens.** Type safety is lost exactly where routes matter. `JobTrackerScreen` takes **no props at all**. |
| **M3** | **Two competing color systems.** `colors.ts` `primary = #20B2AA` vs hardcoded `#24B6B8` in `App.tsx:91,106`, `WelcomeScreen:76`, `LoginScreen:163`, `SignupScreen:181`, `ScreenTimeChart:119`. |
| **M4** | **`BottomNav` is not navigation** — a `position:'absolute'` view inside each screen. Combined with `edgeToEdgeEnabled: true` and `paddingBottom: 100–120` fudge factors in 7 screens, it will clip on gesture-nav devices, break with the keyboard open, and cannot host a nested stack. Its `activeRoute` prop already mis-highlights on 5 screens. |
| **M5** | **Conditional stack in `App.tsx:114`** unmounts and remounts the entire tree on login/logout. No state preservation; not deep-link friendly. |
| **M6** | **Status vocabulary conflict** between mobile `JobStatus` and the Sheet's regex-matched statuses. No mapping layer. |
| **M7** | **Unused dependencies:** `expo-notifications` (also wrong-SDK), `react-native-paper`, `papaparse`, `expo-status-bar`. `papaparse` is installed while a hand-rolled `parseCSV` is used instead — and that hand-rolled parser is naive (splits on `,` with no quote handling, `PasswordManagerScreen:26-40`). |
| **M8** | **Dead files:** 3 tracked 0-byte files, 1 dead Snack demo, 1 broken gitlink. |
| **M9** | **`README.md` is the Snack template.** No onboarding, no Firebase setup, no env docs, no architecture. |
| **M10** | **Hotlinked third-party images** in Welcome/Login/Signup/Account/Dashboard — offline breakage, unvetted licensing, and a third-party privacy leak on every app open. |
| **M11** | **Release buildType uses `signingConfigs.debug`** (`android/app/build.gradle:139`) — cannot ship. |
| **M12** | **Config is static JSON.** No `app.config.ts`, `metro.config.js`, `babel.config.js`, or `eas.json`; `app.json` has **no `plugins` array**, so native config cannot be expressed. |
| **M13** | **Read-then-write race** in `ScreenTimeChart.tsx:67-72` (`get()` then `set()`, no transaction) → lost updates. |
| **M14** | `proguard-rules.pro` keeps `com.swmansion.reanimated.**` but reanimated is not a dependency. `gradle.properties` sets `expo.edgeToEdgeEnabled`, which the file itself flags as deprecated for SDK 55. |

### 🟢 Low

`tsconfig.json` has only `strict: true` — no `noUncheckedIndexedAccess`, no path aliases, so `../../` chains are everywhere · `AccountScreen.tsx:62` declares `SettingItem` **inside** the render body (new component identity every render) · `CustomButton`/`CustomInput` hardcode `colors.*` and ignore `ThemeContext`, so they are invisible in dark mode · `CalendarScreen` hardcodes `rgba(255,255,255,0.3)` for selection, ignoring the theme · several screens import `Platform`/`StatusBar` without using them · `.vscode/settings.json` sets `java.compile.nullAnalysis.mode` (irrelevant to RN/TS) · `app.json` has no `scheme` and no `bundleIdentifier` · **one commit, no branches, no PRs, no history to learn from.**

---

## 14. Recommended development order

### Step 0 — Stabilize (blocking; not optional)

The repository **cannot currently be installed, built, type-checked, or run** on a fresh clone: no `node_modules`, no `google-services.json`, no `debug.keystore`, two wrong-SDK Expo packages, one runtime-throwing import, and a red CI gate. Every feature estimate below assumes this is fixed first. Concretely: C1, C2, C3, H1, H2.

This is not busywork — **C1 means there is currently no working regression gate**, and C3/C2 mean the install is not reproducible. Building features on top of this is how an unrecoverable mess is created.

### Then, the order — and why it differs from the original plan

```text
0. Stabilize build + CI                      ← blocking
        ↓
1. Domain types + data-layer seam            ← src/domain/, src/data/  (pure, additive)
        ↓
2. Job Pipeline (additive, parallel screen)   ← fixes the spine before anything sits on it
        ↓
3. Resume Library (read-only projection)      ← needs 1; independent of AI
        ↓
4. Smart Intake ── needs a NEW Vercel route + Claude contract
        ↓
5. Resume Matching                            ← needs 3 + 4
        ↓
6. Review Queue (the human approval gate)     ← needs 2 + 3 + 5
        ↓
7. Vercel/Gmail bridge + caller auth          ← needs 6; MUST fix C5 first
        ↓
8. Share-to-Tracker (clipboard, then Android) ← needs 2
        ↓
9. Local deadline reminders                   ← needs 2; code already written
        ↓
10. Push notifications                        ← needs 1 + a token registry
        ↓
11. Telegram (server-side only)               ← fully independent; can be any time
```

### Deviations from the original sequence, and why

**The Job Tracker spine was moved ahead of Resume Library and Smart Intake.**

The original sequence started with Resume Library → Smart Intake → … → Job Tracker UI. The repository says otherwise, for one concrete reason:

> The mobile Firestore `jobs` schema and the Sheet schema have **already diverged**, and **the Sheet has no deadline column at all**. If Resume Library and Smart Intake are built on today's `{companyName, role, link, deadline, status, notes}` shape, then every later feature inherits the wrong model — and the cost is one migration across the tracker, the library, intake, matching, the review queue, notifications, *and* the Sheet sync. Fixing the spine costs one migration; fixing it late costs six.

Two supporting reasons:

- **The Job Tracker UI already exists** (CRUD, realtime, 5 statuses). It is not greenfield. It needs *correction and extension*, not construction — which means it is cheap to do now and expensive to do after five features depend on it.
- **Resume Library is the least dependent item in the plan** — a read-only projection of a Sheet cache over one HTTP call. It is a poor *first* move (nothing to hang selections on yet) but a fine *third*.

**Other deviations:**

- **Step 0 added.** Discussed above.
- **Step 1 (types + repository seam) added.** There is currently no data-access layer — every screen talks to Firestore inline. Without this seam, every later feature re-implements fetching, and swapping in a Vercel-backed implementation later becomes a rewrite instead of a new class.
- **Step 7 split in two.** Caller auth on `/api/rpc` (fixing **C5**) must land **before** the app is allowed to call it, not alongside it.
- **Step 9 (local reminders) promoted**, above push. `scheduleDeadlineNotification` is *already written and never called*. Converting it from dead code into a working feature is the cheapest user-visible win in the entire roadmap.
- **Step 11 (Telegram) marked independent.** It is pure outbound HTTPS from Vercel with **zero mobile-native surface**. It can be built at any time, in parallel, without touching this repository at all.
- **Share-to-Tracker moved after the bridge.** Real share intents need native work and a dev build. Clipboard paste (V0) has no such dependency and could be pulled forward to right after step 2 — it is essentially free.

**What was not reordered:** Resume Library still precedes Resume Matching, and the Review Queue still gates everything downstream. The human-approval requirement is preserved as a hard architectural constraint at every step.

---

## 15. Executive summary

### Current state

A **general-purpose personal-organizer Expo app** — passwords, calendar, projects, study planner, goals, profiles, workspaces, screen-time — built on Firebase Auth + Cloud Firestore with React Navigation v7. It is **not** a default scaffold: `src/` is ~4,000 hand-written lines across 13 screens. It is **also not** an AI job-application agent — it has zero intake, zero resume handling, zero matching, zero drafts, zero approval flow, and **zero connection to the `jobemailer` Vercel system**.

The Job Tracker that exists is a plain CRUD list with a 5-value status enum and a free-text `deadline`. It does **not** match the Sheet schema, and the Sheet has no deadline column.

Android-only bare workflow, New Architecture on, **no `ios/` at all**. One commit, no history.

### Ready

- **Local deadline reminders.** `NotificationService.scheduleDeadlineNotification` is fully written and **has zero call sites**. Converting dead code into a working feature is the cheapest win available.
- **Resume Library (read-only).** A list screen over an HTTP call. The Drive/Sheet/PDF side already exists and works in Apps Script (`Code.gs:25`, `getResumeBlob_()` at `:178`) — the app never needs to touch a PDF.
- **Clipboard-based intake.** `expo-clipboard` is already installed and already used. Zero native code. This is the correct V0 for share-to-tracker.
- **Domain types + repository seam.** Purely additive, zero behavioral change, and it is the enabling layer for everything else.

### Blocked

- **Nothing runs or builds today.** No `google-services.json` (auth/firestore/notifee can't initialize), no `debug.keystore`, no `node_modules`, two wrong-SDK Expo packages, one runtime-throwing import. **Fix this before writing any feature.**
- **CI is red.** The only quality gate fails on current `main`.
- **No environment-variable mechanism whatsoever.** There is nowhere legitimate for an API URL to live, so any Claude work would hardcode one. `app.config.ts` + `src/config/env.ts` must come first.
- **`/api/rpc` has no caller authentication.** The app must not call it until this is fixed (**C5**).
- **Firestore security rules are not in this repo.** Cannot be assessed from code. Must be checked in the Firebase Console — especially given C4.
- **No tests, no lint.** Zero regression safety net.
- **iOS Share Extension** — impossible; there is no `ios/` target.

### Do not touch

- **`jobemailer/` in its entirety** — `api/rpc.js`, `apps-script/Code.gs`, `Email.html`, `FollowUp.html`. The Gmail quota guard, duplicate protection, thread-ID tracking, and follow-up logic all live there and work. Treat it as an external legacy system. Extend it; never redesign it.
- **`src/screens/features/JobTrackerScreen.tsx`** — leave it running. Build the new pipeline alongside it.
- **`src/context/AuthContext.tsx`** — works. Only fix the listener leak.
- **`android/`** — the committed native project is the enabler for future share-target work. Don't regenerate it casually; that would discard the Firebase/Crashlytics Gradle setup.
- **`src/services/NotificationService.ts`** — good code. Extend, don't rewrite.
- **Human approval before send** — must be enforced in the data model (`approvalStatus`), not just in UI. Apps Script's `send`/`sendFollowUp` must be unreachable unless approved.

### First implementation

**A stabilization pass, followed by the domain/data seam.**

1. Fix C1, C2, C3, H1, H2 → get CI green and the app installable and runnable.
2. Delete the two hardcoded Gemini key literals and the direct provider call (**H6**) — before they become the template.
3. Add `src/domain/job.ts` (types + enums, zero imports) and `src/data/jobs/` (repository interface + Firestore implementation). **No screen changes.**
4. Add a parallel `JobPipelineScreen` that uses the new repository. **`JobTrackerScreen` untouched.**

The first *user-visible* feature after that: **Resume Library as a read-only list**, because it is the least dependent item and validates the `src/api/` HTTP seam needed for everything downstream.

### Recommended architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│  PassX-Easeout  (Expo SDK 54 / RN 0.81.5 / Android bare)           │
│                                                                     │
│  app.config.ts ──► extra { apiBaseUrl }                              │
│         │ (EXPO_PUBLIC_* only — never a secret)                     │
│         ▼                                                           │
│  src/config/env.ts          ← ONLY file touching process.env         │
│         │                                                           │
│  src/api/client.ts          ← base URL, timeout, errors              │
│         ├── src/api/jobs.ts       ─┐                                │
│         ├── src/api/intake.ts      ├── typed, thin │
│         └── src/api/resumes.ts    ─┘                                │
│                                                                     │
│  src/domain/job.ts           ← types + enums, zero imports          │
│  src/data/jobs/              ← JobsRepository (interface)            │
│         └── FirestoreJobsRepository                                 │
│                                                                     │
│  src/context/{Auth,Theme}    ← unchanged                             │
│                                                                     │
│  Screens ── depend on domain + data/, NEVER on Firestore directly    │
│  NotificationService         ← scheduleDeadlineReminder(job)         │
└──────────────────────────────┬──────────────────────────────────────┘
                               │  HTTPS, Firebase ID token
                               │  ❌ no Anthropic key  ❌ no Apps Script token
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Vercel  (jobemailer project — EXTEND, DON'T REDESIGN)              │
│                                                                     │
│  api/rpc.js           ⚠️ ADD CALLER AUTH (C5)                       │
│  api/intake.js        NEW ──► Anthropic Messages API                │
│  api/match.js         NEW ──► ANTHROPIC_API_KEY (server-only)       │
│  api/resumes.js       NEW ──► Google Sheets index + Drive           │
│  api/notify.js        NEW ──► Telegram Bot API  ← independent       │
│                                                                     │
│  Secrets: Vercel env vars ONLY. Never in the bundle.                │
└──────┬──────────────────────────────┬───────────────────────────────┘
       │                              │
       ▼                              ▼
┌──────────────────┐   ┌──────────────────────────────────────────────┐
│  Claude API      │   │  Google Apps Script  (UNCHANGED)             │
│  (intake/match)  │   │  Sheets · Gmail · quota guard · duplicate    │
└──────────────────┘   │  protection · thread IDs · follow-ups         │
                         └──────────────────────────────────────────────┘

 HUMAN APPROVAL GATE: Job.approvalStatus === 'approved'
 is a precondition for reaching `send` / `sendFollowUp`.
```

### Files to modify first

```text
MUST FIX FIRST (stabilization)
  .github/workflows/ci.yml                          ← C1, make the gate green
  package.json                                      ← C3, H7 correct SDK lines,
                                                      drop unused deps
  src/screens/features/PasswordManagerScreen.tsx:9  ← C2  expo-file-system/legacy
  src/services/GeminiService.ts                     ← H6  delete direct provider call
  src/screens/DashboardScreen.tsx:19                ← H6  delete key literal
  src/screens/features/GoalsScreen.tsx:12           ← H6  delete key literal
  android/app/debug.keystore (regenerate locally)    ← H2
  (google-services.json supplied locally)            ← H1

THEN (additive, no existing behaviour changed)
  app.config.ts                     NEW  env → extra
  src/config/env.ts                 NEW  single validated config reader
  src/domain/job.ts                 NEW  types + enums, zero imports
  src/data/jobs/types.ts            NEW  repository interface
  src/data/jobs/firestore.ts        NEW  Firestore implementation
  src/screens/JobPipelineScreen.tsx NEW  parallel tracker
  src/types/navigation.ts           EDIT register new routes
  App.tsx                           EDIT register Stack.Screens + import the
                                        shared param list (fixes H9)
```

### Estimated complexity

| Component | Complexity | Reason |
|---|---|---|
| **Stabilization** | **Medium** | Not a feature, but nothing else is safe to build until CI is green, the SDK lines are corrected, and the app actually launches. |
| **Resume Library** | **Low** | Read-only list over one new `api/resumes.js` returning metadata. Drive/Sheets/PDF side already works in Apps Script. No native work. |
| **Smart Intake** | **Medium** | New Vercel route + Claude contract + a robust prompt/schema are the real work. Client side is a paste box and a review form. Biggest unknown is extraction reliability, not plumbing. |
| **Resume Matching** | **Medium** | Same server shape as intake. Client is a ranked list. Difficulty is scoring quality and explainability, not architecture. |
| **Review Queue** | **Low–Medium** | Primarily UI over records that already have statuses. The hard requirement — human approval — is straightforward to enforce, and should be encoded in the data model rather than only in UI logic. |
| **Job Tracker** | **Medium** | Screen and route exist, but the schema is wrong-shaped, the status vocabulary conflicts with the Sheet, and the Sheet's `id` is an unstable row number. Mostly correction + a parallel screen, not construction. |
| **Share-to-Tracker** | **High** | Clipboard (V0) is Low and needs no native code. Android `ACTION_SEND` (V1) needs manifest changes, `<queries>`, and a dev build — not verifiable in Expo Go. iOS Share Extension (V2) is impossible today: no `ios/` directory exists. |
| **Notifications** | **Medium** | Local triggers already work via notifee and are **never called** — wiring them up is cheap. Push adds token registration, a server-side sender, and APNs/FCM setup, and currently can't even boot without `google-services.json`. |
| **Telegram** | **Low** | Pure outbound HTTPS from the existing Vercel backend. **Zero mobile-native surface and zero changes to this repository.** Can be built in parallel at any time. |

---

## READY FOR IMPLEMENTATION

- **Current readiness:** 5/10
- **Biggest blocker:** The repository cannot be installed, built, type-checked, or run on a fresh clone — `node_modules` absent, `google-services.json` and `android/app/debug.keystore` both gitignored and missing, `expo-notifications` and `expo-image-picker` on the wrong SDK line (55.x in an SDK 54 app), an `expo-file-system` root import in `PasswordManagerScreen.tsx:9` that is documented to throw at runtime in SDK 54, and a CI secret-scan step that **exits 1 on current `main`**. There is currently no working regression gate and no runnable app.
- **Best first implementation:** A stabilization pass — make CI green, correct the SDK version lines, fix the FileSystem import, remove the two hardcoded Gemini key literals and the direct-to-provider call in `GeminiService.ts`, and document the Firebase/keystore setup. Then add the domain layer (`src/domain/job.ts` + `src/data/jobs/` repository interface and Firestore implementation) and a **parallel** `JobPipelineScreen`, leaving `JobTrackerScreen.tsx` completely untouched. The first user-visible feature after that is the read-only **Resume Library**, which needs no native work.
- **Files we should touch first:** `.github/workflows/ci.yml` · `package.json` · `src/services/GeminiService.ts` · `src/screens/DashboardScreen.tsx` (line 19 only) · `src/screens/features/GoalsScreen.tsx` (line 12 only) · `src/screens/features/PasswordManagerScreen.tsx` (line 9 only) — then **new**: `app.config.ts`, `src/config/env.ts`, `src/domain/job.ts`, `src/data/jobs/*`, `src/screens/JobPipelineScreen.tsx` — then **minimal edits**: `src/types/navigation.ts` and `App.tsx` (route registration only, plus importing the shared param list).
- **Files/systems we should avoid touching:** The entire `jobemailer/` project — `api/rpc.js`, `apps-script/Code.gs`, `Email.html`, `FollowUp.html` — treat as an external legacy system; extend, never redesign, and add new routes alongside. Do not touch `src/screens/features/JobTrackerScreen.tsx` (build in parallel instead). Do not touch `src/context/AuthContext.tsx` beyond the listener leak. Do not regenerate or restructure `android/` — it is the committed native project that enables future share-target work and carries the Firebase/Crashlytics Gradle setup. Do not put any API key, token, or Apps Script URL in this repository under any circumstances.
- **Next OpenCode prompt:** *"Read-only prep, then implement Step 0 and Step 1 of the PassX-Easeout plan. First: produce a written diagnosis of the CI secret-scan failure and the exact minimal diff for each of the five stabilization fixes (ci.yml, package.json SDK lines, PasswordManagerScreen expo-file-system/legacy import, and removing the two hardcoded Gemini key literals plus the direct provider call in GeminiService) — show me the diffs, do not apply them. Then, once I approve, create app.config.ts, src/config/env.ts, src/domain/job.ts (types and enums only, zero imports), and src/data/jobs/ with a JobsRepository interface plus a Firestore implementation. Do not modify any existing screen, do not touch jobemailer, do not add any secrets, and do not add new routes to App.tsx yet."*

---

*End of audit. No implementation was performed.*