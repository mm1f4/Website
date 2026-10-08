/**
 * Roblox account linking for the XCOPE site.
 *
 * Roblox's token exchange needs the app's client secret, so this file never sees
 * it. It performs the browser half of the OAuth 2.0 authorisation code flow with
 * PKCE and hands the one-time code to a small server (see ../worker), which does
 * the exchange and returns the public Roblox profile.
 *
 * Usage, once the Worker is deployed:
 *   import { createRobloxLink } from './js/roblox-link.js';
 *   const link = createRobloxLink({
 *     endpoint: 'https://xcope-link.you.workers.dev',
 *     redirectUri: location.origin + location.pathname,
 *     getIdToken: () => currentUser.getIdToken(),
 *     onLinked: (profile) => { ...store it... },
 *   });
 *   link.start();          // begin authorising
 *   link.handleRedirect(); // call once on load, consumes ?code=&state=
 */

const AUTHORIZE_URL = 'https://apis.roblox.com/oauth/v1/authorize';
const SCOPES = 'openid profile';
const STATE_KEY = 'xcope-roblox-state';
const VERIFIER_KEY = 'xcope-roblox-verifier';

/* ------------------------------------------------------------------ PKCE */

function randomUrlSafe(bytes) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = '';
  buffer.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  new Uint8Array(digest).forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* --------------------------------------------------------------- factory */

export function createRobloxLink(options) {
  const config = Object.assign({
    endpoint: '',
    clientId: '',
    redirectUri: '',
    getIdToken: null,
    onLinked: null,
    onError: null,
    storage: null, // { save(profile), load(), clear() }
  }, options || {});

  const memory = { profile: null };

  function store(profile) {
    memory.profile = profile;
    if (config.storage && config.storage.save) {
      try { config.storage.save(profile); } catch (e) { /* storage blocked */ }
    }
  }

  function load() {
    if (memory.profile) return memory.profile;
    if (config.storage && config.storage.load) {
      try {
        const saved = config.storage.load();
        if (saved) memory.profile = saved;
      } catch (e) { /* storage blocked */ }
    }
    return memory.profile;
  }

  function clear() {
    memory.profile = null;
    if (config.storage && config.storage.clear) {
      try { config.storage.clear(); } catch (e) { /* ignore */ }
    }
  }

  function isConfigured() {
    return !!config.endpoint && !!config.clientId && !!config.redirectUri;
  }

  /** Sends the browser to Roblox to authorise. */
  async function start() {
    if (!isConfigured()) {
      const message = 'Roblox linking is not configured yet. See worker/README.md.';
      if (config.onError) config.onError(new Error(message));
      return false;
    }

    const verifier = randomUrlSafe(64);
    const state = randomUrlSafe(24);

    try {
      sessionStorage.setItem(VERIFIER_KEY, verifier);
      sessionStorage.setItem(STATE_KEY, state);
    } catch (e) {
      if (config.onError) config.onError(new Error('This browser blocked session storage, so the link cannot be verified.'));
      return false;
    }

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: SCOPES,
      response_type: 'code',
      state: state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: 'S256',
    });

    location.assign(AUTHORIZE_URL + '?' + params.toString());
    return true;
  }

  /**
   * Consumes ?code=&state= if present. Returns the linked profile, or null when
   * there is nothing to consume.
   */
  async function handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const returnedState = params.get('state');
    const error = params.get('error');
    const errorDescription = params.get('error_description');

    if (!code && !error) return null;

    // Strip the query string so a refresh does not replay a spent code.
    const clean = location.pathname + location.hash;
    if (history.replaceState) history.replaceState(null, '', clean);

    if (error) {
      const e = new Error(errorDescription || error);
      if (config.onError) config.onError(e);
      return null;
    }

    let verifier = null;
    let expectedState = null;
    try {
      verifier = sessionStorage.getItem(VERIFIER_KEY);
      expectedState = sessionStorage.getItem(STATE_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
    } catch (e) { /* ignore */ }

    if (!verifier) {
      const e = new Error('This link has expired. Please start again.');
      if (config.onError) config.onError(e);
      return null;
    }
    if (!expectedState || returnedState !== expectedState) {
      const e = new Error('The security check failed, so the link was refused.');
      if (config.onError) config.onError(e);
      return null;
    }
    if (!isConfigured()) {
      const e = new Error('Roblox linking is not configured yet.');
      if (config.onError) config.onError(e);
      return null;
    }

    let idToken = null;
    try {
      idToken = config.getIdToken ? await config.getIdToken() : null;
    } catch (e) { /* handled below */ }
    if (!idToken) {
      const e = new Error('Please sign in first, then link your Roblox account.');
      if (config.onError) config.onError(e);
      return null;
    }

    let payload;
    try {
      const res = await fetch(config.endpoint.replace(/\/$/, '') + '/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code, codeVerifier: verifier, idToken: idToken }),
      });
      payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || ('request failed with status ' + res.status));
    } catch (e) {
      if (config.onError) config.onError(e);
      return null;
    }

    const profile = Object.assign({}, payload.roblox, { linkedAt: Date.now() });
    store(profile);
    if (payload.refreshToken) {
      try { sessionStorage.setItem('xcope-roblox-refresh', payload.refreshToken); } catch (e) { /* ignore */ }
    }
    if (config.onLinked) config.onLinked(profile);
    return profile;
  }

  /** Revokes the authorisation on Roblox and forgets the link. */
  async function unlink() {
    let refreshToken = null;
    try { refreshToken = sessionStorage.getItem('xcope-roblox-refresh'); } catch (e) { /* ignore */ }

    let idToken = null;
    try { idToken = config.getIdToken ? await config.getIdToken() : null; } catch (e) { /* ignore */ }

    if (isConfigured() && idToken) {
      try {
        await fetch(config.endpoint.replace(/\/$/, '') + '/unlink', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: idToken, refreshToken: refreshToken }),
        });
      } catch (e) { /* revoking is best effort; the local link still clears */ }
    }

    try { sessionStorage.removeItem('xcope-roblox-refresh'); } catch (e) { /* ignore */ }
    clear();
    return true;
  }

  return {
    start: start,
    handleRedirect: handleRedirect,
    unlink: unlink,
    load: load,
    isConfigured: isConfigured,
    isLinked: () => !!load(),
  };
}

/** Renders a linked Roblox account into an element. */
export function renderRobloxLink(container, profile) {
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!profile) {
    container.classList.add('is-hidden');
    return;
  }
  container.classList.remove('is-hidden');

  const avatar = document.createElement('img');
  avatar.className = 'roblox-avatar';
  avatar.alt = '';
  avatar.width = 48;
  avatar.height = 48;
  if (profile.avatarUrl) {
    avatar.src = profile.avatarUrl;
  } else {
    avatar.style.background = 'var(--accent-gradient)';
  }

  const text = document.createElement('div');
  text.className = 'roblox-text';

  const name = document.createElement('strong');
  name.textContent = profile.displayName || profile.username || 'Roblox user';
  text.appendChild(name);

  const handle = document.createElement('span');
  handle.textContent = profile.username ? '@' + profile.username : '';
  text.appendChild(handle);

  container.appendChild(avatar);
  container.appendChild(text);

  if (profile.profileUrl) {
    const link = document.createElement('a');
    link.href = profile.profileUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'roblox-visit';
    link.textContent = 'View profile';
    container.appendChild(link);
  }
}
