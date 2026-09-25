-- Participant toolbox: progress wall, help replies, resources and AI usage.

-- Short, frequent updates that show a team is moving: what was built, what
-- blocks them, a demo link, or a call for help.
CREATE TABLE progress_posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  author_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'update' CHECK (kind IN ('update', 'blocker', 'demo', 'help')),
  body          text NOT NULL,
  link_url      text NOT NULL DEFAULT '' CHECK (link_url = '' OR link_url ~ '^https?://'),
  visibility    text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'team')),
  resolved      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX progress_posts_hackathon_idx ON progress_posts (hackathon_id, created_at DESC);
CREATE INDEX progress_posts_team_idx ON progress_posts (team_id, created_at DESC);

CREATE TABLE progress_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES progress_posts (id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX progress_replies_post_idx ON progress_replies (post_id, created_at);

-- Guides, templates and tools. hackathon_id NULL means "shown in every hackathon".
CREATE TABLE resources (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id    uuid REFERENCES hackathons (id) ON DELETE CASCADE,
  category        text NOT NULL DEFAULT 'guide' CHECK (category IN ('guide', 'template', 'tool', 'video', 'data', 'other')),
  title_en        text NOT NULL,
  title_ar        text NOT NULL DEFAULT '',
  description_en  text NOT NULL DEFAULT '',
  description_ar  text NOT NULL DEFAULT '',
  url             text NOT NULL CHECK (url ~ '^(https?://|/)'),
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resources_hackathon_idx ON resources (hackathon_id, sort_order);

-- One row per AI assistant call, for fair-use limits. Prompts are not stored.
CREATE TABLE ai_usage (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hackathon_id  uuid REFERENCES hackathons (id) ON DELETE CASCADE,
  mode          text NOT NULL,
  ok            boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_idx ON ai_usage (user_id, created_at DESC);
