import { sql, type Kysely } from 'kysely';

// Custom field type « Date et heure » (`datetime`): values stored in `contacts.fields` as ISO 8601 UTC strings.
//
// The custom_fields type CHECK is rebuilt from its *current* values plus ours (same approach as 0005 / 0008 / 0012), so
// that migrations developed in parallel apply in any order. The `down` turns the existing date-time fields into text
// fields (their values stay readable ISO strings) before removing the type.

const TYPES = ['datetime'];

// DO blocks cannot take bind parameters: inline the (constant, trusted) arrays as literals.
const lit = (arr: string[]) => sql.raw(`ARRAY[${arr.map((v) => `'${v.replace(/'/g, "''")}'`).join(',')}]::text[]`);
const rebuildTypeCheck = (add: string[], remove: string[]) => sql`
DO $$
DECLARE vals text[];
BEGIN
  SELECT array_agg(DISTINCT v ORDER BY v) INTO vals FROM (
    SELECT (regexp_matches(pg_get_constraintdef(oid), '''([a-z_:]+)''::text', 'g'))[1] AS v
      FROM pg_constraint WHERE conname = 'custom_fields_type_check' AND conrelid = 'custom_fields'::regclass
    UNION SELECT unnest(${lit(add)})) s
  WHERE v <> ALL (${lit(remove)});
  ALTER TABLE custom_fields DROP CONSTRAINT IF EXISTS custom_fields_type_check;
  -- ARRAY['a'::text, …] form (like the original constraint) so that the next rebuild can parse it again
  EXECUTE 'ALTER TABLE custom_fields ADD CONSTRAINT custom_fields_type_check CHECK (type = ANY (ARRAY['
    || (SELECT string_agg(quote_literal(x), ',') FROM unnest(vals) x) || ']::text[]))';
END $$`;

export async function up(db: Kysely<unknown>): Promise<void> {
  await rebuildTypeCheck(TYPES, []).execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`UPDATE custom_fields SET type = 'text' WHERE type = 'datetime'`.execute(db);
  await rebuildTypeCheck([], TYPES).execute(db);
}
