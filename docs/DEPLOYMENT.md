# Deployment

The platform is one Node.js process plus a PostgreSQL database. Run it behind
HTTPS (a reverse proxy such as nginx, Caddy or your cloud load balancer).

## Option A — Docker Compose

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, APP_NAME, and optionally the LLM_* settings
docker compose up -d
docker compose exec app npm run create-admin -- --email admin@your-institution.org --name "Event Admin"
```

The admin password is printed once; change it after signing in (Profile → Change password).
Migrations run automatically every time the app starts.

## Option B — Node.js and an existing PostgreSQL

1. Create a UTF-8 database and a role that owns it:

   ```sql
   CREATE ROLE ohp LOGIN PASSWORD 'change-me';
   CREATE DATABASE ohp OWNER ohp ENCODING 'UTF8' TEMPLATE template0;
   ```

   PostgreSQL 13 or newer is required (the schema uses the built-in `gen_random_uuid()`).

2. Install and configure:

   ```bash
   npm ci --omit=dev
   export NODE_ENV=production
   export DATABASE_URL=postgres://ohp:change-me@db-host:5432/ohp
   export APP_NAME="Your Institution Hackathon"
   npm run create-admin -- --email admin@your-institution.org
   npm start
   ```

3. Put it behind HTTPS and set `TRUST_PROXY=1` so rate limiting sees real client addresses.

## Checklist before opening registration

- [ ] HTTPS in front, `NODE_ENV=production` (secure cookies are then on by default)
- [ ] `ALLOW_SIGNUP` set the way you want
- [ ] At least two administrators (the last one cannot be removed, but a spare avoids lock-out)
- [ ] Hackathon created, with tracks, timeline, team size and deadlines
- [ ] Screening round created with its committee and chair
- [ ] Mentors added (they need accounts first)
- [ ] Database backups scheduled — the audit log is your record of how decisions were made

## AI coach (optional)

Set `LLM_ENDPOINT`, `LLM_MODEL` and, if your provider needs one, `LLM_API_KEY`.
Any OpenAI-compatible `/chat/completions` endpoint works, including self-hosted
models, so participant text can stay inside your network. `LLM_DAILY_LIMIT`
caps requests per person per day. Prompts are not stored.

## Upgrading

Pull the new version and restart. Pending migrations run at start-up under an
advisory lock, so several instances can start together safely.
