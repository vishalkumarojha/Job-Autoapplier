/**
 * Minimal in-memory stand-in for the slice of Firestore that `FirestoreJobsRepository`
 * actually uses.
 *
 * A fake is used rather than the emulator so the suite runs offline, needs no project
 * configuration, and cannot touch real user data. It implements only the operations the
 * repository calls, and it records the paths it was asked for so tests can assert the
 * repository addresses `users/{uid}/jobs` and never another collection.
 */

export interface FakeSnapshot {
  id: string;
  data: () => Record<string, unknown> | undefined;
  exists: () => boolean;
}

export interface FakeFirestore {
  /** Document store keyed by `uid/jobs/jobId`, mirroring the real nesting. */
  store: Map<string, Record<string, unknown>>;
  /** Every path passed to `.collection()`, in call order. */
  collectionPaths: string[];
  /** The Firestore API surface handed to the repository. */
  api: unknown;
  /** Drops all documents and recorded paths. Call from `beforeEach`. */
  reset: () => void;
  /** Convenience for seeding a document without going through the repository. */
  seed: (uid: string, jobId: string, data: Record<string, unknown>) => void;
  /** Convenience for asserting on what was actually persisted. */
  read: (uid: string, jobId: string) => Record<string, unknown> | undefined;
}

const storeKey = (uid: string, jobId: string) => `${uid}/jobs/${jobId}`;

function snapshot(id: string, data: Record<string, unknown> | undefined): FakeSnapshot {
  return {
    id,
    data: () => data,
    exists: () => data !== undefined,
  };
}

export function createFakeFirestore(): FakeFirestore {
  const store = new Map<string, Record<string, unknown>>();
  const collectionPaths: string[] = [];
  let autoIdCounter = 0;

  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

  const docRef = (uid: string, jobId: string) => ({
    id: jobId,
    async get(): Promise<FakeSnapshot> {
      return snapshot(jobId, store.get(storeKey(uid, jobId)));
    },
    async set(data: Record<string, unknown>): Promise<void> {
      store.set(storeKey(uid, jobId), clone(data));
    },
    async update(data: Record<string, unknown>): Promise<void> {
      const existing = store.get(storeKey(uid, jobId));
      if (!existing) throw new Error(`Firestore fake: no document at ${storeKey(uid, jobId)}`);
      store.set(storeKey(uid, jobId), Object.assign({}, existing, clone(data)));
    },
  });

  const jobsCollection = (uid: string) => ({
    doc(jobId?: string) {
      // An omitted ID means "generate one", which is how real Firestore behaves.
      const resolved = jobId ?? `auto-id-${++autoIdCounter}`;
      return docRef(uid, resolved);
    },
    orderBy(field: string, direction: 'asc' | 'desc' = 'asc') {
      return query(uid, field, direction, Infinity);
    },
  });

  const query = (uid: string, field: string, direction: 'asc' | 'desc', limit: number) => ({
    limit(next: number) {
      return query(uid, field, direction, next);
    },
    async get(): Promise<{ docs: FakeSnapshot[]; empty: boolean }> {
      const prefix = `${uid}/jobs/`;
      const docs = [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => snapshot(key.slice(prefix.length), value))
        .sort((a, b) => {
          const left = a.data()?.[field];
          const right = b.data()?.[field];
          if (left === right) return 0;
          const order = (left as never) < (right as never) ? -1 : 1;
          return direction === 'desc' ? -order : order;
        })
        .slice(0, limit);
      return { docs, empty: docs.length === 0 };
    },
  });

  const api = {
    collection(path: string) {
      collectionPaths.push(path);
      return {
        doc(uid: string) {
          return {
            collection(subPath: string) {
              collectionPaths.push(subPath);
              if (subPath !== 'jobs') throw new Error(`Firestore fake: unexpected subcollection ${subPath}`);
              return jobsCollection(uid);
            },
          };
        },
      };
    },
    async runTransaction<T>(fn: (transaction: { get: unknown; update: unknown }) => Promise<T>): Promise<T> {
      return fn({
        get: (ref: { get: () => Promise<FakeSnapshot> }) => ref.get(),
        update: (ref: { update: (data: Record<string, unknown>) => Promise<void> }, data: Record<string, unknown>) =>
          ref.update(data),
      });
    },
  };

  return {
    store,
    collectionPaths,
    api,
    reset() {
      store.clear();
      collectionPaths.length = 0;
    },
    seed(uid, jobId, data) {
      store.set(storeKey(uid, jobId), data);
    },
    read(uid, jobId) {
      return store.get(storeKey(uid, jobId));
    },
  };
}
