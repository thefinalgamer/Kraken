/**
 * Checking that a request really came from our panel on Twitch.
 *
 * Twitch hands every extension viewer a signed token (a JWT). It says which
 * channel the panel is on and gives the viewer an opaque id, and it is signed
 * with the extension's secret, which only Twitch and Kraken know. A vote that
 * arrives without a valid one did not come from the panel, so it does not
 * count.
 *
 * THE SECRET lives in the Cloudflare Pages settings as TWITCH_EXTENSION_SECRET,
 * pasted by hand from the Twitch developer console (Extension, Settings,
 * Extension Secrets). It is base64 there and base64 here. It never goes in the
 * repo and never goes in a chat.
 *
 * HS256 only. A token claiming any other algorithm is refused rather than
 * obeyed, which is the classic way these checks get fooled.
 */

const enc = new TextEncoder();

function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64ToBytes(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keys = new Map();
async function keyFor(secret) {
  if (!keys.has(secret)) {
    keys.set(
      secret,
      crypto.subtle.importKey('raw', b64ToBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
        'verify',
        'sign',
      ]),
    );
  }
  return keys.get(secret);
}

/**
 * The token's claims if it is genuine and in date, otherwise null. Never
 * throws: a bad token is a refused vote, not a crashed panel.
 */
export async function verifyExtensionToken(token, secret, now = Date.now()) {
  try {
    if (!token || !secret) return null;
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const [h, p, sig] = parts;

    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    if (header?.alg !== 'HS256') return null;

    const ok = await crypto.subtle.verify(
      'HMAC',
      await keyFor(secret),
      b64urlToBytes(sig),
      enc.encode(`${h}.${p}`),
    );
    if (!ok) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    if (!claims || typeof claims !== 'object') return null;
    if (!Number.isFinite(claims.exp) || claims.exp * 1000 < now) return null;
    if (!claims.channel_id) return null;
    return claims;
  } catch {
    return null;
  }
}

/** For tests: make a token the way Twitch does. */
export async function signExtensionToken(claims, secret) {
  const b64url = (bytes) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await keyFor(secret), enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}
