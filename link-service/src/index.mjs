/**
 * XCOPE Roblox service
 * ---------------------------------------------------------------------------
 * One small server doing two jobs, so the website never has to hold a secret:
 *
 *  1. Proxy the public Roblox API. Many networks block Roblox outright, and the
 *     endpoints are not guaranteed to send CORS headers, so the browser tries
 *     Roblox directly and falls back to this.
 *
 *  2. Exchange a Roblox OAuth 2.0 authorisation code. That call requires the
 *     app's client secret, which must never reach a browser. The endpoint also
 *     verifies the caller's Firebase ID token, so a stolen code is useless to
 *     anybody else.
 *
 * Endpoints
 *   GET  /health                      -> { ok: true }
 *   GET  /roblox/lookup?username=foo  -> resolve a username
 *   GET  /roblox/user?id=123          -> public profile plus avatar url
 *   POST /exchange                    -> { code, codeVerifier, idToken }
 *   POST /unlink                      -> { idToken, refreshToken }
 *
 * Vars and secrets
 *   ALLOWED_ORIGINS       plain var, comma separated
 *   ROBLOX_CLIENT_ID / ROBLOX_CLIENT_SECRET / ROBLOX_REDIRECT_URI   (OAuth only)
 *   FIREBASE_PROJECT_ID                                             (OAuth only)
 */

const ROBLOX_USERS_BY_NAME = 'https://users.roblox.com/v1/usernames/users';
const ROBLOX_USER_BY_ID = 'https://users.roblox.com/v1/users/';
const ROBLOX_THUMBNAILS = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';
const ROBLOX_TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const ROBLOX_USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';
const ROBLOX_REVOKE_URL = 'https://apis.roblox.com/oauth/v1/token/revoke';
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/* ------------------------------------------------------------------ helpers */

function corsHeaders(origin, allowed) {
  const ok = !allowed.length || allowed.indexOf(origin) !== -1;
  return {
    'Access-Control-Allow-Origin': ok ? (origin || allowed[0] || '*') : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers),
  });
}

function base64UrlToBytes(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJwtPart(part) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* --------------------------------------------------------------- DER (ASN.1) */

/**
 * Reads one DER element at `offset`, returning its full extent.
 *
 * `start` and `end` bracket the whole element including its header, which is what
 * makes this usable for slicing: a DER header is not always two bytes. A length
 * of 128 or more is written as a first byte with the high bit set followed by
 * that many length bytes, so a certificate's outer sequence is four bytes of
 * header rather than two. Assuming two was the first attempt at this and it
 * silently returned the wrong slice.
 */
function readDerElement(bytes, offset) {
  const tag = bytes[offset];
  let length = bytes[offset + 1];
  let headerLength = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset + 2 + i];
    headerLength = 2 + count;
  }
  const contentStart = offset + headerLength;
  return { tag, start: offset, contentStart, contentLength: length, end: contentStart + length };
}

/** The elements directly inside the constructed element that starts at `offset`. */
function derChildren(bytes, offset) {
  const outer = readDerElement(bytes, offset);
  const children = [];
  let p = outer.contentStart;
  while (p < outer.end) {
    const el = readDerElement(bytes, p);
    if (el.end <= el.start) break; // no progress, malformed
    children.push(el);
    p = el.end;
  }
  return { children, end: outer.end };
}

/**
 * Extracts the SubjectPublicKeyInfo from an X.509 certificate.
 *
 * This is the whole reason signature verification used to fail. Google's
 * endpoint hands back full certificates, and importKey('spki', ...) wants only
 * the public key field inside one, not the certificate wrapping it. Handing it
 * the whole certificate makes the browser reject the key outright with "Invalid
 * SPKI input", which is what happened on the first real sign-in. Node's own
 * crypto happily unwraps a certificate, so nothing caught this until the Worker
 * met a real browser.
 *
 * The field is found by its shape rather than by its position. In a v3
 * certificate the last field of tbsCertificate is the extensions, not the key,
 * so counting from either end is wrong; picking the last child returned the
 * extension block. A SubjectPublicKeyInfo is the only field in there that is a
 * SEQUENCE of exactly two things whose second is a BIT STRING.
 */
export function extractSpkiFromCertificate(der) {
  const certificate = derChildren(der, 0);
  if (certificate.children.length < 3) throw new Error('not an X.509 certificate');
  const tbs = certificate.children[0];
  const fields = derChildren(der, tbs.start);

  for (const field of fields.children) {
    if (field.tag !== 0x30) continue;
    const inner = derChildren(der, field.start);
    if (inner.children.length === 2 && inner.children[1].tag === 0x03) {
      return der.slice(field.start, field.end);
    }
  }
  throw new Error('certificate has no subjectPublicKeyInfo');
}

/* ------------------------------------------------- Firebase ID token check */

let certCache = { at: 0, certs: null };

async function googleCerts() {
  const now = Date.now();
  if (certCache.certs && now - certCache.at < 6 * 60 * 60 * 1000) return certCache.certs;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error('could not fetch Google signing certificates');
  certCache = { at: now, certs: await res.json() };
  return certCache.certs;
}

function describeValue(value) {
  // Names an invisible cause instead of leaving it to be guessed at: a value
  // pasted with a trailing newline or space looks identical everywhere it is
  // displayed, and compares unequal forever.
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) return '(unset)';
  if (text !== text.trim()) return JSON.stringify(text) + ' - has leading or trailing whitespace';
  return JSON.stringify(text);
}

async function verifyFirebaseToken(idToken, projectId) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw new Error('malformed token');
  const [headerPart, payloadPart, signaturePart] = idToken.split('.');
  const header = decodeJwtPart(headerPart);
  const payload = decodeJwtPart(payloadPart);

  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');
  // The expected value is a public project id, never a secret, so naming it and
  // the audience it was compared against costs nothing and turns an opaque 401
  // into something that can be acted on.
  if (payload.aud !== projectId) {
    throw new Error('token audience mismatch: token aud is ' + describeValue(payload.aud) +
      ', FIREBASE_PROJECT_ID is ' + describeValue(projectId));
  }
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) {
    throw new Error('token issuer mismatch: token iss is ' + describeValue(payload.iss) +
      ', expected https://securetoken.google.com/' + describeValue(projectId));
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw new Error('token issued in the future');
  if (!payload.sub) throw new Error('token has no subject');

  const certs = await googleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('unknown signing key');

  // The endpoint returns certificates, so the public key has to be taken out of
  // one before WebCrypto will look at it. See extractSpkiFromCertificate.
  let spki;
  try {
    spki = extractSpkiFromCertificate(pemToDer(pem));
  } catch (e) {
    throw new Error('could not read the signing key from the certificate: ' + e.message);
  }

  const key = await crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlToBytes(signaturePart),
    new TextEncoder().encode(headerPart + '.' + payloadPart)
  );
  if (!valid) throw new Error('token signature is not valid');
  return payload;
}

/* ------------------------------------------------------------ Roblox proxy */

async function robloxGet(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 429) throw new Error('rate-limited');
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) throw new Error('roblox responded ' + res.status);
  return res.json();
}

async function handleLookup(username) {
  const res = await fetch(ROBLOX_USERS_BY_NAME, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
  });
  if (res.status === 429) throw new Error('rate-limited');
  if (!res.ok) throw new Error('roblox responded ' + res.status);
  const payload = await res.json();
  const first = payload && payload.data && payload.data[0];
  if (!first) throw new Error('not-found');
  return { id: String(first.id), username: first.name, displayName: first.displayName || first.name };
}

async function handleUser(id) {
  const user = await robloxGet(ROBLOX_USER_BY_ID + encodeURIComponent(id));
  let avatarUrl = null;
  try {
    const thumbs = await robloxGet(
      ROBLOX_THUMBNAILS + '?userIds=' + encodeURIComponent(id) + '&size=150x150&format=Png&isCircular=false'
    );
    const first = thumbs && thumbs.data && thumbs.data[0];
    if (first && first.state === 'Completed' && first.imageUrl) avatarUrl = first.imageUrl;
  } catch (e) {
    /* the avatar is cosmetic */
  }

  return {
    id: String(user.id),
    username: user.name || '',
    displayName: user.displayName || user.name || '',
    description: user.description || '',
    createdAt: user.created || null,
    avatarUrl: avatarUrl,
    profileUrl: 'https://www.roblox.com/users/' + user.id + '/profile',
  };
}

/* ------------------------------------------------------------ OAuth tokens */

/**
 * Turns an error response body into something that can be acted on.
 *
 * The token endpoint answers a rejection with a short JSON body such as
 * {"error":"invalid_grant","error_description":"..."}, and that body is the only
 * thing that can tell the two likely causes apart: a redirect_uri that does not
 * match the one used at authorisation time, versus a code that is expired,
 * already redeemed, or paired with the wrong PKCE verifier. Reporting just the
 * status code throws that away and leaves nothing but guessing.
 */
function describeUpstreamError(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) return '(empty body)';
  try {
    const parsed = JSON.parse(text);
    const parts = [];
    if (parsed.error) parts.push(String(parsed.error));
    if (parsed.error_description) parts.push(String(parsed.error_description));
    if (parts.length) return parts.join(': ');
  } catch (e) {
    /* not JSON, fall through to the raw text */
  }
  return text.slice(0, 300);
}

/**
 * Reads a configuration value, trimming it and complaining when that changed
 * anything.
 *
 * A secret pasted into `wrangler secret put` often carries a trailing newline or
 * space. Roblox compares these values as strings, so a stray space produces a
 * rejection that looks exactly like a mismatch and gives no clue which value is
 * at fault. Trimming means the flow works anyway, and the warning means the
 * stored value still gets corrected rather than quietly staying wrong.
 */
function configValue(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return '';
  const text = String(raw);
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (trimmed !== text) {
    console.warn('[config] ' + name + ' has leading or trailing whitespace; using the trimmed value. ' +
      'Re-set it with: npx wrangler secret put ' + name);
  }
  return trimmed;
}

/** Base64 of "client_id:client_secret", for the Basic authentication scheme. */
function basicAuthHeader(clientId, clientSecret) {
  const raw = clientId + ':' + clientSecret;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return 'Basic ' + btoa(binary);
}

async function exchangeCode(env, code, codeVerifier) {
  const clientId = configValue(env, 'ROBLOX_CLIENT_ID');
  const clientSecret = configValue(env, 'ROBLOX_CLIENT_SECRET');
  const redirectUri = configValue(env, 'ROBLOX_REDIRECT_URI');

  const params = {
    grant_type: 'authorization_code',
    code: code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  };

  // Roblox accepts the credentials either in the body or as HTTP Basic, and the
  // documentation lists both as supported. It is not stated which are enabled per
  // app, so if the first form is refused as an unknown client the second is
  // tried before giving up. A wrong secret reports the same error under both, so
  // this costs one extra request only when something is already wrong.
  //
  // The Basic form must not also carry client_id in the body. Roblox answers
  // "Ambiguous request because multiple authentication methods are used" when it
  // sees both, which is not what an unknown client looks like, so the fallback
  // appeared to fail for a reason of its own making.
  const attempts = [
    {
      label: 'client_secret_post',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({}, params, { client_id: clientId, client_secret: clientSecret })),
    },
    {
      label: 'client_secret_basic',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuthHeader(clientId, clientSecret),
      },
      body: new URLSearchParams(params),
    },
  ];

  let last = null;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    const res = await fetch(ROBLOX_TOKEN_URL, {
      method: 'POST',
      headers: attempt.headers,
      body: attempt.body.toString(),
    });
    const text = await res.text();

    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('roblox token exchange returned a body that is not JSON');
      }
    }

    last = { status: res.status, detail: describeUpstreamError(text), label: attempt.label };
    // Only an unknown-client complaint is worth retrying the other way. Anything
    // else (an expired code, a redirect mismatch) will fail identically.
    if (!/invalid_client/i.test(text)) break;
  }

  // The client id is public - it travels in the authorization URL the browser
  // builds and is visible in the page source - so naming it costs nothing and is
  // the only way to tell a wrong stored value from a wrong secret. The secret is
  // never included.
  throw new Error('roblox token exchange failed with status ' + last.status +
    ' using ' + last.label + ': ' + last.detail +
    ' [client_id sent: ' + describeValue(configValue(env, 'ROBLOX_CLIENT_ID')) +
    ', secret length ' + configValue(env, 'ROBLOX_CLIENT_SECRET').length + ']');
}

async function revokeToken(env, refreshToken) {
  const clientId = configValue(env, 'ROBLOX_CLIENT_ID');
  const clientSecret = configValue(env, 'ROBLOX_CLIENT_SECRET');

  // Same two credential forms as the exchange, for the same reason, and with the
  // same rule: the Basic form must not repeat client_id in the body.
  for (const attempt of [
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    },
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuthHeader(clientId, clientSecret) },
      body: new URLSearchParams({ token: refreshToken }),
    },
  ]) {
    const res = await fetch(ROBLOX_REVOKE_URL, {
      method: 'POST',
      headers: attempt.headers,
      body: attempt.body.toString(),
    });
    if (res.ok) return true;
  }
  return false;
}

/* ------------------------------------------------------------- entry point */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headers = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    if (origin && allowed.length && allowed.indexOf(origin) === -1) {
      return json({ ok: false, error: 'origin not allowed' }, 403, headers);
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'xcope-roblox' }, 200, headers);
    }

    /* ---- public Roblox API proxy: no secret involved ---- */
    if (url.pathname === '/roblox/lookup') {
      const username = url.searchParams.get('username') || '';
      if (!username) return json({ ok: false, error: 'username is required' }, 400, headers);
      try {
        return json({ ok: true, user: await handleLookup(username) }, 200, headers);
      } catch (e) {
        return json({ ok: false, error: e.message }, e.message === 'not-found' ? 404 : 502, headers);
      }
    }

    if (url.pathname === '/roblox/user') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json({ ok: false, error: 'id is required' }, 400, headers);
      try {
        return json({ ok: true, user: await handleUser(id) }, 200, headers);
      } catch (e) {
        return json({ ok: false, error: e.message }, e.message === 'not-found' ? 404 : 502, headers);
      }
    }

    /* ---- everything below needs a signed-in caller and a known path ---- */
    // Check the path first: an unknown route should be a plain 404 rather than a
    // confusing token failure.
    if (url.pathname !== '/exchange' && url.pathname !== '/unlink') {
      return json({ ok: false, error: 'not found' }, 404, headers);
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method not allowed' }, 405, headers);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ ok: false, error: 'invalid JSON body' }, 400, headers);
    }

    if (!env.FIREBASE_PROJECT_ID) {
      return json({ ok: false, error: 'server is not configured (FIREBASE_PROJECT_ID)' }, 500, headers);
    }

    let claims;
    try {
      claims = await verifyFirebaseToken(payload.idToken, env.FIREBASE_PROJECT_ID);
    } catch (e) {
      return json({ ok: false, error: 'unauthenticated: ' + e.message }, 401, headers);
    }

    if (url.pathname === '/exchange') {
      if (!payload.code || !payload.codeVerifier) {
        return json({ ok: false, error: 'code and codeVerifier are required' }, 400, headers);
      }
      if (!env.ROBLOX_CLIENT_ID || !env.ROBLOX_CLIENT_SECRET || !env.ROBLOX_REDIRECT_URI) {
        return json({ ok: false, error: 'server is not configured (ROBLOX_*)' }, 500, headers);
      }
      try {
        const tokens = await exchangeCode(env, payload.code, payload.codeVerifier);
        const infoRes = await fetch(ROBLOX_USERINFO_URL, {
          headers: { Authorization: 'Bearer ' + tokens.access_token },
        });
        if (!infoRes.ok) throw new Error('roblox userinfo failed with status ' + infoRes.status);
        const info = await infoRes.json();

        return json(
          {
            ok: true,
            firebaseUid: claims.sub,
            roblox: {
              id: String(info.sub || ''),
              username: info.preferred_username || '',
              displayName: info.name || info.nickname || '',
              profileUrl: info.profile || '',
              avatarUrl: info.picture || null,
              createdAt: info.created_at || null,
            },
            refreshToken: tokens.refresh_token || null,
          },
          200,
          headers
        );
      } catch (e) {
        return json({ ok: false, error: e.message }, 502, headers);
      }
    }

    if (url.pathname === '/unlink') {
      if (!payload.refreshToken) return json({ ok: true, revoked: false }, 200, headers);
      try {
        return json({ ok: true, revoked: await revokeToken(env, payload.refreshToken) }, 200, headers);
      } catch (e) {
        return json({ ok: false, error: e.message }, 502, headers);
      }
    }

    return json({ ok: false, error: 'not found' }, 404, headers);
  },
};
