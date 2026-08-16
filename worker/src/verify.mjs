/**
 * Discord request signature verification (Ed25519).
 *
 * Discord signs every interaction and will refuse to save an endpoint URL that
 * doesn't verify correctly — including the PING it sends when you paste the URL
 * in. Uses WebCrypto directly rather than pulling in a library.
 */

const encoder = new TextEncoder();

let cachedKeyHex = null;
let cachedKey = null;

async function importKey(publicKeyHex) {
  if (cachedKeyHex === publicKeyHex && cachedKey) return cachedKey;
  cachedKey = await crypto.subtle.importKey(
    'raw',
    hexToBytes(publicKeyHex),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  cachedKeyHex = publicKeyHex;
  return cachedKey;
}

export async function verifyKey(body, signature, timestamp, publicKeyHex) {
  if (!publicKeyHex) return false;
  try {
    const key = await importKey(publicKeyHex);
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToBytes(signature),
      encoder.encode(timestamp + body),
    );
  } catch (err) {
    console.error('Signature verification threw:', err);
    return false;
  }
}

function hexToBytes(hex) {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}
