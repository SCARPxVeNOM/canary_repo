/* Your addresses, in the encodings we check.

   We know the exact addresses, so this is exact matching. A case-insensitive
   search for the 40 hex digits covers lowercase, checksummed, without 0x,
   32-byte ABI-padded and URL-encoded forms (hex digits are never escaped).
   Base64 of the raw 20 bytes and of the hex string are checked separately. */

export type Taint = { address: string; encoding: "hex" | "base64" };
export type AddressNeedles = { address: string; hex: string; b64: string[] };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const hexToBytes = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const strip = (s: string) => s.replace(/=+$/, "");
const urlSafe = (s: string) => s.replace(/\+/g, "-").replace(/\//g, "_");

export function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export function needlesFor(address: string): AddressNeedles {
  const hex = address.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new TypeError(`not an address: ${address}`);
  const raw = strip(b64(hexToBytes(hex)));
  const str0x = strip(btoa("0x" + hex));
  const str = strip(btoa(hex));
  // base64 of a string shifts with its offset, so these only catch the
  // address encoded on its own (the common case for analytics payloads).
  return { address: "0x" + hex, hex, b64: [...new Set([raw, urlSafe(raw), str0x, str])] };
}

/** The first of your addresses found in `haystack`, if any. */
export function findAddress(haystack: string, needles: AddressNeedles[]): Taint | null {
  if (!haystack || needles.length === 0) return null;
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n.hex)) return { address: n.address, encoding: "hex" };
    for (const b of n.b64) if (haystack.includes(b)) return { address: n.address, encoding: "base64" };
  }
  return null;
}

/** Every one of your addresses found in `haystack`, in the order of `needles`. */
export function findAddresses(haystack: string, needles: AddressNeedles[]): string[] {
  if (!haystack || needles.length === 0) return [];
  const lower = haystack.toLowerCase();
  const out: string[] = [];
  for (const n of needles) {
    if (lower.includes(n.hex) || n.b64.some((b) => haystack.includes(b))) out.push(n.address);
  }
  return out;
}

/** Isolation key for requests that carry one of your addresses (docs/design-notes.md §3.1). */
export const isolationKeyFor = (address: string) => `addr:${address.toLowerCase()}`;
