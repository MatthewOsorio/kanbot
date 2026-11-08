// Vitest setup file: a test that reaches past the mocks fails instead of quietly calling a real service.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!LOOPBACK.has(url.hostname)) throw new Error(`Blocked network call in a test: ${url.href}`);
  return realFetch(input, init);
};
