/** UUIDv7 (RFC 9562): 48-bit unix-ms timestamp then random bits, so ids sort by creation time. */
export function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
