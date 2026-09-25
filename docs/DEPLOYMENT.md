# Deployment

The platform is one Node.js process plus a PostgreSQL database. Run it behind
HTTPS (a reverse proxy such as nginx, Caddy or your cloud load balancer).

## Option A — Docker Compose

```bash
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, SETTINGS_SECRET and APP_NAME
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

The easiest way: sign in as an administrator and open **Administration → AI coach**.
Enter the endpoint URL, the model name and the API key, press **Save**, then
**Test connection** (it tests the saved settings). Tick *Enable the AI coach* to
switch it on for participants.

- Any OpenAI-compatible `/chat/completions` endpoint works, including self-hosted
  models (for example Ollama at `http://localhost:11434/v1/chat/completions`),
  so participant text can stay inside your network.
- The API key is **write-only**: it is stored encrypted (AES-256-GCM) and the page
  only ever shows its last four characters. Storing it requires the
  `SETTINGS_SECRET` environment variable; keep that value stable and backed up,
  because changing it makes the stored key unreadable (you would re-enter it).
- The daily limit caps requests per person. Prompts are not stored.

Alternatively, configure it through `LLM_ENDPOINT`, `LLM_MODEL`, `LLM_API_KEY`
and `LLM_DAILY_LIMIT`. Settings saved on the admin page take precedence;
**Use environment settings** on that page returns to the variables.

## Upgrading

Pull the new version and restart. Pending migrations run at start-up under an
advisory lock, so several instances can start together safely.
