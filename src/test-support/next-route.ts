/**
 * Test-only helpers for exercising Next.js App Router route handlers in Vitest.
 *
 * Route handlers are plain exported async functions — tests call them directly with a
 * `NextRequest` and assert on the returned `NextResponse`. `next/headers` `cookies()`
 * only works inside a real Next request scope, so cookie-reading routes mock it
 * (vi.hoisted runs before static imports, hence the dynamic import):
 *
 *   const cookieStore = await vi.hoisted(async () => {
 *     const { createCookieStoreMock } = await import('../test-support/next-route');
 *     return createCookieStoreMock();
 *   });
 *   vi.mock('next/headers', () => ({ cookies: async () => cookieStore }));
 */

export interface CookieStoreMock {
  get(name: string): { name: string; value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string): void;
  /** Options captured by the most recent `set` for each cookie, for assertions. */
  setOptions: Map<string, Record<string, unknown> | undefined>;
  /** Cookie names passed to `delete`, in order. */
  deleted: string[];
  /** Reset all state between tests. */
  reset(): void;
}

/** Map-backed stand-in for the `next/headers` request cookie store. */
export function createCookieStoreMock(): CookieStoreMock {
  const values = new Map<string, string>();
  const setOptions = new Map<string, Record<string, unknown> | undefined>();
  const deleted: string[] = [];
  return {
    get(name) {
      const value = values.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set(name, value, options) {
      values.set(name, value);
      setOptions.set(name, options);
    },
    delete(name) {
      values.delete(name);
      deleted.push(name);
    },
    setOptions,
    deleted,
    reset() {
      values.clear();
      setOptions.clear();
      deleted.length = 0;
    },
  };
}

/** Build a JSON POST request for a route handler. */
export function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
