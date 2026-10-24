import { getIdToken } from "../firebase";

/** Thrown when an authenticated endpoint is called without a signed-in user. */
export class SignInRequiredError extends Error {
  constructor(message = "Please sign in to use this feature.") {
    super(message);
    this.name = "SignInRequiredError";
  }
}

/**
 * `fetch` for the server's authenticated endpoints: attaches the signed-in
 * user's Firebase ID token, and fails fast with a clear message when nobody is
 * signed in instead of sending a request the server will reject with a 401.
 */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken();
  if (!token) throw new SignInRequiredError();
  return fetch(input, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
  });
}

/** Like `fetch`, but attaches the ID token when someone is signed in (optional-auth endpoints). */
export async function maybeAuthedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken().catch(() => null);
  return fetch(input, {
    ...init,
    headers: { ...(init.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
}
