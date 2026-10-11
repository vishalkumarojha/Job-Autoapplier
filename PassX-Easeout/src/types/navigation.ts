import type { JobIntakeResult } from '../api/intake';

export type RootStackParamList = {
  Welcome: undefined;
  Login: undefined;
  Signup: undefined;
  Dashboard: undefined;
  PasswordManager: undefined;
  JobTracker: undefined;
  JobPipeline: { jobId?: string } | undefined;
  /**
   * Smart Intake, step 1: paste or share raw posting text, pick the capture channel, and
   * ask the server to extract fields. Params are optional so a refresh starts clean.
   */
  JobIntake:
    | {
        /** Called after a job is persisted, so the pipeline can refresh its list. */
        onSaved?: () => void;
        initialText?: string;
        initialSource?: 'paste' | 'share_android' | 'manual';
      }
    | undefined;
  /**
   * Smart Intake, step 2: review and edit the extraction before anything is persisted.
   *
   * The posting itself travels with the result because it is stored on the Job at save
   * time and shown for verification. Everything here is plain data apart from `onSaved`,
   * which mirrors the `onSelect` pattern used by `ResumeLibrary`.
   */
  JobIntakeReview:
    | {
        rawText: string;
        extraction: JobIntakeResult;
        /** Forwarded from `JobIntake`; see that route's note. */
        onSaved?: () => void;
      }
    | undefined;
  /**
   * Resume Library. Opens as a read-only list with no params, or as a picker when `jobId` is
   * supplied. `onSelect` is a navigation-param callback rather than a shared store, which keeps
   * the screen free of any repository dependency and the pipeline free of resume data.
   */
  ResumeLibrary:
    | {
        jobId?: string;
        selectedResumeId?: string | null;
        onSelect?: (result: { resumeId: string; label: string }) => void;
      }
    | undefined;
  Goals: undefined;
  StudyPlan: undefined;
  Calendar: undefined;
  Projects: undefined;
  Profiles: undefined;
  CustomSpaces: undefined;
  Account: undefined;
};
