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

The site is three files plus assets, and it deliberately has **no build step**:
`index.html` holds the markup, styles and one inline ES module; `css/style.css`
holds all styling; `js/roblox.js` is a separate module for Roblox linking.

```
index.html          markup, i18n dictionaries, the whole page script
css/style.css       every style, organised into numbered sections
js/roblox.js        Roblox username lookup + About me code verification
link-service/       optional Cloudflare Worker (see below); not deployed yet
.nojekyll           tells Pages to serve files as-is
.gitattributes      keeps line endings LF so diffs stay readable
```

## Live features

- **Bilingual** English / Traditional Chinese with a dictionary, a header
  toggle, and detection of the browser language on a first visit. Choice is
  remembered. `?lang=zh` / `?lang=en` override it.
- **Colour theme**: light, dark or follow the system, independent of the
  background. Stored under `xcope-theme`.
- **Background**: animated default, four preset gradients, or the visitor's own
  picture. Independent of the theme: any background works under either theme.
  Stored under `xcope-background`.
- **Accounts** via Firebase Authentication (email and password), including
  sign-up, sign-in, password reset, email verification and a resend path.
- **Profile page** at `#profile`, guarded so only signed-in visitors reach it.
  Holds profile details, account info, password change, preferences, background
  and connected accounts.
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
3. **Roblox OAuth app** — not registered. See "Roblox" below.
4. **Cloudflare Worker** — `link-service/` is written but not deployed.

## Roblox

Two paths exist, and the choice matters.

**In use now: username + About me code.** The visitor types their username, the
site shows a code, they paste it into their Roblox profile's About me, then press
Verify. This proves they control the account. No backend and no Roblox review is
needed.

**Written but inactive: official OAuth 2.0.** Roblox's token exchange requires
the app's client secret, which can never be in a browser, so it needs the Worker
in `link-service/`. The Worker already implements the exchange and verifies the
caller's Firebase ID token. To switch:

1. Register an app at
   https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab with
   category **Account Linking Tools**, scopes `openid profile`, and the redirect
   URL `https://mm1f4.github.io/Website/`.
2. `cd link-service && npm install && npx wrangler login && npx wrangler deploy`
3. `npx wrangler secret put` for `ROBLOX_CLIENT_ID`, `ROBLOX_CLIENT_SECRET`,
   `ROBLOX_REDIRECT_URI`, `FIREBASE_PROJECT_ID`.
4. Put the Worker URL in `ROBLOX_PROXY_ENDPOINT` in `index.html`.

A new Roblox app is limited to **10 users** until it passes Roblox's review,
which requires a one minute demo video.

**The Worker is also needed for the current method** if the visitor's network
blocks Roblox, which is described next. It can proxy the plain public Roblox API
with no secrets at all (`/roblox/lookup`, `/roblox/user`).

## Environment facts worth knowing

- **Roblox is unreachable from the owner's machine.** Every Roblox host times
  out over HTTPS. GitHub, Google and Cloudflare work. This means the Roblox API
  cannot be exercised from that machine, and the linking feature will not work
  there without the Worker proxy.
- **The shell is Windows PowerShell 5.1.** No ternary operator, and quoting
  through `node -e` from PowerShell breaks often. Prefer writing a small `.cjs`
  file and running it, rather than long inline commands.
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

Delete every harness afterwards. `git status` should be clean, and no `.dsh-*`
file should remain.

## Known gaps

- Roblox link and background choice live in one browser, not synced. Moving them
  to Firestore is the obvious next step and needs the security rules written.
- `link-service/` has had its logic verified by importing the module and
  stubbing the upstream network, but it has never run against the real Roblox
  API, because that API is unreachable from the development machine.
- The Roblox bio-code path has been exercised against a stubbed Roblox API with
  a real browser, not against the live service.
- Nothing loads Roblox data in-game yet. When the link is synced, the Roblox
  experience would read the stored id to recognise the player.
- The contact section shows `6fcymcapsbcc@gmail.com` and a Discord invite. Both
  are intentional and public.

## Non-negotiables

- **Never commit a secret.** The Roblox client secret belongs only in the
  Worker. The Firebase web API key in `index.html` is public by design and is
  not a secret.
- **Do not hand-edit the Roblox client secret into any file.**
- The tester who built this used a temporary Git credential already stored on
  the machine for pushes. Do not print it.
