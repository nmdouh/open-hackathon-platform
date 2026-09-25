# Contributing

Thank you for helping institutions run fair, well-organised hackathons.

## Getting started

```bash
git clone <your fork>
cd open-hackathon-platform
npm install
npm run dev -- --seed      # starts a local PostgreSQL and a demo hackathon
npm test                   # runs the full suite against a throw-away PostgreSQL
```

You need Node.js 20.11 or newer. The tests and `npm run dev` start an embedded
PostgreSQL automatically, so nothing else has to be installed.

## Ground rules

- **Business rules live on the server.** The browser only reflects them. Every
  new rule needs a server check, a database constraint where possible, and a test.
- **Keep the stack small.** The server uses Express, `pg` and zod. The web UI
  is plain HTML, CSS and JavaScript with no build step. Please discuss new
  dependencies in an issue first.
- **Keep it bilingual.** Every user-facing string goes in `web/js/i18n.js` in
  both English and Arabic, and layouts must work right-to-left.
- **Keep it institution-neutral.** Do not add names, logos, internal URLs or
  data of any specific organisation. Branding belongs in deployment configuration.
- **Never commit secrets.** Use `.env` locally; it is git-ignored.
- **Audit state changes.** Any endpoint that changes data writes an audit entry
  in the same transaction.

## Pull requests

1. Open an issue describing the problem or feature, unless the fix is trivial.
2. Keep each pull request focused, and include tests.
3. Run `npm test` before pushing.
4. By contributing, you agree that your contribution is licensed under the
   Apache License 2.0 (see `LICENSE`).

## Translations

Arabic and English ship today. To add a language, add its dictionary in
`web/js/i18n.js`, then open a pull request with a native speaker's review.
