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

async function verifyFirebaseToken(idToken, projectId) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) throw new Error('malformed token');
  const [headerPart, payloadPart, signaturePart] = idToken.split('.');
  const header = decodeJwtPart(headerPart);
  const payload = decodeJwtPart(payloadPart);

  if (header.alg !== 'RS256') throw new Error('unexpected token algorithm');
  if (payload.aud !== projectId) throw new Error('token audience mismatch');
  if (payload.iss !== 'https://securetoken.google.com/' + projectId) throw new Error('token issuer mismatch');

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) throw new Error('token expired');
  if (typeof payload.iat !== 'number' || payload.iat > now + 60) throw new Error('token issued in the future');
  if (!payload.sub) throw new Error('token has no subject');

  const certs = await googleCerts();
  const pem = certs[header.kid];
  if (!pem) throw new Error('unknown signing key');

  const key = await crypto.subtle.importKey(
    'spki',
    pemToDer(pem),
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

async function exchangeCode(env, code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: code,
    code_verifier: codeVerifier,
    client_id: env.ROBLOX_CLIENT_ID,
    client_secret: env.ROBLOX_CLIENT_SECRET,
    redirect_uri: env.ROBLOX_REDIRECT_URI,
  });
  const res = await fetch(ROBLOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error('roblox token exchange failed with status ' + res.status);
  return JSON.parse(await res.text());
}

async function revokeToken(env, refreshToken) {
  const body = new URLSearchParams({
    token: refreshToken,
    client_id: env.ROBLOX_CLIENT_ID,
    client_secret: env.ROBLOX_CLIENT_SECRET,
  });
  const res = await fetch(ROBLOX_REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return res.ok;
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
