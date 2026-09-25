-- Core schema: accounts, sessions, hackathons, participation and audit.
-- Rules that must hold under concurrency are expressed as constraints and
-- partial unique indexes, not only in application code.

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  display_name   text NOT NULL,
  password_hash  text,
  role           text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  is_active      boolean NOT NULL DEFAULT true,
  locale         text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'ar')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    bytea NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE hackathons (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                      text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  title_en                  text NOT NULL,
  title_ar                  text NOT NULL DEFAULT '',
  summary_en                text NOT NULL DEFAULT '',
  summary_ar                text NOT NULL DEFAULT '',
  status                    text NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'open', 'running', 'closed', 'archived')),
  registration_opens_at     timestamptz,
  registration_closes_at    timestamptz,
  idea_submission_closes_at timestamptz,
  min_team_size             integer NOT NULL DEFAULT 2 CHECK (min_team_size >= 1),
  max_team_size             integer NOT NULL DEFAULT 5 CHECK (max_team_size >= 1),
  max_pending_applications  integer NOT NULL DEFAULT 3 CHECK (max_pending_applications >= 1),
  created_by                uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (min_team_size <= max_team_size)
);

CREATE TABLE tracks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id    uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  name_en         text NOT NULL,
  name_ar         text NOT NULL DEFAULT '',
  description_en  text NOT NULL DEFAULT '',
  description_ar  text NOT NULL DEFAULT '',
  sort_order      integer NOT NULL DEFAULT 0
);
CREATE INDEX tracks_hackathon_idx ON tracks (hackathon_id);

-- Public timeline shown to participants (registration, build, demo day, ...).
CREATE TABLE stages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  name_en       text NOT NULL,
  name_ar       text NOT NULL DEFAULT '',
  starts_at     timestamptz,
  ends_at       timestamptz,
  sort_order    integer NOT NULL DEFAULT 0,
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);
CREATE INDEX stages_hackathon_idx ON stages (hackathon_id);

-- A person takes part either as an idea owner or as a prospective team member.
CREATE TABLE registrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('idea_owner', 'member')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  skills        text[] NOT NULL DEFAULT '{}',
  bio           text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Rule: one active registration per person per hackathon.
CREATE UNIQUE INDEX registrations_active_uq ON registrations (hackathon_id, user_id) WHERE status = 'active';

CREATE TABLE ideas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id     uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  track_id         uuid REFERENCES tracks (id) ON DELETE SET NULL,
  title            text NOT NULL,
  problem          text NOT NULL DEFAULT '',
  solution         text NOT NULL DEFAULT '',
  target_users     text NOT NULL DEFAULT '',
  expected_impact  text NOT NULL DEFAULT '',
  data_and_tools   text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'withdrawn')),
  submitted_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Rule: an owner has at most one live idea per hackathon.
CREATE UNIQUE INDEX ideas_owner_live_uq ON ideas (hackathon_id, owner_id) WHERE status <> 'withdrawn';

CREATE TABLE teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  idea_id       uuid NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  owner_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          text NOT NULL,
  looking_for   text NOT NULL DEFAULT '',
  is_open       boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disbanded')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Rules: one team per idea, one team per owner.
CREATE UNIQUE INDEX teams_idea_uq  ON teams (idea_id) WHERE status = 'active';
CREATE UNIQUE INDEX teams_owner_uq ON teams (hackathon_id, owner_id) WHERE status = 'active';

CREATE TABLE team_members (
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);
-- Rule: a person belongs to at most one team per hackathon.
CREATE UNIQUE INDEX team_members_one_team_uq ON team_members (hackathon_id, user_id);

CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  message       text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn', 'cancelled', 'removed', 'left')),
  decided_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Rule: no duplicate open application to the same team.
CREATE UNIQUE INDEX applications_pending_uq ON applications (team_id, user_id) WHERE status = 'pending';
CREATE INDEX applications_user_idx ON applications (hackathon_id, user_id);

CREATE TABLE announcements (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  title_en      text NOT NULL,
  title_ar      text NOT NULL DEFAULT '',
  body_en       text NOT NULL DEFAULT '',
  body_ar       text NOT NULL DEFAULT '',
  pinned        boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_hackathon_idx ON announcements (hackathon_id, created_at DESC);

-- Append-only record of every state change made through the API.
CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  hackathon_id  uuid REFERENCES hackathons (id) ON DELETE CASCADE,
  action        text NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text,
  details       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_hackathon_idx ON audit_log (hackathon_id, at DESC);
