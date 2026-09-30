import { sql, type Kysely } from 'kysely';

// Courses & members area:
// 1. member_areas: address (`/m/<slug>`, globally unique) and branding (name, logo, colour) of an account's members area.
// 2. courses → course_modules → course_lessons (ordered; lesson content = PageContent jsonb like pages and emails,
//    optional video URL, draft / published, free preview, drip delay in days) and course_files (downloads of a lesson,
//    stored outside the public media library and only served to members allowed to read the lesson).
// 3. Access: by tag (`courses.access_tag_id`: contacts having the tag — the contract with payments and automations;
//    drip starts when the tag was given, optional `access_days` validity) and manual (`course_enrollments`: access
//    date for the drip schedule, optional expiry). No dependency on any payments table.
// 4. Progress: lesson_progress (completed lessons), course_completions (first time every published lesson was done).
// 5. Member login: member_login_tokens (SHA-256 of a one-time magic link token, short expiry).
// 6. New contact event types (course_access_granted, lesson_completed, course_completed) and automation trigger
//    `course_completed`.
//
// The contact_events type CHECK and the automations trigger CHECK are rebuilt from their *current* values (plus /
// minus ours), so migrations developed in parallel apply in any order (same approach as 0005).

const EVENT_TYPES = ['course_access_granted', 'lesson_completed', 'course_completed'];
const TRIGGER_TYPES = ['course_completed'];

// DO blocks cannot take bind parameters: inline the (constant, trusted) arrays as literals.
const lit = (arr: string[]) => sql.raw(`ARRAY[${arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
const rebuildCheck = (table: string, column: string, add: string[], remove: string[]) => {
  const constraint = `${table}_${column}_check`;
  return sql`
DO $$
DECLARE vals text[];
BEGIN
  IF to_regclass(${sql.lit(table)}) IS NULL THEN RETURN; END IF;
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM (
    SELECT (regexp_matches(pg_get_constraintdef(oid), '''([a-z_:]+)''::text', 'g'))[1] AS v
      FROM pg_constraint WHERE conname = ${sql.lit(constraint)} AND conrelid = ${sql.lit(table)}::regclass
    UNION SELECT unnest(${lit(add)})) s
  WHERE v <> ALL (${lit(remove)});
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', ${sql.lit(table)}, ${sql.lit(constraint)});
  -- ARRAY['a'::text, …] form (like the original constraint) so that the next rebuild can parse it again
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I = ANY (ARRAY[', ${sql.lit(table)}, ${sql.lit(constraint)}, ${sql.lit(column)})
    || (SELECT string_agg(quote_literal(x), ',') FROM unnest(vals) x) || ']::text[]))';
END $$`;
};

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- ---------- members area ----------
CREATE TABLE member_areas (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  logo_url text,
  color text NOT NULL DEFAULT '#5B4BFF' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_areas_slug_key UNIQUE (slug)
);

-- ---------- courses ----------
CREATE TABLE courses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$'),
  description text NOT NULL DEFAULT '',
  image_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  -- contacts having this tag have access (drip starts when the tag was given)
  access_tag_id bigint REFERENCES tags(id) ON DELETE SET NULL,
  access_days integer CHECK (access_days IS NULL OR access_days BETWEEN 1 AND 3650),
  purchase_url text,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT courses_user_slug_key UNIQUE (user_id, slug)
);
CREATE INDEX courses_access_tag_idx ON courses (access_tag_id) WHERE access_tag_id IS NOT NULL;

CREATE TABLE course_modules (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- target of the composite foreign key of the lessons (a lesson's module always belongs to the lesson's course)
  CONSTRAINT course_modules_id_course_key UNIQUE (id, course_id)
);
CREATE INDEX course_modules_course_idx ON course_modules (course_id, position, id);

CREATE TABLE course_lessons (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id bigint NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  position integer NOT NULL DEFAULT 0,
  content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  video_url text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  free_preview boolean NOT NULL DEFAULT false,
  drip_days integer NOT NULL DEFAULT 0 CHECK (drip_days BETWEEN 0 AND 3650),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_lessons_module_fkey FOREIGN KEY (module_id, course_id) REFERENCES course_modules (id, course_id) ON DELETE CASCADE
);
CREATE INDEX course_lessons_module_idx ON course_lessons (module_id, position, id);
CREATE INDEX course_lessons_course_idx ON course_lessons (course_id);

CREATE TABLE course_files (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id bigint NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- random file name on disk (never derived from user input)
  stored text NOT NULL CONSTRAINT course_files_stored_key UNIQUE,
  size bigint NOT NULL CHECK (size >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX course_files_lesson_idx ON course_files (lesson_id, id);

-- ---------- access & progress ----------
CREATE TABLE course_enrollments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- start of the drip schedule
  access_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT course_enrollments_course_contact_key UNIQUE (course_id, contact_id)
);
CREATE INDEX course_enrollments_contact_idx ON course_enrollments (contact_id);

CREATE TABLE lesson_progress (
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lesson_id bigint NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
  course_id bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, lesson_id)
);
CREATE INDEX lesson_progress_course_idx ON lesson_progress (course_id, contact_id);

CREATE TABLE course_completions (
  course_id bigint NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  completed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, contact_id)
);
CREATE INDEX course_completions_contact_idx ON course_completions (contact_id);

-- ---------- member login (magic link) ----------
CREATE TABLE member_login_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  token_hash text NOT NULL, -- SHA-256 of the random token sent by email (never stored in clear)
  redirect_path text,       -- page of the members area asked before logging in
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT member_login_tokens_token_key UNIQUE (token_hash)
);
CREATE INDEX member_login_tokens_contact_idx ON member_login_tokens (contact_id, created_at DESC);
CREATE INDEX member_login_tokens_expiry_idx ON member_login_tokens (expires_at);
`.execute(db);
  await rebuildCheck('contact_events', 'type', EVENT_TYPES, []).execute(db);
  await rebuildCheck('automations', 'trigger_type', TRIGGER_TYPES, []).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS member_login_tokens;
DROP TABLE IF EXISTS course_completions;
DROP TABLE IF EXISTS lesson_progress;
DROP TABLE IF EXISTS course_enrollments;
DROP TABLE IF EXISTS course_files;
DROP TABLE IF EXISTS course_lessons;
DROP TABLE IF EXISTS course_modules;
DROP TABLE IF EXISTS courses;
DROP TABLE IF EXISTS member_areas;
DELETE FROM contact_events WHERE type IN ('course_access_granted', 'lesson_completed', 'course_completed');
DO $$ BEGIN
  IF to_regclass('automations') IS NOT NULL THEN
    DELETE FROM automations WHERE trigger_type = 'course_completed';
  END IF;
END $$;
`.execute(db);
  await rebuildCheck('contact_events', 'type', [], EVENT_TYPES).execute(db);
  await rebuildCheck('automations', 'trigger_type', [], TRIGGER_TYPES).execute(db);
}
