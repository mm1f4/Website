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

How the landing page is put together, in the order it paints:

```
<head> inline script   theme, the reveal switch, and whether the intro plays
#intro                 the brand curtain, CSS-animated, removed once lifted
#bgLayer               the painted background (animated / preset / visitor picture)
header                 nav, the scroll-progress hairline, language + theme toggles
main  hero → about → contact → features
footer                 profile link, legal links
button#toTop           back to top, appears after 640px of scroll
auth modal + script    Firebase, i18n, routing, reveal, scroll furniture, intro
```

`privacy.html` and `terms.html` are registered as the Privacy Policy URL and
Terms of Service URL on the Roblox OAuth application, so their URLs are load
bearing: `https://mm1f4.github.io/Website/privacy.html` and
`.../terms.html`. Renaming or moving either one breaks the Roblox app
registration. They are deliberately single-language English, because the forms
that consume them are English.

## Live features

- **Intro reveal** on the first load of the landing page: the XCOPE wordmark
  arrives letter by letter, a progress line fills as the page and the webfonts
  actually become ready, then the curtain lifts and the hero lines rise in
  behind it. See "Intro and first paint" below for the rules that keep it from
  becoming a trap.
- **Reading aids**: a scroll-progress hairline in the header, the current
  section highlighted in the menu, a back-to-top button after 640px, and a skip
  link that is the first thing a keyboard visitor reaches.
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
- **git is a per-user portable install at `%LOCALAPPDATA%\Programs\Git`**
  (2.56.0.windows.4, MinGit), with `...\Git\cmd` appended to the user PATH. The
  machine-wide `C:\Program Files\Git` that an earlier session recorded was gone:
  no `git` on PATH, no App Paths entry, no uninstall record. `winget` is not
  usable in this profile either (`winget --info` exits -1978335231), so the
  MinGit archive was downloaded with Node and expanded into the user profile. A
  shell that was already running keeps its old PATH, so call `git.exe` by full
  path or open a new terminal. The identity is set **per repository** to
  `mm1f4 <6fcymcapsbcc@gmail.com>`; there is no global identity.
- **PowerShell cannot make TLS connections here; Node can.** Every
  `Invoke-WebRequest` and `curl.exe` attempt dies in schannel with
  `SEC_E_NO_CREDENTIALS`, while DNS and plain TCP answer normally. Downloads
  therefore go through a throwaway `.cjs` using `fetch`; that is also why the git
  install above could not use winget.
- **This folder is a git checkout**, `main` tracking `origin/main` of
  `github.com/mm1f4/Website`. It was adopted rather than cloned: `git init`,
  `git remote add`, `git fetch`, then `git reset --soft FETCH_HEAD` so the index
  matched the remote without touching a single working file. That is the way to
  bring an unversioned copy of a live site under git without a merge. The
  checkout was shallow for a while - the reset left one grafted base commit - and
  `git fetch --unshallow` restored the full history.
- **The shell is Windows PowerShell 5.1**, not 7: a `pwsh` call that looked like
  it should be 7 reported 5.1.26100. The quoting advice still holds and is worth
  keeping: inline `node -e` through PowerShell breaks often, so prefer writing a
  small `.mjs` file and running it. `node`, `npm` and `npx` are not on PATH, so
  call Node by its full path.
- **Headless Chrome works when the session runs unsandboxed.** Under a sandbox
  every launch died with `mojo platform_channel.cc: Check failed`, because the
  sandbox denies named pipes. With `danger-full-access`,
  `C:\Program Files\Google\Chrome\Application\chrome.exe --headless=new
  --remote-debugging-port=…` drives a real page, and `node:crypto`'s global
  `WebSocket` is enough to speak CDP with no npm dependency. One trap: a
  *background* headless tab barely produces frames, so `requestAnimationFrame`
  callbacks and `IntersectionObserver` notifications are throttled. Taking a
  screenshot forces a frame; read computed styles after one, not before.
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
  That check does not catch a key present in `en` and missing from `zh`, which
  renders English to a Chinese visitor silently - compare the key sets too.
- **The landing copy describes the game now, not the template it started as.**
  The hero, About and the three cards were rewritten because they still said
  "a minimal starting point for your next web project". Nothing in them invents
  player counts, modes or dates; keep it that way unless the owner confirms a
  fact. The page title comes from `meta.title`, not from the hero headline.
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

The pass that added the intro ran exactly this, with 21 checks, and all of them
passed. Worth copying rather than re-deriving:

- Load with `?lang=en` so a Chinese-language machine does not decide what the
  screenshots show.
- Assert the intro is armed, lifts on its own, and leaves the DOM; then that the
  hero headline is actually opaque afterwards, which is the failure that a
  half-finished intro would produce.
- Assert `.btn-ghost` has no background image. Comparing `background-color`
  proves nothing, because `.btn` paints a *gradient* and its colour is
  transparent.
- Scroll, force a frame, then read the progress hairline and the highlighted
  menu item. Reading before a frame measures the headless throttle.
- Click through both themes and both languages; check `document.title` and
  `documentElement.lang`.
- Re-run in a second tab with `Emulation.setEmulatedMedia` set to
  `prefers-reduced-motion: reduce`, and assert the intro never appears.
- Open `/#profile` in a third tab and assert the same, since a deep link is the
  other skip condition.
- Count elements whose text equals their own `data-i18n` key, and separately
  compare the two dictionaries key by key. The first finds a missing string in
  the page; only the second finds a key that exists in `en` but not `zh`.

The neon restyle was verified the same way, with 59 checks, all passing. Beyond
the list above it asserted: both webfonts and the CJK face actually loaded;
dictionary key parity and every `data-i18n` key used in the page; dark, light and
auto (with an emulated dark OS) including the `theme-color` meta; the Chinese
heading resolving to the 900 CJK face; all four preset gradients swapping their
light/dark variants with the theme; WCAG contrast for body text, muted text,
links and button labels in both themes; no horizontal overflow at 1440, 768 and
390; the mobile menu opening without overflowing; the footer reveal; the modal
opening and closing; the intro arming, lifting and leaving the DOM; the intro
being skipped under `prefers-reduced-motion` and on the `#profile` deep link; and
both legal pages still laying out, including their stored-theme chrome colour.
The one real bug it caught was invisible in screenshots: `html[lang="zh"]` never
matched `zh-Hant`, so Chinese headlines were falling back to a 400-weight face
next to 400-weight Anton.

The marquee retheme touched no markup: design tokens, the ember and gold frames,
and the theme-color value in three files. It was verified with 46 checks, all
passing - per-theme contrast read back from the browser rather than computed on
paper, light/dark variants for all four background presets, i18n parity in both
languages, no horizontal overflow at 1440/768/390, the mobile menu, both legal
pages, the reduced-motion intro skip, and the Worker's `/health`. One check
compared the deployed Pages build against the working tree, which is how the
push was confirmed to have landed.

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
- `scroll-padding-top` (72px) makes the browser's own fragment jumps clear the
  sticky header. The script measures the real header and adds 12px for its own
  scrolls, so only native jumps depend on the token.

## Visual identity

The site was restyled as a "marquee arcade": an arcade cabinet's title screen,
printed rather than glassy. This replaced the earlier lime-and-violet "neon
arcade" pass, so a lime in a screenshot means an old build.

- **Two colours, three tokens.** `--neon` is the marquee gold (`#ffc53d`) and
  never changes; `--neon-2` is the ember (`#ff6a3d`) it casts and fades into;
  `--neon-3` is a single cool teal that only the animated background uses.
  `--accent` is the *readable* version of the brand colour and does change: a
  deep bronze in light (`#7c4a06`), the gold itself in dark. Use `--accent` for
  body-size text and `--neon` for fills and decoration. Gold text on paper fails
  contrast, which is why the two are split.
- **Paper and ink.** Light is warm paper (`#f6f0e1`) under warm ink (`#1b1917`);
  dark is a warm near-black (`#0a0908`) under off-white (`#ece6dc`). The
  `theme-color` meta in all three HTML files mirrors those two values, and the
  legal pages repeat them in their own inline script.
- **Contrast is measured, not eyeballed.** Both themes are read back from the
  browser: body text >= 15:1, muted text >= 6:1 light and >= 7:1 dark, accent
  text >= 6.5:1, dark button label on gold 12.5:1. Changing a surface token means
  re-running that pass.
- **Fonts**: Anton for h1/h2/h3 and the wordmark, Space Grotesk for text, and
  the system monospace stack for labels and eyebrows. Noto Sans TC carries CJK
  at 400/500/700/900. Anton has no CJK and only a 400 face, so
  `html:lang(zh) h1, h2, h3` asks for 900: Anton renders at 400 (with
  `font-synthesis-weight: none` stopping a fake bold) while the CJK fallback
  picks the real 900 face. Write `:lang(zh)`, not `[lang="zh"]`, because the
  page sets `zh-Hant`.
- **Shape**: 2px radii, 1px borders and hard offset shadows. Elevation is meant
  to look printed, not glassy; the auth modal is the one soft shadow left.
- **Both themes are the same design**, printed on warm paper or a warm near-black.
  `--text-on-accent` is dark in both themes because the button is gold in both.
- **The ticker** between the hero and About is decorative markup
  (`aria-hidden`): two identical copies so `translateX(-50%)` loops seamlessly.
- **Section indexes** (`01 // ABOUT`) come from a CSS counter over `.about`,
  `.contact` and `.features`, so they follow document order automatically.
- **The hero fold** is `min-height: calc(100svh - 100px)` so the ticker is fully
  visible at the bottom of a desktop first screen. It is `overflow: hidden`
  because the decorative glow would otherwise create horizontal scroll on a
  phone. If the header or the ticker height changes, retune that 100px and
  `scroll-padding-top`.

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

## Intro and first paint

The curtain is deliberately the last thing anyone can get stuck behind, so each
rule below exists for a failure that was actually reachable. It is ink in both
themes on purpose: it is the game's title card, not a page surface, so a light
visitor sees a short dark reveal and then the bone page.

- **CSS draws it; the script only decides when to lift it.** If the module never
  runs at all, a classic script at the end of the body lifts the curtain after
  four seconds. A blocked CDN import therefore costs a short wait, not a dead
  page.
- **It is armed in `<head>`, before the first paint**, by the same inline script
  that applies the theme. `html.is-intro` is what makes the overlay visible, so
  with scripting off it never exists.
- **It is skipped** for `prefers-reduced-motion: reduce`, for a deep link into
  the profile (`#profile`, `#panel-*`, `#roblox-oauth`), and for a tab that has
  already seen it. The flag is `sessionStorage["xcope-intro"]`, written when the
  curtain starts to lift rather than at load, so closing the tab halfway through
  means seeing it again rather than never seeing it.
- **`?intro=1` replays it**; that is the quickest way to preview a change to it.
- **A click or any key lifts it immediately.** Otherwise it waits for the `load`
  event and `document.fonts.ready`, capped at 2.6s, with a 1.35s minimum so the
  wordmark can be read rather than glimpsed.
- **The hero has its own entrance** (`.is-intro` hides, `.intro-done` animates)
  rather than the shared scroll reveal, so it rises as the curtain lifts instead
  of arriving behind it already finished.
- **The overlay is removed from the DOM** once it is out of the way, so it can
  never intercept a click or hold the scroll lock.

The scroll-reveal styles are scoped to `html.js-reveal`, which the head script
adds only when `IntersectionObserver` exists. Before that every `.is-reveal`
section was `opacity: 0` with nothing to undo it, so a visitor with JavaScript
off saw the hero, About, contact and footer as blank bands.

Two cascade traps are worth remembering, because both were live:

- **`.btn-ghost` lost to `.btn`.** They have the same specificity and `.btn` is
  declared later, so every "ghost" button rendered as a solid one. Both rules
  are now written `.btn.btn-ghost`.
- **Reveal transitions must stay before the component rules** (section 3 of the
  stylesheet), or they win the cascade over the card hover transition.

## Background strength

A picture behind the page needs a scrim or headings become unreadable, and the
two modes need very different amounts. As it stands the light scrim is strong
(`0.9`, bone rather than white), which keeps everything readable but washes a
picture back noticeably; the dark scrim is `0.64` and lets far more of the
picture through. Presets do not have this problem, because their light variants
are pale by design. The custom-image base painted under the photo in light mode
is the same bone tone (`BG_IMAGE_BASE` in `index.html`), so an uploaded picture
warms rather than cools. If the washed-out look in light mode is unwanted, the
fix is to reduce the scrim and give the hero its own frosted panel, rather than
to weaken the scrim alone.

## Known gaps

- **There is no link to the Roblox experience anywhere on the site**, because no
  URL was ever supplied and inventing one would be worse than not having it. The
  hero therefore leads with the Discord invite and a jump to About. Adding a
  Play button is one anchor in the hero plus two dictionary keys.
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
