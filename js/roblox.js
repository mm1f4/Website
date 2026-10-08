/**
 * Roblox account linking without OAuth.
 *
 * The visitor types their Roblox username, the site looks up the public profile,
 * and then proves ownership by asking them to paste a short code into their
 * Roblox "About me". The site reads the public description back and checks for
 * the code. Nothing secret is involved, so no server is required.
 *
 * This is deliberately the manual method. Roblox's official OAuth 2.0 needs the
 * app's client secret, which cannot live in a browser, so it requires a small
 * backend. Swapping to it later means replacing this file: the panel markup and
 * the stored shape stay the same.
 */

const USERS_BY_USERNAME = 'https://users.roblox.com/v1/usernames/users';
const USER_BY_ID = 'https://users.roblox.com/v1/users/';
const THUMBNAILS = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';

const DEFAULT_STORAGE_KEY = 'xcope-roblox-link';
const CODE_PREFIX = 'XCOPE-';
const CODE_TTL_MS = 30 * 60 * 1000; // a pending verification lasts 30 minutes

/* ----------------------------------------------------------------- errors */

export class RobloxLinkError extends Error {
  constructor(key, detail) {
    super(detail || key);
    this.key = key; // an i18n key the UI can translate
    this.detail = detail || '';
  }
}

/* -------------------------------------------------------------- utilities */

/** Turns a uid into a short, readable, hard-to-guess verification code. */
export function generateVerificationCode(uid, salt) {
  const source = String(uid || '') + '|' + String(salt || '');
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters
  let out = '';
  let value = hash >>> 0;
  for (let i = 0; i < 6; i++) {
    out += alphabet[value % alphabet.length];
    value = Math.floor(value / alphabet.length) + (value % 7) * 31;
  }
  return CODE_PREFIX + out;
}

/** True when `description` contains the code, ignoring case, spaces and dashes. */
export function descriptionHasCode(description, code) {
  if (!description || !code) return false;
  const normalise = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return normalise(description).indexOf(normalise(code)) !== -1;
}

/** Builds the stored profile from the Roblox responses. */
export function toProfile(user, thumbnailUrl, code, verifiedAt) {
  return {
    id: String(user.id),
    username: user.name || '',
    displayName: user.displayName || user.name || '',
    description: user.description || '',
    createdAt: user.created || null,
    avatarUrl: thumbnailUrl || null,
    profileUrl: 'https://www.roblox.com/users/' + user.id + '/profile',
    code: code || '',
    verifiedAt: verifiedAt || Date.now(),
  };
}

/* ------------------------------------------------------------- Roblox API */

/**
 * The proxy endpoint, when one is configured. Many networks block Roblox
 * entirely (some corporate and campus networks do), and Roblox does not always
 * send CORS headers, so a failed direct call falls back to this. Leave it empty
 * to run without a proxy; a blocked network then reports link.blocked.
 */
let proxyEndpoint = '';

/** Sets the proxy base URL, for example https://xcope-roblox.name.workers.dev */
export function setProxyEndpoint(url) {
  proxyEndpoint = String(url || '').replace(/\/$/, '');
  return proxyEndpoint;
}

export function hasProxy() {
  return !!proxyEndpoint;
}

/** Turns an HTTP status from either path into the right error. */
function statusError(status) {
  if (status === 429) return new RobloxLinkError('link.rateLimited');
  if (status === 404) return new RobloxLinkError('link.userNotFound');
  return new RobloxLinkError('link.lookupFailed', 'HTTP ' + status);
}

/** Resolves a username to a Roblox user record. Throws link.userNotFound. */
export async function lookupUserByName(username) {
  const wanted = String(username).trim();

  // 1. Roblox directly.
  try {
    const res = await fetch(USERS_BY_USERNAME, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [wanted], excludeBannedUsers: true }),
    });
    if (res.ok) {
      const payload = await res.json();
      const list = (payload && payload.data) || [];
      if (!list.length) throw new RobloxLinkError('link.userNotFound');
      return list[0];
    }
    // A real HTTP answer (404, 429, ...) is not a CORS problem, so do not retry.
    throw statusError(res.status);
  } catch (e) {
    if (e instanceof RobloxLinkError) throw e;
    // Otherwise the request never completed: likely CORS or a blocked network.
    if (!proxyEndpoint) throw new RobloxLinkError('link.blocked');
  }

  // 2. Through the proxy.
  let res;
  try {
    res = await fetch(proxyEndpoint + '/roblox/lookup?username=' + encodeURIComponent(wanted));
  } catch (e) {
    throw new RobloxLinkError('link.blocked');
  }
  if (!res.ok) throw statusError(res.status);
  const payload = await res.json();
  if (!payload.ok || !payload.user) {
    throw new RobloxLinkError(payload.error === 'not-found' ? 'link.userNotFound' : 'link.lookupFailed', payload.error || '');
  }
  return {
    id: String(payload.user.id),
    name: payload.user.username,
    displayName: payload.user.displayName,
    description: '',
  };
}

/** Full public profile for a user id. */
export async function fetchUserById(id) {
  try {
    const res = await fetch(USER_BY_ID + encodeURIComponent(id));
    if (res.ok) return res.json();
    throw statusError(res.status);
  } catch (e) {
    if (e instanceof RobloxLinkError) throw e;
    if (!proxyEndpoint) throw new RobloxLinkError('link.blocked');
  }

  let res;
  try {
    res = await fetch(proxyEndpoint + '/roblox/user?id=' + encodeURIComponent(id));
  } catch (e) {
    throw new RobloxLinkError('link.blocked');
  }
  if (!res.ok) throw statusError(res.status);
  const payload = await res.json();
  if (!payload.ok || !payload.user) {
    throw new RobloxLinkError('link.lookupFailed', (payload && payload.error) || '');
  }
  return {
    id: payload.user.id,
    name: payload.user.username,
    displayName: payload.user.displayName,
    description: payload.user.description,
    created: payload.user.createdAt,
    avatarUrl: payload.user.avatarUrl,
  };
}

/** Avatar headshot URL, or null when Roblox has not generated one. */
export async function fetchAvatarUrl(id) {
  try {
    const res = await fetch(
      THUMBNAILS + '?userIds=' + encodeURIComponent(id) + '&size=150x150&format=Png&isCircular=false'
    );
    if (res.ok) {
      const payload = await res.json();
      const first = payload && payload.data && payload.data[0];
      if (first && first.state === 'Completed' && first.imageUrl) return first.imageUrl;
      return null;
    }
    return null;
  } catch (e) {
    // Fall through to the proxy; an avatar is cosmetic, so failures return null.
  }

  if (!proxyEndpoint) return null;
  try {
    const res = await fetch(proxyEndpoint + '/roblox/user?id=' + encodeURIComponent(id));
    if (!res.ok) return null;
    const payload = await res.json();
    return (payload && payload.user && payload.user.avatarUrl) || null;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------------------------- factory */

export function createRobloxLink(options) {
  const config = Object.assign({
    storageKey: DEFAULT_STORAGE_KEY,
    storage: null, // { save, load, clear }; defaults to localStorage
  }, options || {});

  const store = config.storage || {
    save: (value) => { try { localStorage.setItem(config.storageKey, JSON.stringify(value)); } catch (e) {} },
    load: () => { try { return JSON.parse(localStorage.getItem(config.storageKey) || 'null'); } catch (e) { return null; } },
    clear: () => { try { localStorage.removeItem(config.storageKey); } catch (e) {} },
  };

  const PENDING_KEY = config.storageKey + ':pending';

  function savePending(pending) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch (e) {}
  }
  function loadPending() {
    try {
      const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null');
      if (!raw) return null;
      if (!raw.startedAt || Date.now() - raw.startedAt > CODE_TTL_MS) return null;
      return raw;
    } catch (e) { return null; }
  }
  function clearPending() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
  }

  return {
    /** Configures the proxy used when Roblox cannot be reached directly. */
    setProxyEndpoint(url) {
      return setProxyEndpoint(url);
    },

    /** The stored link, or null. */
    load() {
      const saved = store.load();
      return saved && saved.id ? saved : null;
    },

    isLinked() {
      return !!this.load();
    },

    /** Step 1: resolve the username and return the code the visitor must paste. */
    async begin(username, uid) {
      const trimmed = String(username || '').trim();
      if (!trimmed) throw new RobloxLinkError('link.enterUsername');

      const found = await lookupUserByName(trimmed);
      const code = generateVerificationCode(uid, found.id);
      const pending = {
        id: String(found.id),
        username: found.name || trimmed,
        displayName: found.displayName || found.name || trimmed,
        code: code,
        startedAt: Date.now(),
      };
      savePending(pending);
      return pending;
    },

    /** The pending verification, if it has not expired. */
    pending: loadPending,

    /** Step 2: read the public description and look for the code. */
    async confirm() {
      const pending = loadPending();
      if (!pending) throw new RobloxLinkError('link.expired');

      const user = await fetchUserById(pending.id);
      if (!descriptionHasCode(user.description, pending.code)) {
        throw new RobloxLinkError('link.codeNotFound');
      }

      const avatarUrl = await fetchAvatarUrl(pending.id);
      const profile = toProfile(user, avatarUrl, pending.code, Date.now());
      store.save(profile);
      clearPending();
      return profile;
    },

    /** Forgets the link. There is nothing to revoke on Roblox's side. */
    unlink() {
      store.clear();
      clearPending();
      return true;
    },

    cancel() {
      clearPending();
    },
  };
}

/** Renders a linked Roblox account into an element. */
export function renderRobloxLink(container, profile, labels) {
  if (!container) return;
  const text = labels || {};
  while (container.firstChild) container.removeChild(container.firstChild);

  if (!profile || !profile.id) {
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

  const info = document.createElement('div');
  info.className = 'roblox-text';

  const name = document.createElement('strong');
  name.textContent = profile.displayName || profile.username || 'Roblox user';
  info.appendChild(name);

  const handle = document.createElement('span');
  handle.textContent = profile.username ? '@' + profile.username : '';
  info.appendChild(handle);

  container.appendChild(avatar);
  container.appendChild(info);

  if (profile.profileUrl) {
    const visit = document.createElement('a');
    visit.href = profile.profileUrl;
    visit.target = '_blank';
    visit.rel = 'noopener noreferrer';
    visit.className = 'roblox-visit';
    visit.textContent = text.viewProfile || 'View profile';
    container.appendChild(visit);
  }
}
