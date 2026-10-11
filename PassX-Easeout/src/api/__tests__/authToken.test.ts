import { NotAuthenticatedError, getIdToken, requireIdToken } from '../authToken';

// `authToken` reads the current user from the Firebase auth instance. Mocking the
// specifier keeps the real module (and its untransformable ESM bundle) out of the run.
const currentUser = {
  getIdToken: jest.fn<Promise<string>, [boolean?]>(),
};

jest.mock('../../services/firebase', () => ({
  auth: () => ({
    get currentUser() {
      return (globalThis as unknown as { __user: typeof currentUser | null }).__user;
    },
  }),
}));

function setUser(user: typeof currentUser | null): void {
  (globalThis as unknown as { __user: typeof currentUser | null }).__user = user;
}

beforeEach(() => {
  currentUser.getIdToken.mockReset();
  setUser(null);
});

describe('getIdToken', () => {
  it('returns the token for the signed-in user', async () => {
    currentUser.getIdToken.mockResolvedValue('tok-abc');
    setUser(currentUser);
    await expect(getIdToken()).resolves.toBe('tok-abc');
  });

  it('requests the cached token by default', async () => {
    currentUser.getIdToken.mockResolvedValue('tok-abc');
    setUser(currentUser);
    await getIdToken();
    expect(currentUser.getIdToken).toHaveBeenCalledWith(false);
  });

  it('forces a refresh when asked, for the 401 retry path', async () => {
    currentUser.getIdToken.mockResolvedValue('tok-fresh');
    setUser(currentUser);
    await getIdToken(true);
    expect(currentUser.getIdToken).toHaveBeenCalledWith(true);
  });

  it('returns null when nobody is signed in rather than throwing', async () => {
    setUser(null);
    await expect(getIdToken()).resolves.toBeNull();
    expect(currentUser.getIdToken).not.toHaveBeenCalled();
  });

  it('propagates a token refresh failure', async () => {
    currentUser.getIdToken.mockRejectedValue(new Error('network down'));
    setUser(currentUser);
    await expect(getIdToken()).rejects.toThrow('network down');
  });
});

describe('requireIdToken', () => {
  it('returns the token when signed in', async () => {
    currentUser.getIdToken.mockResolvedValue('tok-abc');
    setUser(currentUser);
    await expect(requireIdToken()).resolves.toBe('tok-abc');
  });

  it('throws NotAuthenticatedError when signed out', async () => {
    setUser(null);
    await expect(requireIdToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('forwards the force-refresh flag', async () => {
    currentUser.getIdToken.mockResolvedValue('tok-abc');
    setUser(currentUser);
    await requireIdToken(true);
    expect(currentUser.getIdToken).toHaveBeenCalledWith(true);
  });

  it('never returns an empty string as a usable token', async () => {
    currentUser.getIdToken.mockResolvedValue('');
    setUser(currentUser);
    // An empty string is falsy, so it must be treated as signed out rather than
    // producing a malformed `Authorization: Bearer ` header.
    await expect(requireIdToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});
