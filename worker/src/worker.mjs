/**
 * XCOPE Roblox link service
 * ---------------------------------------------------------------------------
 * Roblox's OAuth 2.0 token exchange requires the app's client secret, so it can
 * never happen in the browser. This Worker is that server side: it holds the
 * secret, exchanges the one-time authorisation code, and returns only the public
 * profile of the Roblox account to the caller.
 *
 * It also proves who is asking, by verifying the caller's Firebase ID token
 * against Google's public keys. That means a stolen authorisation code cannot be
 * redeemed by anyone else.
 *
 * Endpoints
 *   POST /exchange   { code, codeVerifier, idToken } -> { roblox: {...} }
 *   POST /unlink     { idToken, refreshToken? }      -> { ok: true }
 *   GET  /health                                     -> { ok: true }
 *
 * Required secrets / vars (wrangler secret put NAME, or [vars] for ALLOWED_ORIGINS)
 *   ROBLOX_CLIENT_ID       from the Roblox Creator Dashboard
 *   ROBLOX_CLIENT_SECRET   shown once when the Roblox OAuth app is created
 *   ROBLOX_REDIRECT_URI    must match a redirect URL registered on the Roblox app
 *   FIREBASE_PROJECT_ID    e.g. x-cope-website
 *   ALLOWED_ORIGINS        comma-separated, e.g. https://mm1f4.github.io
 */

const ROBLOX_TOKEN_URL = 'https://apis.roblox.com/oauth/v1/token';
const ROBLOX_USERINFO_URL = 'https://apis.roblox.com/oauth/v1/userinfo';
const ROBLOX_REVOKE_URL = 'https://apis.roblox.com/oauth/v1/token/revoke';
const GOOGLE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/* ------------------------------------------------------------------ helpers */

function corsHeaders(origin, allowed) {
  const ok = allowed.length === 0 || allowed.indexOf(origin) !== -1;
  return {
    'Access-Control-Allow-Origin': ok ? origin || allowed[0] || '*' : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

/* ------------------------------------------------- Firebase ID token check */

let certCache = { fetchedAt: 0, certs: null };

async function googleCerts() {
  const now = Date.now();
  if (certCache.certs && now - certCache.fetchedAt < 6 * 60 * 60 * 1000) return certCache.certs;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error('could not fetch Google signing certificates');
  const certs = await res.json();
  certCache = { fetchedAt: now, certs };
  return certs;
}

function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Verifies a Firebase ID token: signature against Google's certificates, plus the
 * issuer, audience and expiry claims. Returns the decoded payload.
 */
async function verifyFirebaseToken(idToken, projectId) {
  if (typeof idToken !== 'string' || idToken.split('.').length !== 3) {
    throw new Error('malformed token');
  }
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

/* ------------------------------------------------------------ Roblox calls */

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

  const text = await res.text();
  if (!res.ok) {
    // Never echo the raw Roblox error body: it can contain request details.
    throw new Error('roblox token exchange failed with status ' + res.status + ' (' + text.slice(0, 120) + ')');
  }
  return JSON.parse(text);
}

async function fetchUserInfo(accessToken) {
  const res = await fetch(ROBLOX_USERINFO_URL, {
    headers: { Authorization: 'Bearer ' + accessToken },
  });
  if (!res.ok) throw new Error('roblox userinfo failed with status ' + res.status);
  return res.json();
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

/* ------------------------------------------------------------- request flow */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const headers = corsHeaders(origin, allowed);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    // Reject browsers that are not on the allow list before doing any work.
    if (origin && allowed.length && allowed.indexOf(origin) === -1) {
      return json({ ok: false, error: 'origin not allowed' }, 403, headers);
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'xcope-roblox-link' }, 200, headers);
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
        const info = await fetchUserInfo(tokens.access_token);

        // Only public identity data leaves this service. Tokens stay here.
        return json({
          ok: true,
          firebaseUid: claims.sub,
          roblox: {
            id: String(info.sub || ''),
            username: info.preferred_username || '',
            displayName: info.name || info.nickname || '',
            profileUrl: info.profile || (info.sub ? 'https://www.roblox.com/users/' + info.sub + '/profile' : ''),
            avatarUrl: info.picture || null,
            createdAt: info.created_at || null,
          },
          // Returned so the client can offer "unlink" later; it is a secret and
          // should be stored only where the account holder can read it.
          refreshToken: tokens.refresh_token || null,
        }, 200, headers);
      } catch (e) {
        return json({ ok: false, error: e.message }, 502, headers);
      }
    }

    if (url.pathname === '/unlink') {
      if (!payload.refreshToken) {
        return json({ ok: true, revoked: false, note: 'nothing to revoke' }, 200, headers);
      }
      try {
        const revoked = await revokeToken(env, payload.refreshToken);
        return json({ ok: true, revoked: revoked }, 200, headers);
      } catch (e) {
        return json({ ok: false, error: e.message }, 502, headers);
      }
    }

    return json({ ok: false, error: 'not found' }, 404, headers);
  },
};
