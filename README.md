# Open Hackathon Platform

**Run innovation hackathons fairly and in the open.** A free, self-hosted platform for institutions — universities, public bodies, companies, NGOs — to run a hackathon from registration to final judging, in **English and Arabic** (full right-to-left support).

Licensed under the [Apache License 2.0](LICENSE).

## What it does

| Stage | Features |
|---|---|
| **Registration** | Accounts, one registration per person per hackathon, two roles: *idea owner* or *team member*, skills and bio |
| **Ideas** | Drafts and submission with a structured template (problem, solution, users, impact, data), tracks, deadlines |
| **Teams** | One team per idea, applications **and invitations**, explainable **skill matchmaking** (suggested teams for members, suggested people for owners), capacity limits, search and filters |
| **Mentoring** | Mentor roster with expertise and capacity, team requests, mentors claim and schedule sessions, notes shared with the team |
| **Build milestones** | An interactive build roadmap: each team ticks off milestones with evidence links; progress shows on team cards, Pulse and the organiser dashboard |
| **Progress wall** | Daily updates, blockers, demo links and *help wanted* posts that other teams can answer; a **Pulse** view flags teams quiet for 48 hours |
| **Screening, reviews, final judging** | Review rounds with weighted criteria, a committee with a chair, private scoring, declared and automatic conflicts of interest, minimum votes, top-N or majority suggestions, overrides that require a written reason, finalisation and published results |
| **Toolbox** | Bilingual guides, a copy-ready **prompt library**, a segmented **pitch rehearsal timer**, organiser resources, and an optional **AI coach** that gives feedback against the hackathon's own criteria |
| **Participant experience** | A **journey stepper** and a personal *next step*, live countdown and statistics, **in-app notifications**, results podium, light/dark themes |
| **Administration** | **Organiser dashboard** (participation funnel, teams at risk, track and review progress), settings, timeline, milestones, announcements, participant export, AI coach settings, users, and an append-only **audit log** |

### Fairness by design

- Every rule is enforced **on the server**, inside database transactions, and backed by constraints — not only in the browser.
- Reviewers score privately; only the chair and administrators see combined results.
- Participants cannot review or mentor in their own hackathon; mentors are automatically blocked from judging teams they coach.
- Criteria are locked once scoring opens, so every vote uses the same rubric.
- Any decision that differs from the computed suggestion is recorded as an **override** with its reason.

## Quick start (development)

Requires **Node.js 20.11+**. Nothing else — a local PostgreSQL starts automatically.

```bash
git clone https://github.com/nmdouh/open-hackathon-platform.git
cd open-hackathon-platform
npm install
npm run dev -- --seed
```

Open <http://localhost:3000> and sign in with a demo account (password `demo-password-2026`, development only):

| Account | Role |
|---|---|
| `admin@example.org` | Administrator |
| `layla@example.org` | Idea owner with a team |
| `david@example.org` | Member with a pending application |
| `mentor@example.org` | Mentor |
| `chair@example.org` | Screening committee chair |

Run the test suite (uses a throw-away PostgreSQL):

```bash
npm test
```

## Production

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. In short, with Docker:

```bash
cp .env.example .env        # set POSTGRES_PASSWORD and SETTINGS_SECRET
docker compose up -d
docker compose exec app npm run create-admin -- --email you@your-institution.org --name "Your Name"
```

The first administrator then creates a hackathon from **Administration**.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example). Highlights:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (database must be UTF-8) |
| `APP_NAME` | Name shown in the header — put your institution's event name here |
| `ALLOW_SIGNUP` | `false` to let only administrators create accounts |
| `SETTINGS_SECRET` | Random secret that encrypts settings saved in the app, such as the AI coach API key |
| `LLM_ENDPOINT`, `LLM_API_KEY`, `LLM_MODEL` | Optional defaults for the AI coach. Administrators can instead set the endpoint, model and key in **Administration → AI coach**; the key is stored encrypted and never shown again. |

## Architecture

- **Server:** Node.js, Express 5, PostgreSQL (`pg`), input validation with zod. SQL migrations in `server/db/migrations`.
- **Web:** plain HTML, CSS and JavaScript modules — no build step, no framework. Strict Content-Security-Policy; all user content is rendered as text.
- **Auth:** email and password (scrypt), server-side sessions in httpOnly cookies. See [SECURITY.md](SECURITY.md).

```
server/     API, business rules, migrations
web/        single-page UI (EN/AR, RTL, light/dark)
scripts/    dev server, migrations, create-admin, demo data
test/       node:test suites against a real PostgreSQL
docs/       deployment and API notes
```

## Roadmap

- Release 2: **Innovation showcase** — publish finished projects, votes, comments and bookmarks.
- Single sign-on (OpenID Connect) for institutions.
- Email notifications.

## Contributing

Contributions and translations are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md).
