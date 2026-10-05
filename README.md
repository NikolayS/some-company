# Some Company

**Like some company?** A small, working travel-companion service for sharing a meal, a day out, or a bounded part of a journey. Solo travellers and couples; platonic, not dating. Bottle green, tomato and cream; no fake member listings.

## Implemented

- Passwordless email sign-in through Resend. Browser-bound, hashed, expiring, one-use magic links; explicit confirmation avoids email scanners consuming links. HttpOnly opaque session cookies, stored hashed, 30-day expiry and logout revocation.
- Persistent solo/couple profiles with introductions, interests, pace and languages. No member emails in public plan/profile responses.
- Create, edit, close and delete your own plans. Date/destination/type filters. Meals and day plans last one day; trip segments span at most 31 days and can start within two years. 1–6 guest places.
- Private join requests and conversations; owner accept/decline, guest withdraw. Couples use two places. Capacity enforced server-side; accepted guests lock plan dates/destination/type against unexpected changes.
- Block/unblock, member reports, and an email-allowlisted admin report console with suspension/restoration. Suspended accounts lose sessions and public visibility.
- Self-service account deletion with cascading deletion of member plans/requests/messages. Reports retain text with removed account references.
- Same-origin JSON writes, restrictive CSP, bounded input, SQLite-backed rate limits, parameterized SQL, server-side authorization. No third-party frontend scripts, fonts, analytics, or runtime packages. Playwright Core is a development-only browser-test dependency.

## Local development

Node.js **24 or newer** is required for built-in `node:sqlite`.

```sh
cp .env.example .env
npm ci
npm run dev
```

Browse http://localhost:3000. To try sign-in without sending real email, set `DEV_EMAIL_CONSOLE=1` in `.env`: links appear **only in the local server console**, never in API responses or the UI. This mode refuses to start with a production environment or non-loopback `APP_URL`. Open each link in the same browser that requested it. Do not expose development mode to the internet.

```sh
npm run build   # JavaScript syntax validation; there is no asset compilation step
npm test        # HTTP integration tests, real SQLite/auth/session/authorization logic
npx playwright-core install chromium
npm run test:browser  # Full two-member browser flow; no real email sent
npm start
```

No seeded users or test data are included. The first account creates its own profile and plan.

## Production configuration

Copy `.env.example` to a private `.env` or use your host's secret manager:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV=production` | Enforces HTTPS origin and prohibits development email delivery. |
| `APP_URL=https://some-company.samo.team` | Exact external origin. Used for magic links, origin checks and secure cookies. |
| `RESEND_API_KEY` | Resend sending key; never commit. |
| `EMAIL_FROM=Some Company <hello@your-verified-domain>` | Sender on a domain verified in the same Resend account. |
| `ADMIN_EMAILS` | Comma-separated exact administrator emails. These accounts sign in normally. Without this configuration, reports have no UI reviewer. |
| `DATABASE_PATH=/data/some-company.sqlite` | Durable database path. Directory is created with mode 0700. |
| `PORT=3000` | HTTP listen port; binds 0.0.0.0. |
| `TRUST_PROXY=1` | Only set behind a trusted proxy that **overwrites** incoming `X-Forwarded-For`. Otherwise use 0. |
| `DEV_EMAIL_CONSOLE=0` | Keep disabled in production. |

The server starts without email credentials to permit health checks and public browsing, but sign-in explicitly returns unavailable until both sending variables are configured. A Resend API key alone does not prove sender authorization. Real delivery must be checked with a consenting account after deploy. No email has to be sent by the test suite.

### Container deployment

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3000/healthz
```

Compose exposes loopback port 3000. Put it behind an HTTPS reverse proxy for the configured origin. The container runs as an unprivileged user with read-only application files; the named `some-company-data` volume is writable. Preserve that volume during redeploys. Do not use `docker compose down -v` unless intentionally deleting all data.

A platform can also run `npm ci && npm run build` then `npm start` directly with Node 24+, a persistent database directory, the production variables and an HTTPS proxy. SQLite is appropriate for a single application instance; do not scale replicas across separate disks. For a second instance or high write load, migrate to a shared database first.

### Launch checklist

- Configure HTTPS `APP_URL`, verified Resend sender, sending key and a responsible `ADMIN_EMAILS` reviewer.
- Configure durable volume and scheduled, encrypted backups with retention appropriate for the service. Never use a raw copy of a live WAL database alone. Use SQLite's online backup facility or stop the app before copying the database, `-wal` and `-shm` together. Test restoration.
- Confirm `/healthz`, public empty state, real sign-in email, profile save, plan creation, guest request, acceptance and private replies on the actual domain.
- Ensure the proxy overwrites forwarded IP headers before enabling `TRUST_PROXY`. The app port should not be public when trusting a proxy.
- Review the privacy/community copy against the actual operator, support process and backup retention. The early-release copy describes the software behavior, not a jurisdiction-specific legal template.
- Assign someone to check reports. No automated alert or 24/7 monitoring is claimed.

## Tests

`test/app.test.js` exercises the running HTTP server, not mocked route functions: token hashing, browser binding, reuse and expiration; session logout; origin checks; anonymous/owner/stranger authorization; private-email exclusion; destination/date/type search; coupled seat capacity and request transitions; private-message isolation; blocking; moderator allowlists and suspension; date limits and throttling; deletion cascades; disk persistence across reopening. Email transport is injected so tests send no real messages.

The browser smoke test runs two isolated browser accounts through email-link confirmation, profile creation, plan publishing, join requests, owner acceptance and private replies, and checks a 390px mobile viewport for horizontal overflow. Use `CHROME_PATH=/usr/bin/google-chrome npm run test:browser` to reuse an installed Chrome instead of downloading Chromium.

## Early-release boundaries

- Inbox updates on refresh; no realtime delivery, email notifications, read receipts or unread counters yet.
- Up to 100 public plans per filtered query and 200 request summaries; conversation cap 500 messages. Narrow search or start a fresh plan when appropriate.
- Localized date formatting; English interface. No map/geocoding, automatic destination synonym matching or location tracking.
- Accounts have email access checks, **not** identity/background verification. No bookings, payments, insurance, safety guarantees or travel sales.
- Sign-in links intentionally require the requesting browser. Embedded mail-app browsers may require copying the link back to the original browser.
- Display profile/plan text is rendered escaped; public content should not contain sensitive details.
- Reports are available to admins, not sent externally. Admins cannot browse private conversations through the UI; a reporter can quote relevant text. Operators with database access technically can read stored messages; no end-to-end encryption claim.
- Single-instance database schema is initialized idempotently at boot; future schema changes need versioned migrations before rollout.

## Structure

- `server.js`: HTTP API, schema, authorization, auth/email transport and static asset service.
- `public/`: responsive accessible client, CSS and vector identity.
- `test/app.test.js`: isolated HTTP integration suite.
- `Dockerfile`, `compose.yaml`: durable single-node deployment.
- `.github/workflows/ci.yml`: Node checks, tests and image build.
