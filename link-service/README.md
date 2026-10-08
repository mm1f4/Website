# XCOPE Roblox link service

One small server doing two jobs, so the website never has to hold a secret.

1. **Proxy the public Roblox API.** Many networks block Roblox outright (some
   office, campus and ISP networks do), and Roblox does not always send CORS
   headers, so the browser tries Roblox directly and falls back to this. No
   secret is involved.
2. **Exchange a Roblox OAuth 2.0 authorisation code.** That call requires the
   app's client secret, which must never reach a browser. The endpoint also
   verifies the caller's Firebase ID token, so a stolen code is useless to
   anybody else. Only needed once you move to the official OAuth method.

## Endpoints

| Method | Path | Body / query | Returns |
| --- | --- | --- | --- |
| `GET` | `/health` | – | `{ ok: true }` |
| `GET` | `/roblox/lookup` | `?username=foo` | `{ ok, user: { id, username, displayName } }` |
| `GET` | `/roblox/user` | `?id=123` | `{ ok, user: { …, description, avatarUrl } }` |
| `POST` | `/exchange` | `{ code, codeVerifier, idToken }` | `{ ok, roblox, refreshToken }` |
| `POST` | `/unlink` | `{ idToken, refreshToken }` | `{ ok, revoked }` |

## Deploy

Free, and no card required.

```bash
cd link-service
npm install
npx wrangler login      # opens a browser once
npx wrangler deploy
```

`wrangler deploy` prints the Worker URL, for example:

```
https://xcope-roblox.<your-subdomain>.workers.dev
```

Put that into `ROBLOX_PROXY_ENDPOINT` in `index.html`, then commit and push.
Check it with:

```bash
curl https://xcope-roblox.<your-subdomain>.workers.dev/health
# {"ok":true,"service":"xcope-roblox"}
```

## Only if you move to OAuth 2.0 later

Register the app at the [OAuth 2.0 Apps page](https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab)
with the category **Account Linking Tools**, scopes `openid` and `profile`, and
the redirect URL `https://mm1f4.github.io/Website/`. The secret is shown once.

```bash
npx wrangler secret put ROBLOX_CLIENT_ID
npx wrangler secret put ROBLOX_CLIENT_SECRET
npx wrangler secret put ROBLOX_REDIRECT_URI     # https://mm1f4.github.io/Website/
npx wrangler secret put FIREBASE_PROJECT_ID     # x-cope-website
npx wrangler deploy
```

A newly registered Roblox app is limited to **10 users** until it passes
Roblox's review, which needs a one minute demo video.

## Security notes

- `ROBLOX_CLIENT_SECRET` exists only as a Worker secret. It is never sent to a
  browser, never logged and never committed.
- `/exchange` and `/unlink` require a valid, unexpired Firebase ID token whose
  audience matches `FIREBASE_PROJECT_ID`, verified against Google's published
  signing certificates.
- `ALLOWED_ORIGINS` restricts which sites may call the Worker from a browser.
- Roblox access tokens are used inside the Worker and discarded. Only the
  refresh token is returned, so the site can offer an unlink button that really
  revokes the authorisation.
