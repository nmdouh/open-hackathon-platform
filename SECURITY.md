# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting instead: open the repository's
**Security** tab and choose **Report a vulnerability**. Include the steps to
reproduce, the affected version or commit, and the impact you expect.

You should receive an acknowledgement within 7 days. A fix is normally
released within 30 days of confirmation, and reporters are credited in the
release notes unless they prefer otherwise.

## Supported versions

Only the latest release receives security fixes while the project is below 1.0.

## How the platform protects deployments

- **No secrets in the repository or the browser.** Database URLs and AI keys
  are read from environment variables on the server only.
- **Passwords** are hashed with scrypt (N=2^15). Only the SHA-256 of each
  session token is stored, so a database dump cannot be replayed as sessions.
- **Sessions** use `HttpOnly`, `SameSite=Lax` cookies, marked `Secure` in production.
- **CSRF.** Mutations must be JSON, and cross-origin `Origin` headers are refused.
- **Authorisation is enforced on the server.** Team capacity, one team per
  person, one live idea per owner and the other participation rules are
  checked in transactions with row locks, and backed by unique indexes.
- **Audit log.** Every state change made through the API is recorded with the actor.
- **Headers.** A strict Content-Security-Policy with no inline scripts, `nosniff`, and `frame-ancestors 'none'`.

## Operator checklist

- Run behind HTTPS. Set `NODE_ENV=production` (it implies `COOKIE_SECURE=true`)
  and `TRUST_PROXY` when a proxy sits in front.
- Use a dedicated PostgreSQL role that owns only this database.
- Set `ALLOW_SIGNUP=false` if accounts should be created only by administrators or SSO.
- The built-in rate limiter is per process. Add a proxy-level limit when you run several instances.
- Back up the database. The audit log is part of your evidence trail for judging decisions.
