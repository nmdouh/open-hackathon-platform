-- Engagement: team invitations, in-app notifications and build milestones.

-- An application can now come from either side: a person applying to a team,
-- or a team inviting a person. The same one-pending-per-pair rule applies.
ALTER TABLE applications
  ADD COLUMN direction text NOT NULL DEFAULT 'apply' CHECK (direction IN ('apply', 'invite')),
  ADD COLUMN invited_by uuid REFERENCES users (id) ON DELETE SET NULL;

-- In-app notifications. `data` holds names and ids the UI turns into a
-- translated sentence, so notifications follow the reader's language.
CREATE TABLE notifications (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hackathon_id  uuid REFERENCES hackathons (id) ON DELETE CASCADE,
  kind          text NOT NULL,
  data          jsonb NOT NULL DEFAULT '{}',
  link          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Milestones every team works through (the interactive build roadmap).
CREATE TABLE milestones (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id    uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  title_en        text NOT NULL,
  title_ar        text NOT NULL DEFAULT '',
  description_en  text NOT NULL DEFAULT '',
  description_ar  text NOT NULL DEFAULT '',
  due_at          timestamptz,
  sort_order      integer NOT NULL DEFAULT 0
);
CREATE INDEX milestones_hackathon_idx ON milestones (hackathon_id, sort_order);

CREATE TABLE team_milestones (
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  milestone_id  uuid NOT NULL REFERENCES milestones (id) ON DELETE CASCADE,
  done_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  done_at       timestamptz NOT NULL DEFAULT now(),
  evidence_url  text NOT NULL DEFAULT '' CHECK (evidence_url = '' OR evidence_url ~ '^https?://'),
  PRIMARY KEY (team_id, milestone_id)
);
