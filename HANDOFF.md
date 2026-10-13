# Handoff

Context for a new session picking up this project. Read this first, then check
`git log` for the recent shape of the work.

## What this is

A single-page static website for a Roblox game called **X Cope**, plus a small
optional backend service.

| | |
| --- | --- |
| Repository | `github.com/mm1f4/Website` (public) |
| Live site | https://mm1f4.github.io/Website/ |
| Hosting | GitHub Pages, `main` branch, `/ (root)`, no build step |
| Deployment | push to `main`; Pages rebuilds in about 1–2 minutes |

The site is a handful of files plus assets, and it deliberately has **no build
step**: `index.html` holds the markup, styles and one inline ES module;
`css/style.css` holds all styling; `js/roblox.js` is a separate module for Roblox
linking; and the two legal pages are plain documents that reuse the same
stylesheet.

```
index.html          markup, i18n dictionaries, the whole page script
css/style.css       every style, organised into numbered sections
css/legal.css       the reading column for privacy.html and terms.html only
js/roblox.js        Roblox username lookup + About me code verification
privacy.html        Privacy Policy; a required field on the Roblox app form
terms.html          Terms of Service; the other required field
link-service/       Cloudflare Worker, deployed as xcope-roblox
.nojekyll           tells Pages to serve files as-is
.gitattributes      keeps line endings LF so diffs stay readable
```

`privacy.html` and `terms.html` are registered as the Privacy Policy URL and
Terms of Service URL on the Roblox OAuth application, so their URLs are load
bearing: `https://mm1f4.github.io/Website/privacy.html` and
`.../terms.html`. Renaming or moving either one breaks the Roblox app
registration. They are deliberately single-language English, because the forms
that consume them are English.

## Live features

- **Bilingual** English / Traditional Chinese with a dictionary, a header
  toggle, and detection of the browser language on a first visit. Choice is
  remembered. `?lang=zh` / `?lang=en` override it.
- **Colour theme**: light, dark or follow the system, independent of the
  background. Stored under `xcope-theme`.
- **Background**: animated default, four preset gradients, or the visitor's own
  picture. Independent of the theme: any background works under either theme.
  Stored under `xcope-background`. The gradients moved out of JavaScript and
  into the stylesheet as `--bg-<name>`, defined once per theme, so each preset
  has a light and a dark variant that swaps with the theme through pure CSS. The
  stored value records only the preset name, never the variant. A picture needs
  its light-mode base repainted by script, which `paintTheme` does.
- **Accounts** via Firebase Authentication (email and password), including
  sign-up, sign-in, password reset, email verification and a resend path.
- **Profile page** at `#profile`, guarded so only signed-in visitors reach it.
  Holds profile details, account info, password change, preferences, background
  and connected accounts. The sidebar sections are plain anchors
  (`#panel-account`, `#panel-password`, …) and are part of the profile route, not
  separate pages: refreshing on one keeps you there.
- **Refresh keeps your place.** Reloading on a profile panel returns to that
  panel, at the position you left, without animating. The panel is remembered in
  `sessionStorage` under `xcope-panel` and the position under `xcope-scroll`, so
  the URL is not the only record. See "Routing and restore" below; there are
  several traps here.
- **Avatar upload**: resized on the device and stored on the user record as a
  small data URL, so it syncs across devices without Cloud Storage.
- **Roblox linking** by username plus an About me verification code. Stored in
  `localStorage` for now.

## Places only the owner can act

These need console access I do not have. Ask before assuming they are done.

1. **Firebase Authentication** — user list at
   https://console.firebase.google.com/project/x-cope-website/authentication/users
   contains throwaway accounts created while testing, safe to delete:
   `xcope.profile.test@gmail.com`, `xcope.photo.probe@gmail.com`,
   `xcope.photo.probe2@gmail.com`, and several `domain.probe.*@example.com`.
2. **Firestore** — not enabled. Needed if the Roblox link and the background
   should sync across devices instead of living in one browser.
3. **Roblox OAuth app** — registered. Client ID `3025970434055453261`, category
   Account Linking Tools, scopes `openid profile`. The secret could not be read
   back, so treat the Worker's copy as the only one.
4. **Cloudflare Worker** — deployed as `xcope-roblox` at
   `https://xcope-roblox.xcope.workers.dev`, and its URL is already in
   `ROBLOX_PROXY_ENDPOINT`. `/health` answers without any secret at all.

## Roblox

Two paths exist, and the choice matters.

**In use now: official OAuth 2.0, alongside the About me code.** The visitor
presses Continue with Roblox, authorises on Roblox's own site, and comes back
linked. This is the path Roblox's app review asks for, and it is the one to
demonstrate. The About me method is kept as a second option on the same panel: it
needs no review, and the app's 10-user limit does not apply to it, so removing it
would trade away a working route for nothing.

**The About me path is not independent of the Worker**, which an earlier version
of this file got wrong. Roblox sends no CORS headers on any of the three
endpoints it uses - `users.roblox.com/v1/usernames/users`,
`users.roblox.com/v1/users/<id>` and
`thumbnails.roblox.com/v1/users/avatar-headshot` all answer 200 with no
`access-control-allow-origin`, and the username POST answers 405 to a preflight -
so a browser can never read them directly. Reaching Roblox from the page is only
possible through the Worker, which is server-to-server and so not subject to
CORS. The direct attempt in `js/roblox.js` is kept because it costs one failed
request and would start working if Roblox ever added the header.

Consequence worth remembering: the Worker's `ALLOWED_ORIGINS` must contain the
exact origin the site is served from. Opening `index.html` from the filesystem,
or from a Live Server port that is not listed, makes every lookup fail. The list
is `https://mm1f4.github.io` plus ports 5501 on `127.0.0.1` and `localhost`,
matching `.vscode/settings.json`.

**OAuth 2.0 is live and has completed a real authorisation.** Getting there took
six separate faults, five of them in this repository and none of them reachable
without a browser signing in for real. They are worth reading before touching
this path, because every one of them produced a plausible-looking failure:

1. **The callback arrives in the query string, not the fragment.** Roblox appends
   `?code=...` to the registered redirect URI. `takeCallback` originally looked
   only inside `#`, so it never matched and the code sat in the address bar until
   it expired a minute later, with nothing shown to the visitor. It now reads
   both and strips the URL to the pathname.
2. **A callback is not a route.** `#roblox-oauth?code=...` is neither `#profile`
   nor a `#panel-*` hash, so the router sent the visitor to the landing page and
   the auth pass, which is where the exchange runs, never ran. `resolveRoute` now
   recognises the callback and returns the profile route.
3. **The panel the visitor was on has to be parked.** The panel is normally
   remembered through the fragment, and the fragment is gone by the time Roblox
   returns. The button parks it in sessionStorage instead.
4. **`importKey('spki', ...)` was given a whole X.509 certificate.** Google's
   endpoint returns certificates; WebCrypto wants only the SubjectPublicKeyInfo
   inside one, and a browser rejects the certificate outright with "Invalid SPKI
   input". Node's own crypto unwraps it happily, which is why this survived every
   stubbed test. `extractSpkiFromCertificate` now walks the DER and finds the key
   by its shape - not by position, because in a v3 certificate the last field of
   tbsCertificate is the extensions block. Two wrong turns are recorded in that
   function's comments: assuming a two byte DER header, and assuming the key is
   the last field.
5. **Credentials must not be sent twice.** Roblox answers "Ambiguous request
   because multiple authentication methods are used" if client_id is in the body
   while an Authorization header is also present. The Basic form now sends only
   grant_type, code, code_verifier and redirect_uri.
6. **`FIREBASE_PROJECT_ID` must equal the page's `firebaseConfig.projectId`.**
   The Worker compares the token's audience against it. The two live in different
   files and different systems, and nothing said they had to match.

Diagnostics added along the way, all still in place and worth keeping:
`window.__lastLinkError`, the exchange interceptor pattern in the console, and a
Worker that reports both sides of a mismatch. The `invalid_client` failure now
names the client id it sent and the secret's length; neither is sensitive, and
without them a wrong stored value is indistinguishable from a wrong secret.

1. Register an app at
   https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab — done,
   Client ID `3025970434055453261`, category Account Linking Tools, scopes
   `openid profile`.
2. `cd link-service && npm install && npx wrangler login && npx wrangler deploy`
   — done; **redeploy after any Worker edit**, since only secrets take effect
   immediately.
3. `npx wrangler secret put` for `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET`,
   `ROBLOX_REDIRECT_URI`, `FIREBASE_PROJECT_ID` — done.
4. Put the Worker URL in `ROBLOX_PROXY_ENDPOINT` in `index.html` — done.

A new Roblox app is limited to **10 users** until it passes Roblox's review,
which requires a one minute demo video.

## Environment facts worth knowing

- **Roblox is reachable from the owner's machine, but not readable by the
  browser.** An earlier version of this file said every Roblox host times out.
  That is no longer true: `users.roblox.com`, `thumbnails.roblox.com` and
  `www.roblox.com` all answer 200, and `apis.roblox.com` answers 401 without a
  token, which is the expected unauthenticated reply. This was tested with a
  plain Node request. A direct request does still work for **checking the API by
  hand**, which is how the Worker's three Roblox endpoints were confirmed
  against the live service. It does not make the page work without the Worker;
  see the CORS note under "Roblox" for why.
- **git is installed per-user at `%LOCALAPPDATA%\Programs\Git`** (2.55.0), with
  the identity already set to `mm1f4 <6fcymcapsbcc@gmail.com>`. It is on the
  machine PATH, but a shell started before the install keeps the old
  environment, so an already-running terminal may need a restart before `git`
  resolves.
- **The shell is Windows PowerShell 7 (`pwsh`), not 5.1.** An earlier version of
  this file said 5.1. The quoting advice still holds and is worth keeping:
  inline `node -e` through PowerShell breaks often, so prefer writing a small
  `.cjs` file and running it. Note that `node`, `npm` and `npx` are not on PATH
  by default, so call Node by full path or add it first.
- **A browser cannot be launched under the agent sandbox.** Chrome and Edge both
  die with `mojo platform_channel.cc: Check failed` because the sandbox
  denies named pipes, so the headless-Chrome verification described below cannot
  be reproduced from inside a sandboxed session. It still needs a real terminal.
  Everything reachable without a browser is still worth doing: `node --check`
  for syntax, importing the modules and stubbing `fetch`, and fetching the live
  files to compare against the working tree.
- **OneDrive interferes with atomic file replaces.** Writing a file that was
  recently deleted, or edited by a script, can fail with
  `ReplaceFileW EIO (Win32 1175)`. Retrying usually works; otherwise write to a
  new filename or apply the change with a Node script that writes in place.
- **The repository stores LF.** Run a normalising pass before committing if a
  file gained CRLF.

## Conventions used here

- **Style**: `index.html` and `css/style.css` are meant to stay readable. The
  stylesheet is split into numbered sections with a table of contents; keep that
  order and renumber if you insert one.
- **Comments** explain *why*, not what. Several comments record a decision that
  was reversed, which is deliberate.
- **Every user-facing string is a dictionary key.** Add it to both `en` and `zh`
  or the language toggle will show a raw key. A quick check: render the page and
  count elements whose text equals their own `data-i18n` value; it must be 0.
- **Commits** are written as a short imperative subject plus a body explaining
  the reasoning and exactly what was verified. Match that style.

## How the work has been verified

Verification is done by driving a real headless Chrome over the DevTools
protocol from a throwaway Node script, then deleting the script. The pattern
that works:

- Serve the site from a tiny local `http.createServer`, so it is on an origin
  rather than `file://`.
- Launch Chrome with `--headless=new --remote-debugging-port=…`, attach over the
  WebSocket, and drive it with `Runtime.evaluate`.
- Use `Fetch.enable` plus `Fetch.fulfillRequest` to stub Firebase, Roblox, or
  anything else that must not be called for real.
- Assert with a small `check(label, condition)` helper so the output lists
  passes and failures.
- Screenshot with `Page.captureScreenshot` and read the image back to catch
  layout problems that assertions miss. Several real bugs were found this way
  and only this way.

When a browser cannot be launched at all (see the sandbox note above), fall back
to what does not need one, and say plainly in the commit which checks were
skipped rather than implying the page was seen:

- `node --check` for syntax on every changed `.js`.
- Import the real module and stub `fetch`, so the branch under test actually
  executes. This is what proved the avatar proxy fallback was unreachable.
- Fetch the deployed files and compare them byte for byte against the working
  tree, which catches a failed Pages build.
- Compare the i18n dictionaries key by key, since a key present in only one
  language silently renders English to a Chinese visitor.
- Exercise the deployed Worker directly with the production `Origin` header.

Delete every harness afterwards. `git status` should be clean, and no `.dsh-*`
file should remain.

## Routing and restore

Why a refresh on `#panel-password` used to land on the landing page, and what the
fix has to keep doing. Each of these was found by driving a real headless browser,
not by reading the code:

- The router only accepted `location.hash === "#profile"` verbatim, so any panel
  hash fell through to `HOME`. A panel hash now means the profile route.
- **The fragment is removed from the URL at boot**, and put back once the panel
  has been reached. Chrome fires its fragment scroll while the profile page is
  still `display: none`, so the target has no box, the jump is dropped, and the
  visitor is left at the top. `#profile` and the panel then go into the URL
  through `pushState`, which does not scroll.
- **The restore belongs to the auth pass, not the boot pass.** The boot pass runs
  before Firebase has restored the session, when the profile is empty and far too
  short to scroll to a panel; scrolling there silently does nothing.
- **A scroll issued while the target is hidden is dropped.** `whenVisible` waits
  for a frame in which the element has a box before scrolling.
- **Use the two-argument `scrollTo(x, y)`.** The `{ top, behavior }` form is
  swallowed on this page after it reveals an element, leaving the visitor at the
  top with no error. `PAGE_SCROLL` exists for that reason.
- **`html.is-jumping` suppresses smoothing for the restore only.** A refresh
  should look as though the page was always there; clicking a link should still
  animate.
- `scroll-padding-top` (97px, the sticky header plus the script's 12px gap) makes
  the browser's own fragment jumps clear the header. The script uses the same
  offset for its own scrolls.

## Theme handling

Verified working, so treat a change here as a regression to check for:

- Three choices: light, dark, and auto. Auto follows the OS through
  `prefers-color-scheme` and keeps following it if the OS changes.
- A first visit follows the OS. Picking light or dark stores an explicit choice
  that overrides the OS and survives a reload.
- The stored value is `xcope-theme`; `data-theme-choice` records the intent and
  `data-theme` the resolved result.
- An inline script in `<head>` applies the theme before the body paints, so
  there is no flash of the wrong theme.
- Both toggles, the header one and the profile one, stay in step.
- Theme and background are independent: any background works under either theme,
  and each theme supplies its own scrim so text stays readable.

## Background strength

A picture behind the page needs a scrim or white headings become unreadable, and
the two modes need very different amounts. As it stands the light scrim is
strong (`0.86`), which keeps everything readable but washes a picture back
noticeably; the dark scrim is `0.6` and lets far more of the picture through.
Presets do not have this problem, because their light variants are pale by
design. If the washed-out look in light mode is unwanted, the fix is to reduce
the scrim and give the hero its own frosted panel, rather than to weaken the
scrim alone.

## Known gaps

- Roblox link and background choice live in one browser, not synced. Moving them
  to Firestore is the obvious next step and needs the security rules written.
- **Official OAuth is now proven end to end.** A real visitor signed in on
  Roblox, authorised the app, came back, and the site stored the link: the
  success message appeared with the Roblox display name, username, avatar and a
  working View profile link. `/health`, `/roblox/lookup`, `/roblox/user` and
  `/exchange` have all been exercised against the live service, along with the
  CORS headers for the production origin and the refusal of an unlisted origin.
  `/unlink` has **not** been exercised against the live service, so the revoke
  call is still unproven.
- **The bio-code path still has not been completed end to end against the live
  service.** What was proved without a browser: `begin()` resolved a real username
  through the Worker and produced a correctly shaped code, `confirm()` correctly
  refused with `link.codeNotFound` when the code was not on the profile, and the
  matching rule tolerates the spaces, case and punctuation Roblox may introduce.
  Nobody has yet pasted a real code into a
  real About me and seen the link succeed.
- Ongoing cost of the Worker CORS list: adding a new test origin means editing
  `ALLOWED_ORIGINS` and redeploying, or every request from that origin fails.
- Nothing loads Roblox data in-game yet. When the link is synced, the Roblox
  experience would read the stored id to recognise the player.
- The contact section is the Discord invite only
  (https://discord.gg/dFQqAMZkb4). The mailto form and the email address were
  deliberately removed, so there is no longer any email route in the site.

## Non-negotiables

- **Never commit a secret.** The Roblox client secret belongs only in the
  Worker. The Firebase web API key in `index.html` is public by design and is
  not a secret.
- **Do not hand-edit the Roblox client secret into any file.**
- The tester who built this used a temporary Git credential already stored on
  the machine for pushes. Do not print it.
