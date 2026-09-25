-- Governance: mentors, review rounds (screening, reviews, final judging),
-- weighted criteria, committee votes, conflict handling and decisions.

-- People who support a hackathon without competing in it.
CREATE TABLE mentors (
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expertise     text[] NOT NULL DEFAULT '{}',
  bio           text NOT NULL DEFAULT '',
  max_teams     integer NOT NULL DEFAULT 5 CHECK (max_teams >= 1),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hackathon_id, user_id)
);

CREATE TABLE mentor_assignments (
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  mentor_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  assigned_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, mentor_id)
);
CREATE INDEX mentor_assignments_mentor_idx ON mentor_assignments (hackathon_id, mentor_id);

CREATE TABLE mentoring_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id  uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  requested_by  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mentor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  topic         text NOT NULL,
  details       text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'accepted', 'done', 'declined', 'cancelled')),
  scheduled_at  timestamptz,
  mentor_notes  text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mentoring_requests_team_idx ON mentoring_requests (team_id, status);
CREATE INDEX mentoring_requests_hackathon_idx ON mentoring_requests (hackathon_id, status);

-- A review round evaluates ideas against weighted criteria. A round can take
-- its candidates from the ideas that advanced in an earlier round.
CREATE TABLE review_rounds (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hackathon_id       uuid NOT NULL REFERENCES hackathons (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('screening', 'review', 'final')),
  name_en            text NOT NULL,
  name_ar            text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'finalized')),
  source_round_id    uuid REFERENCES review_rounds (id) ON DELETE RESTRICT,
  assignment_mode    text NOT NULL DEFAULT 'all' CHECK (assignment_mode IN ('all', 'assigned')),
  min_reviewers      integer NOT NULL DEFAULT 2 CHECK (min_reviewers >= 1),
  advance_count      integer CHECK (advance_count IS NULL OR advance_count >= 0),
  results_published  boolean NOT NULL DEFAULT false,
  sort_order         integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  opened_at          timestamptz,
  closed_at          timestamptz,
  finalized_at       timestamptz,
  finalized_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  CHECK (source_round_id IS NULL OR source_round_id <> id)
);
CREATE INDEX review_rounds_hackathon_idx ON review_rounds (hackathon_id, sort_order);

CREATE TABLE round_criteria (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES review_rounds (id) ON DELETE CASCADE,
  name_en         text NOT NULL,
  name_ar         text NOT NULL DEFAULT '',
  description_en  text NOT NULL DEFAULT '',
  description_ar  text NOT NULL DEFAULT '',
  weight          numeric(6, 2) NOT NULL CHECK (weight > 0),
  min_score       integer NOT NULL DEFAULT 1,
  max_score       integer NOT NULL DEFAULT 5,
  sort_order      integer NOT NULL DEFAULT 0,
  CHECK (max_score > min_score)
);
CREATE INDEX round_criteria_round_idx ON round_criteria (round_id, sort_order);

-- The committee of a round. At most one chair, who finalises decisions.
CREATE TABLE round_reviewers (
  round_id   uuid NOT NULL REFERENCES review_rounds (id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_chair   boolean NOT NULL DEFAULT false,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, user_id)
);
CREATE UNIQUE INDEX round_reviewers_one_chair_uq ON round_reviewers (round_id) WHERE is_chair;

-- Used when assignment_mode = 'assigned'; otherwise every reviewer sees every candidate.
CREATE TABLE round_assignments (
  round_id     uuid NOT NULL REFERENCES review_rounds (id) ON DELETE CASCADE,
  idea_id      uuid NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  reviewer_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  PRIMARY KEY (round_id, idea_id, reviewer_id)
);

CREATE TABLE evaluations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id         uuid NOT NULL REFERENCES review_rounds (id) ON DELETE CASCADE,
  idea_id          uuid NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  reviewer_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  scores           jsonb NOT NULL DEFAULT '{}',
  comment          text NOT NULL DEFAULT '',
  recommendation   text CHECK (recommendation IN ('advance', 'hold', 'reject')),
  conflict         boolean NOT NULL DEFAULT false,
  conflict_reason  text NOT NULL DEFAULT '',
  total            numeric(7, 3),
  submitted_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (round_id, idea_id, reviewer_id)
);
CREATE INDEX evaluations_round_idea_idx ON evaluations (round_id, idea_id);

CREATE TABLE round_decisions (
  round_id        uuid NOT NULL REFERENCES review_rounds (id) ON DELETE CASCADE,
  idea_id         uuid NOT NULL REFERENCES ideas (id) ON DELETE CASCADE,
  outcome         text NOT NULL CHECK (outcome IN ('advance', 'waitlist', 'reject')),
  rank            integer,
  score           numeric(7, 3),
  reviewer_count  integer NOT NULL DEFAULT 0,
  is_override     boolean NOT NULL DEFAULT false,
  note            text NOT NULL DEFAULT '',
  decided_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, idea_id)
);
