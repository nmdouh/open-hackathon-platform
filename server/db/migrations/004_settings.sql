-- Settings that administrators can change at runtime (for example the AI coach).
-- Secret values inside `value` are stored encrypted by the application.
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
