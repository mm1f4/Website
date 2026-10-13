/**
 * Roblox account linking through official OAuth 2.0.
 *
 * This is the reviewed path. Roblox's token exchange needs the app's client
 * secret, which can never live in a browser, so the code is handed to the Worker
 * in link-service/ along with the visitor's Firebase ID token. The Worker does
 * the exchange and returns the profile, keeping the secret and the Roblox access
 * token on the server.
 *
 * The flow, in order:
 *   1. begin() makes a PKCE verifier, remembers the state and the verifier in
 *      sessionStorage, and sends the browser to Roblox.
 *   2. Roblox redirects back with the code in the fragment.
 *   3. complete() posts the code and verifier to the Worker, which checks the
 *      Firebase ID token, exchanges the code, read the profile and returns it.
 *
 * Roblox returns the parameters appended to the registered redirect URI as a
 * query string, so the callback arrives as `/?code=...&state=...`. takeCallback()
 * reads both the query string and the fragment and strips the code out of the URL
 * as soon as it has been read. This was initially written the other way round,
 * expecting the code in the fragment, which meant the callback was never
 * recognised at all.
 *
 * PKCE is used even though the client is confidential and the Worker proves the
 * caller's Firebase identity. It costs one hash and closes the window where an
 * intercepted code could be redeemed by somebody else.
 */

const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';

// openid identifies the account; profile adds the username, display name and
// picture. Both are read at linking time only, and the app requests nothing else.
const SCOPES = 'openid profile';

const CALLBACK_MARKER = 'roblox-oauth';
const PENDING_KEY = 'xcope-roblox-oauth';
const RESULT_KEY = 'xcope-roblox-oauth-result';
const VERIFIER_TTL_MS = 15 * 60 * 1000;

/**
 * Error carrying an i18n key, so the panel can translate it. Deliberately a
 * different class from RobloxLinkError in roblox.js: callers want to tell the
 * two paths apart when deciding what to report.
 */
export class RobloxOAuthError extends Error {
  constructor(key, detail) {
    super(detail || key);
    this.key = key;
    this.detail = detail || '';
  }
}

/* ------------------------------------------------------------- configuration */

let oauthConfig = { clientId: '', redirectUri: '', endpoint: '' };

/** Sets the client id, the registered redirect URI, and the Worker base URL. */
export function setOAuthConfig(options) {
  const next = Object.assign({}, oauthConfig, options || {});
  oauthConfig = {
    clientId: String(next.clientId || ''),
    redirectUri: String(next.redirectUri || ''),
    endpoint: String(next.endpoint || '').replace(/\/$/, ''),
  };
  return oauthConfig;
}

/** True when all three pieces are present, so the button is worth showing. */
export function isOAuthConfigured() {
  return !!(oauthConfig.clientId && oauthConfig.redirectUri && oauthConfig.endpoint);
}

export function getOAuthConfig() {
  return Object.assign({}, oauthConfig);
}

/* ------------------------------------------------------------------- PKCE */

function base64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(bytes) {
  const buf = new Uint8Array(bytes);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    // Only reachable on a browser that cannot do Web Crypto at all, which also
    // cannot run this module's imports. Refuse rather than fall back to a weak
    // source of randomness.
    throw new RobloxOAuthError('link.oauthUnsupported');
  }
  return base64Url(buf);
}

/** S256 of the verifier, as Roblox expects. */
export async function codeChallengeFor(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return base64Url(new Uint8Array(digest));
}

/* ---------------------------------------------------------------- callback */

/**
 * Reads the OAuth callback out of the URL and clears it, returning
 * { code, state, error } or null when this load is not a callback.
 *
 * Roblox appends the parameters to the registered redirect URI as an ordinary
 * query string, so `/?code=...` is what actually comes back. An earlier version
 * of this file only looked inside the fragment, on the assumption that a fragment
 * would keep the code away from the server. It never matched, so the exchange was
 * never attempted and the code sat in the address bar until it expired a minute
 * later with nothing shown to the visitor. Both places are checked now.
 *
 * This must run before the router touches the URL, because the router reads the
 * fragment during boot.
 */
export function takeCallback() {
  const search = String(location.search || '');
  const hash = String(location.hash || '');

  const fromSearch = new URLSearchParams(search);
  const hashQuery = hash.indexOf('?');
  const fromHash = new URLSearchParams(hashQuery === -1 ? '' : hash.slice(hashQuery + 1));

  // A marker in the fragment is the strongest signal, because only our own
  // begin() ever puts one there.
  const viaMarker = hash.indexOf(CALLBACK_MARKER) !== -1;
  const pick = (name) => fromHash.get(name) || fromSearch.get(name) || '';

  const code = pick('code');
  const error = pick('error');
  if (!viaMarker && !code && !error) return null;

  const out = {
    code: code,
    state: pick('state'),
    error: error,
    errorDescription: pick('error_description'),
  };

  // Drop it immediately: the code is single use, and leaving it in the URL keeps
  // it in history and in anything that screenshots the page.
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', location.pathname);
  }
  return out;
}

/* ------------------------------------------------------------- pending state */

function savePending(pending) {
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch (e) { /* storage blocked */ }
}

function loadPending() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null');
    if (!raw || !raw.startedAt || !raw.verifier) return null;
    if (Date.now() - raw.startedAt > VERIFIER_TTL_MS) return null;
    return raw;
  } catch (e) { return null; }
}

function clearPending() {
  try { sessionStorage.removeItem(PENDING_KEY); } catch (e) { /* storage blocked */ }
}

/** A one-shot note that a link just succeeded, so the reload can say so. */
export function stashResult(result) {
  try { sessionStorage.setItem(RESULT_KEY, JSON.stringify(result)); } catch (e) { /* storage blocked */ }
}

export function takeResult() {
  try {
    const raw = JSON.parse(sessionStorage.getItem(RESULT_KEY) || 'null');
    sessionStorage.removeItem(RESULT_KEY);
    return raw;
  } catch (e) { return null; }
}

/* -------------------------------------------------------------- return trip */

/**
 * Where the visitor was standing when they pressed the button.
 *
 * Leaving for Roblox is a full navigation, and the panel this tab was reading is
 * remembered through the URL fragment. That fragment is gone by the time the
 * callback comes back, so the panel has to be parked here instead or the
 * visitor returns to the landing page with no sign of what they just did.
 */
const RETURN_PANEL_KEY = 'xcope-roblox-oauth-panel';

/** Parks the panel the callback should return to. */
export function rememberReturnPanel(id) {
  try {
    if (id) sessionStorage.setItem(RETURN_PANEL_KEY, String(id));
    else sessionStorage.removeItem(RETURN_PANEL_KEY);
  } catch (e) { /* storage blocked */ }
  return id || '';
}

/** Reads the parked panel without consuming it, so a reload still restores it. */
export function peekReturnPanel() {
  try { return sessionStorage.getItem(RETURN_PANEL_KEY) || ''; } catch (e) { return ''; }
}

export function clearReturnPanel() {
  try { sessionStorage.removeItem(RETURN_PANEL_KEY); } catch (e) { /* storage blocked */ }
}

/* ------------------------------------------------------------------- start */

/**
 * Sends the browser to Roblox. Does not return: the page navigates.
 *
 * Accepts a function that resolves the signed-in user, because the exchange
 * later needs that user's Firebase ID token. It is only used to avoid starting a
 * flow that could not be finished.
 */
export async function beginOAuth(getIdToken) {
  if (!isOAuthConfigured()) throw new RobloxOAuthError('link.oauthNotConfigured');

  if (typeof getIdToken === 'function') {
    let token = null;
    try { token = await getIdToken(); } catch (e) { token = null; }
    if (!token) throw new RobloxOAuthError('link.needSignIn');
  }

  const verifier = randomString(32);
  const state = randomString(16);
  savePending({ verifier, state, startedAt: Date.now() });

  const challenge = await codeChallengeFor(verifier);
  const url = AUTHORIZE_URL + '?' + new URLSearchParams({
    client_id: oauthConfig.clientId,
    redirect_uri: oauthConfig.redirectUri,
    scope: SCOPES,
    response_type: 'code',
    state: state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  location.assign(url);
}

/* ---------------------------------------------------------------- complete */

function profileFromOAuth(roblox, now) {
  return {
    id: String(roblox.id || ''),
    username: roblox.username || '',
    displayName: roblox.displayName || roblox.username || '',
    // OAuth gives no About me text, and the shape is kept identical so the panel
    // and renderRobloxLink do not need to know which path produced it.
    description: '',
    createdAt: roblox.createdAt || null,
    avatarUrl: roblox.avatarUrl || null,
    profileUrl: roblox.profileUrl || ('https://www.roblox.com/users/' + roblox.id + '/profile'),
    code: '',
    verifiedAt: now,
    viaOauth: true,
  };
}

/**
 * Finishes the flow: validates state, exchanges the code through the Worker and
 * returns { profile, refreshToken }.
 *
 * `getIdToken` must resolve the current Firebase ID token; the Worker refuses
 * the exchange without it.
 */
export async function completeOAuth(callback, getIdToken, options) {
  const config = Object.assign({ storageKey: 'xcope-roblox-link' }, options || {});
  if (!callback || !callback.code) throw new RobloxOAuthError('link.oauthFailed');

  const pending = loadPending();
  if (!pending) throw new RobloxOAuthError('link.oauthExpired');

  // Reject a callback that does not belong to the flow this tab started.
  if (pending.state && callback.state && pending.state !== callback.state) {
    clearPending();
    throw new RobloxOAuthError('link.oauthStateMismatch');
  }

  let idToken = null;
  try { idToken = await getIdToken(); } catch (e) { idToken = null; }
  if (!idToken) throw new RobloxOAuthError('link.needSignIn');

  let res;
  try {
    res = await fetch(oauthConfig.endpoint + '/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: callback.code, codeVerifier: pending.verifier, idToken }),
    });
  } catch (e) {
    throw new RobloxOAuthError('link.blocked');
  }

  let payload = null;
  try { payload = await res.json(); } catch (e) { payload = null; }

  if (!res.ok || !payload || !payload.ok || !payload.roblox) {
    const detail = String((payload && payload.error) || ('HTTP ' + res.status));
    // Only blame the authorisation code when Roblox itself rejected it. A bare
    // "expired" is not enough: the Worker answers 401 with "unauthenticated:
    // token expired" when the *Firebase* token is stale, and telling somebody to
    // restart the Roblox flow for that would send them the wrong way. The two
    // need different words because they need different actions: refresh and
    // retry, versus start again.
    const robloxRejected = /roblox/i.test(detail) && /invalid_grant|expired|redeem|already/i.test(detail);
    if (robloxRejected) {
      throw new RobloxOAuthError('link.oauthCodeExpired', detail);
    }
    throw new RobloxOAuthError('link.oauthFailed', detail);
  }

  const profile = profileFromOAuth(payload.roblox, Date.now());
  try {
    localStorage.setItem(config.storageKey, JSON.stringify(profile));
  } catch (e) {
    throw new RobloxOAuthError('link.oauthFailed', 'could not store the link');
  }
  clearPending();

  return { profile, refreshToken: payload.refreshToken || null };
}

/**
 * Asks the Worker to revoke the authorisation, so unlinking on the site also
 * ends the grant on Roblox's side rather than only forgetting it locally.
 * Returns true when Roblox confirmed the revocation.
 */
export async function revokeOAuth(refreshToken, getIdToken) {
  if (!refreshToken) return false;
  let idToken = null;
  try { idToken = await getIdToken(); } catch (e) { idToken = null; }
  if (!idToken) return false;

  try {
    const res = await fetch(oauthConfig.endpoint + '/unlink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, refreshToken }),
    });
    if (!res.ok) return false;
    const payload = await res.json();
    return !!(payload && payload.ok && payload.revoked);
  } catch (e) {
    // A failed revoke must not stop the visitor from unlinking locally.
    return false;
  }
}
