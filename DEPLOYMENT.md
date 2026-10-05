# Some Company — production handoff

Target: `https://some-company.samo.team`. Public repository:
`https://github.com/samo-agent/some-company`.

The code is ready for a single-instance Docker deployment. The domain's current
SAMO placeholder is **not** this application. No production deployment or real
email delivery has been verified yet.

## Required operator inputs

- An existing authorized SAMO application host, deployment access, and access to
  the SAMO ingress routing configuration. Do not provision a new paid VM by
  following this document.
- A Resend sending key and a sender address on its verified domain.
- The responsible administrator's email address for member reports.
- An unused loopback port and a persistent volume with backups.

## App host

Run on the selected host with Docker Compose installed and an account permitted
to manage this application. Review the existing host layout first:

```sh
git clone https://github.com/samo-agent/some-company.git
cd some-company
cp .env.example .env
chmod 600 .env
```

Edit the private `.env` (never commit it):

```dotenv
APP_URL=https://some-company.samo.team
HOST_PORT=3036
RESEND_API_KEY=<configured privately>
EMAIL_FROM=Some Company <sender@verified-domain>
ADMIN_EMAILS=<responsible-admin-email>
TRUST_PROXY=0
DEV_EMAIL_CONSOLE=0
```

Port 3036 is an example, not a reserved port. Choose an unused port before
starting. Compose sets production mode and the internal database path:

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3036/healthz
```

## HTTPS routing

Have the SAMO operator replace the placeholder route for **only**
`some-company.samo.team` with this app's upstream. If ingress is on the app
host, proxy to `127.0.0.1:3036`. If the control plane is separate, establish an
app-host proxy reachable exclusively from that control plane; the container's
loopback port is intentionally not remotely accessible. Follow the existing
SAMO TLS/origin routing configuration rather than replacing its Caddyfile.

Keep `TRUST_PROXY=0` until the trusted ingress overwrites incoming
`X-Forwarded-For`; multi-proxy setups must preserve only a verified client IP.
Without that change rate limiting uses the proxy's IP, which is conservative
but shared across visitors.

## Acceptance and ongoing operation

1. Confirm the actual brand page at the target URL (not just HTTP 200).
2. Confirm `/healthz` returns `{"ok":true}` and `/api/me` has `emailReady:true`.
3. With a consenting test account, request and receive a real sign-in email;
   open its link in the requesting browser and save a profile.
4. Use a second account to request a plan; verify acceptance, private replies,
   and isolation from a third account.
5. Verify the administrator can review member reports.
6. Schedule and verify SQLite backups/restoration as described in README.

The volume contains member data. Keep it during upgrades; never run
`docker compose down -v` as a redeploy step. A normal update is `git pull
--ff-only` followed by `docker compose up -d --build`, only after CI passes.
Do not run multiple replicas with separate SQLite databases.
