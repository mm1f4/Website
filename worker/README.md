# XCOPE Roblox link service

The browser can never perform Roblox's OAuth token exchange, because it requires
the app's **client secret**. This Worker is the small server that does it: it
holds the secret, redeems the one-time authorisation code, and returns only the
public profile of the Roblox account.

It also proves *who* is asking by verifying the caller's **Firebase ID token**
against Google's published signing certificates. A stolen authorisation code is
therefore useless to anyone else.

```
browser (GitHub Pages)                 Cloudflare Worker            Roblox
  │                                          │                         │
  │ 1. PKCE verifier + challenge             │                         │
  │──────────────────────────────────────────┼────────────────────────>│ /oauth/v1/authorize
  │ 2. user approves, redirected back with ?code=...&state=...          │
  │                                                                     │
  │ 3. POST /exchange { code, codeVerifier, idToken }                   │
  │─────────────────────────────────────────>│                         │
  │                                          │ verify Firebase ID token │
  │                                          │ POST /oauth/v1/token ───>│ (client_secret here)
  │                                          │ GET  /oauth/v1/userinfo >│
  │ 4. { roblox: { id, username, avatar } }  │                         │
  │<─────────────────────────────────────────│                         │
```

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/health` | – | `{ ok: true }` |
| `POST` | `/exchange` | `{ code, codeVerifier, idToken }` | `{ ok, roblox, refreshToken }` |
| `POST` | `/unlink` | `{ idToken, refreshToken }` | `{ ok, revoked }` |

## Setup

### 1. Register the Roblox OAuth app

1. Open the [OAuth 2.0 Apps page](https://create.roblox.com/dashboard/credentials?activeTab=OAuthTab)
   in the Creator Dashboard and click **Create App**.
2. Give it a globally unique name, accept the terms, and create it.
3. **Copy the Client ID and Secret immediately.** The secret is shown only once.
4. Set the **App Category** to *Account Linking Tools*.
5. Add the scopes **`openid`** and **`profile`** (`profile` requires `openid`).
6. Add these **Redirect URLs**:
   - `https://mm1f4.github.io/Website/`
   - `http://localhost:5500/` (for local testing)
7. The app stays in **private mode**, limited to 10 users. That is enough while
   you are testing. Publishing to everyone needs a demo video and Roblox review.

### 2. Deploy the Worker

```bash
cd worker
npm install

npx wrangler secret put ROBLOX_CLIENT_ID
npx wrangler secret put ROBLOX_CLIENT_SECRET
npx wrangler secret put ROBLOX_REDIRECT_URI     # https://mm1f4.github.io/Website/
npx wrangler secret put FIREBASE_PROJECT_ID     # x-cope-website

npx wrangler deploy
```

`wrangler deploy` prints the Worker URL. It looks like:

```
https://xcope-roblox-link.<your-subdomain>.workers.dev
```

Put that value into `ROBLOX_LINK_ENDPOINT` in `index.html`, then commit and push.

If Cloudflare asks you to log in, `npx wrangler login` opens a browser. A free
Cloudflare account is enough; no card is required.

### 3. Check it

```bash
curl https://xcope-roblox-link.<your-subdomain>.workers.dev/health
# {"ok":true,"service":"xcope-roblox-link"}
```

## Security notes

- `ROBLOX_CLIENT_SECRET` exists only as a Worker secret. It is never sent to the
  browser, never logged, and never committed.
- Every `/exchange` call requires a valid, unexpired Firebase ID token whose
  audience matches `FIREBASE_PROJECT_ID`, so only signed-in users of your site
  can use it.
- `ALLOWED_ORIGINS` restricts which sites may call the Worker from a browser.
- Roblox access tokens are used inside the Worker and then discarded. Only the
  refresh token is returned, so the site can offer an unlink button.
- `redirect_uri` is sent on the token exchange and must match the value
  registered on the Roblox app.
