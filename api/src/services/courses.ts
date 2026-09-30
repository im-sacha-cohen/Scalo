// Courses & members area: area settings, course tree, access rules (tag / manual / expiry / drip), progress, files.
//
// Access to a course comes from two independent sources, never from a payments table:
// - tag: the contact has `courses.access_tag_id` (drip starts when the tag was given; `access_days` = validity);
// - manual: a `course_enrollments` row (access date for the drip schedule, optional expiry).
// A contact has access when at least one source is valid; the drip schedule starts at the earliest valid one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sql, type Selectable } from 'kysely';
import {
  DEFAULT_SETTINGS,
  LESSON_FORBIDDEN_BLOCKS,
  uid as blockId,
  type Block,
  type Course,
  type CourseAccessVia,
  type CourseModule,
  type CourseStudent,
  type Lesson,
  type LessonFile,
  type MemberArea,
  type PageContent,
} from '@scalo/shared';
import { db, inTx, isUniqueViolation, nowIso, type CoursesTable, type Db, type MemberAreasTable } from '../db';
import { UPLOAD_DIR } from '../routes/uploads';
import { hmac, PUBLIC_URL, slugify } from '../util';
import { logEvent } from './contacts';

export type AreaRow = Selectable<MemberAreasTable>;
export type CourseRow = Selectable<CoursesTable>;

const DAY_MS = 86400_000;

/** First path segments of the members area that are not courses. */
export const RESERVED_SLUGS = new Set(['login', 'logout', 'auth', 'files', 'preview']);
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,58}[a-z0-9])?$/;

// ---------- members area ----------

/** Members area of an account, created on first access (slug from the account name, globally unique). */
export async function getArea(userId: number): Promise<AreaRow> {
  const found = await db.selectFrom('member_areas').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (found) return found;
  const user = await db.selectFrom('users').select(['name']).where('id', '=', userId).executeTakeFirstOrThrow();
  const base = slugify(user.name, 'espace').slice(0, 48).replace(/-+$/g, '') || 'espace';
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? base : i < 50 ? `${base}-${i + 1}` : `${base}-${crypto.randomBytes(4).toString('hex')}`;
    if (RESERVED_SLUGS.has(slug)) continue;
    try {
      await db
        .insertInto('member_areas')
        .values({ user_id: userId, slug, name: user.name.trim().slice(0, 120) || 'Espace membres' })
        .onConflict((oc) => oc.column('user_id').doNothing())
        .execute();
      break;
    } catch (e) {
      if (!isUniqueViolation(e, 'member_areas_slug_key')) throw e; // slug taken by another account: next candidate
    }
  }
  return db.selectFrom('member_areas').selectAll().where('user_id', '=', userId).executeTakeFirstOrThrow();
}

export const areaPath = (area: Pick<AreaRow, 'slug'>) => `/m/${area.slug}`;
export const coursePath = (area: Pick<AreaRow, 'slug'>, course: { slug: string }) => `${areaPath(area)}/${course.slug}`;
export const lessonPath = (area: Pick<AreaRow, 'slug'>, course: { slug: string }, lessonId: number) => `${coursePath(area, course)}/${lessonId}`;

// ---------- owner preview (signed, account-scoped, 24 h) ----------

const PREVIEW_TTL_MS = 24 * 3600_000;

/** Lets the owner browse the members area as a member with access to everything (drafts included). */
export function memberPreviewToken(userId: number) {
  const exp = Date.now() + PREVIEW_TTL_MS;
  return `${exp.toString(36)}.${hmac('mpreview', `${userId}:${exp}`)}`;
}

/** Returns the expiry (ms) of a valid token, null otherwise. */
export function verifyMemberPreviewToken(userId: number, token: unknown): number | null {
  if (typeof token !== 'string') return null;
  const m = /^([0-9a-z]{1,12})\.([\w-]+)$/.exec(token);
  if (!m) return null;
  const exp = parseInt(m[1], 36);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  const expected = Buffer.from(hmac('mpreview', `${userId}:${exp}`));
  const given = Buffer.from(m[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? exp : null;
}

const withPreview = (url: string, userId: number) => `${url}?preview=${memberPreviewToken(userId)}`;

export function toArea(area: AreaRow): MemberArea {
  const url = PUBLIC_URL + areaPath(area);
  return { slug: area.slug, name: area.name, logo_url: area.logo_url, color: area.color, url, preview_url: withPreview(url, area.user_id) };
}

// ---------- lesson content ----------

const FORBIDDEN_BLOCKS = new Set(LESSON_FORBIDDEN_BLOCKS);

function cleanBlocks(blocks: unknown, depth = 0): Block[] {
  if (!Array.isArray(blocks) || depth > 8) return [];
  const out: Block[] = [];
  for (const b of blocks as Block[]) {
    if (!b || typeof b !== 'object' || FORBIDDEN_BLOCKS.has(b.type)) continue;
    if (b.type === 'section') out.push({ ...b, children: cleanBlocks(b.children, depth + 1) });
    else if (b.type === 'columns') {
      out.push({ ...b, columns: (Array.isArray(b.columns) ? b.columns : []).map((c) => ({ ...c, children: cleanBlocks(c?.children, depth + 1) })) });
    } else out.push(b);
  }
  return out;
}

/**
 * Lesson content as stored and rendered: custom HTML blocks, forms and head code are removed (lessons are served on
 * the application origin with the member session, unlike funnel pages which are sandboxed when they contain code).
 */
export function lessonContent(content: PageContent | null | undefined): PageContent {
  const { headCode: _headCode, ...settings } = (content?.settings ?? {}) as PageContent['settings'] & { headCode?: string };
  return { settings: settings as PageContent['settings'], blocks: cleanBlocks(content?.blocks) };
}

/** New lesson: white page, accent = brand colour of the members area. */
export const defaultLessonContent = (accent: string): PageContent => ({
  settings: { ...DEFAULT_SETTINGS, background: '#ffffff', accent },
  blocks: [{ id: blockId(), type: 'text', text: 'Rédigez ici le contenu de votre leçon.' } as Block],
});

// ---------- course tree ----------

const lessonColumns = ['l.id', 'l.course_id', 'l.module_id', 'l.title', 'l.position', 'l.status', 'l.free_preview', 'l.drip_days', 'l.video_url', 'l.updated_at'] as const;

const filesCount = sql<number>`(SELECT COUNT(*) FROM course_files f WHERE f.lesson_id = l.id)`.as('files_count');

export function toLesson(row: {
  id: number; course_id: number; module_id: number; title: string; position: number; status: 'draft' | 'published';
  free_preview: boolean; drip_days: number; video_url: string | null; updated_at: string; files_count?: number;
}): Lesson {
  return {
    id: row.id,
    course_id: row.course_id,
    module_id: row.module_id,
    title: row.title,
    position: row.position,
    status: row.status,
    free_preview: Boolean(row.free_preview),
    drip_days: row.drip_days,
    video_url: row.video_url,
    files_count: row.files_count ?? 0,
    updated_at: row.updated_at,
  };
}

/** Modules of a course with their lessons (without content), in display order. */
export async function courseModules(courseId: number, ex: Db = db): Promise<CourseModule[]> {
  const [modules, lessons] = await Promise.all([
    ex.selectFrom('course_modules').select(['id', 'course_id', 'title', 'position']).where('course_id', '=', courseId).orderBy('position').orderBy('id').execute(),
    ex.selectFrom('course_lessons as l').select([...lessonColumns, filesCount]).where('l.course_id', '=', courseId).orderBy('l.position').orderBy('l.id').execute(),
  ]);
  return modules.map((m) => ({ ...m, lessons: lessons.filter((l) => l.module_id === m.id).map(toLesson) }));
}

const courseCounts = [
  sql<number>`(SELECT COUNT(*) FROM course_modules m WHERE m.course_id = c.id)`.as('modules_count'),
  sql<number>`(SELECT COUNT(*) FROM course_lessons l WHERE l.course_id = c.id)`.as('lessons_count'),
  sql<number>`(SELECT COUNT(*) FROM (
      SELECT e.contact_id FROM course_enrollments e WHERE e.course_id = c.id
      UNION SELECT ct.contact_id FROM contact_tags ct WHERE ct.tag_id = c.access_tag_id) s)`.as('students_count'),
] as const;

function toCourse(area: AreaRow, row: CourseRow & { modules_count: number; lessons_count: number; students_count: number }): Course {
  const url = PUBLIC_URL + coursePath(area, row);
  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    description: row.description,
    image_url: row.image_url,
    status: row.status,
    access_tag_id: row.access_tag_id,
    access_days: row.access_days,
    purchase_url: row.purchase_url,
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
    modules_count: row.modules_count,
    lessons_count: row.lessons_count,
    students_count: row.students_count,
    url,
    preview_url: withPreview(url, area.user_id),
  };
}

export async function listCourses(userId: number): Promise<Course[]> {
  const area = await getArea(userId);
  const rows = await db.selectFrom('courses as c').selectAll('c').select([...courseCounts]).where('c.user_id', '=', userId).orderBy('c.position').orderBy('c.id').execute();
  return rows.map((r) => toCourse(area, r));
}

export async function getCourse(userId: number, id: number): Promise<Course | undefined> {
  const row = await db.selectFrom('courses as c').selectAll('c').select([...courseCounts]).where('c.user_id', '=', userId).where('c.id', '=', id).executeTakeFirst();
  if (!row) return undefined;
  const area = await getArea(userId);
  const modules = await courseModules(id);
  for (const m of modules) for (const l of m.lessons) l.preview_url = withPreview(PUBLIC_URL + lessonPath(area, row, l.id), userId);
  return { ...toCourse(area, row), modules };
}

/** Free slug for a course of the account (`ma-formation`, `ma-formation-2`…), never a reserved path segment. */
export async function freeCourseSlug(userId: number, title: string, ex: Db = db): Promise<string> {
  const base = slugify(title, 'formation').slice(0, 50).replace(/-+$/g, '') || 'formation';
  const taken = new Set((await ex.selectFrom('courses').select('slug').where('user_id', '=', userId).where('slug', 'like', `${base}%`).execute()).map((r) => r.slug));
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    if (!taken.has(slug) && !RESERVED_SLUGS.has(slug)) return slug;
  }
}

// ---------- access ----------

interface AccessSource {
  via: CourseAccessVia;
  start: number;
  expires: number | null;
}

export interface CourseAccess {
  granted: boolean;
  /** Sources the contact has (valid ones when granted, otherwise the expired ones). */
  via: CourseAccessVia[];
  /** Start of the drip schedule (ISO); null when the contact never had access. */
  start: string | null;
  /** null = no expiry. */
  expires_at: string | null;
  /** The contact had access but every source has expired. */
  expired: boolean;
}

const NO_ACCESS: CourseAccess = { granted: false, via: [], start: null, expires_at: null, expired: false };
const ms = (iso: string) => new Date(iso).getTime();
const iso = (t: number) => new Date(t).toISOString();

function sources(course: Pick<CourseRow, 'access_days'>, manual: { access_at: string; expires_at: string | null } | null | undefined, tagAt: string | null | undefined): AccessSource[] {
  const out: AccessSource[] = [];
  if (manual) out.push({ via: 'manual', start: ms(manual.access_at), expires: manual.expires_at ? ms(manual.expires_at) : null });
  if (tagAt) {
    const start = ms(tagAt);
    out.push({ via: 'tag', start, expires: course.access_days ? start + course.access_days * DAY_MS : null });
  }
  return out;
}

export function resolveAccess(list: AccessSource[], now = Date.now()): CourseAccess {
  if (!list.length) return NO_ACCESS;
  const valid = list.filter((s) => s.expires === null || s.expires > now);
  const used = valid.length ? valid : list;
  return {
    granted: valid.length > 0,
    via: used.map((s) => s.via),
    start: iso(Math.min(...used.map((s) => s.start))),
    expires_at: used.some((s) => s.expires === null) ? null : iso(Math.max(...used.map((s) => s.expires!))),
    expired: valid.length === 0,
  };
}

type AccessCourse = Pick<CourseRow, 'id' | 'access_tag_id' | 'access_days'>;

export async function courseAccess(course: AccessCourse, contactId: number, ex: Db = db): Promise<CourseAccess> {
  const [manual, tag] = await Promise.all([
    ex.selectFrom('course_enrollments').select(['access_at', 'expires_at']).where('course_id', '=', course.id).where('contact_id', '=', contactId).executeTakeFirst(),
    course.access_tag_id
      ? ex.selectFrom('contact_tags').select('created_at').where('contact_id', '=', contactId).where('tag_id', '=', course.access_tag_id).executeTakeFirst()
      : undefined,
  ]);
  return resolveAccess(sources(course, manual, tag?.created_at));
}

/** When a lesson opens for a member whose drip schedule started at `start`. */
export const lessonAvailableAt = (start: string, dripDays: number) => iso(ms(start) + Math.max(0, dripDays) * DAY_MS);

// ---------- progress ----------

/** Ids of the lessons of a course completed by a contact. */
export async function completedLessons(courseId: number, contactId: number, ex: Db = db): Promise<Set<number>> {
  const rows = await ex.selectFrom('lesson_progress').select('lesson_id').where('course_id', '=', courseId).where('contact_id', '=', contactId).execute();
  return new Set(rows.map((r) => r.lesson_id));
}

export const percent = (done: number, total: number) => (total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0);

/**
 * Marks a lesson as completed (idempotent). Logs `lesson_completed`, and `course_completed` the first time every
 * published lesson of the course is done (which also fires the "Formation terminée" automations, in the same
 * transaction).
 */
export function completeLesson(
  course: Pick<CourseRow, 'id' | 'user_id' | 'title'>,
  lesson: { id: number; title: string },
  contactId: number,
  ex: Db = db,
): Promise<{ newlyCompleted: boolean; courseCompleted: boolean }> {
  return inTx(ex, async (trx) => {
    const now = nowIso();
    const added = await trx
      .insertInto('lesson_progress')
      .values({ contact_id: contactId, lesson_id: lesson.id, course_id: course.id, completed_at: now })
      .onConflict((oc) => oc.doNothing())
      .returning('lesson_id')
      .executeTakeFirst();
    if (!added) return { newlyCompleted: false, courseCompleted: false };
    await logEvent(course.user_id, contactId, 'lesson_completed', { course: course.title, course_id: course.id, lesson: lesson.title, lesson_id: lesson.id }, { created_at: now }, trx);
    const { rows } = await sql<{ total: number; done: number }>`
      SELECT COUNT(*) AS total, COUNT(p.lesson_id) AS done
        FROM course_lessons l
        LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.contact_id = ${contactId}
       WHERE l.course_id = ${course.id} AND l.status = 'published'`.execute(trx);
    const { total, done } = rows[0];
    if (!total || done < total) return { newlyCompleted: true, courseCompleted: false };
    const first = await trx
      .insertInto('course_completions')
      .values({ course_id: course.id, contact_id: contactId, completed_at: now })
      .onConflict((oc) => oc.doNothing())
      .returning('course_id')
      .executeTakeFirst();
    if (first) await logEvent(course.user_id, contactId, 'course_completed', { course: course.title, course_id: course.id }, { created_at: now }, trx);
    return { newlyCompleted: true, courseCompleted: !!first };
  });
}

export async function uncompleteLesson(lessonId: number, contactId: number, ex: Db = db) {
  await ex.deleteFrom('lesson_progress').where('lesson_id', '=', lessonId).where('contact_id', '=', contactId).execute();
}

// ---------- students (admin) ----------

export const MAX_STUDENTS_LISTED = 2000;

export async function listStudents(course: CourseRow): Promise<CourseStudent[]> {
  const [manual, tagged, totalRow] = await Promise.all([
    db.selectFrom('course_enrollments').select(['contact_id', 'access_at', 'expires_at']).where('course_id', '=', course.id).execute(),
    course.access_tag_id
      ? db.selectFrom('contact_tags').select(['contact_id', 'created_at']).where('tag_id', '=', course.access_tag_id).execute()
      : Promise.resolve([] as { contact_id: number; created_at: string }[]),
    db.selectFrom('course_lessons').select((eb) => eb.fn.countAll<number>().as('n')).where('course_id', '=', course.id).where('status', '=', 'published').executeTakeFirstOrThrow(),
  ]);
  const manualBy = new Map(manual.map((m) => [m.contact_id, m]));
  const tagBy = new Map(tagged.map((t) => [t.contact_id, t.created_at]));
  const ids = [...new Set([...manualBy.keys(), ...tagBy.keys()])];
  if (!ids.length) return [];
  const [contacts, progress, completions] = await Promise.all([
    db.selectFrom('contacts').select(['id', 'email', 'first_name', 'last_name']).where('user_id', '=', course.user_id).where('id', 'in', ids).execute(),
    db
      .selectFrom('lesson_progress as p')
      .innerJoin('course_lessons as l', 'l.id', 'p.lesson_id')
      .select(['p.contact_id', sql<number>`COUNT(*) FILTER (WHERE l.status = 'published')`.as('done'), sql<string>`MAX(p.completed_at)`.as('last')])
      .where('p.course_id', '=', course.id)
      .groupBy('p.contact_id')
      .execute(),
    db.selectFrom('course_completions').select(['contact_id', 'completed_at']).where('course_id', '=', course.id).execute(),
  ]);
  const progressBy = new Map(progress.map((p) => [p.contact_id, p]));
  const completedBy = new Map(completions.map((c) => [c.contact_id, c.completed_at]));
  const total = totalRow.n;
  const now = Date.now();
  return contacts
    .map((c): CourseStudent => {
      const m = manualBy.get(c.id) ?? null;
      const access = resolveAccess(sources(course, m, tagBy.get(c.id)), now);
      const p = progressBy.get(c.id);
      const last = p?.last ? new Date(p.last).toISOString() : null;
      return {
        contact: c,
        via: access.via,
        active: access.granted,
        access_at: access.start!,
        expires_at: access.expires_at,
        manual: m ? { access_at: m.access_at, expires_at: m.expires_at } : null,
        completed_lessons: p?.done ?? 0,
        total_lessons: total,
        percent: percent(p?.done ?? 0, total),
        completed_at: completedBy.get(c.id) ?? null,
        last_activity_at: last,
      };
    })
    .sort((a, b) => b.access_at.localeCompare(a.access_at) || b.contact.id - a.contact.id)
    .slice(0, MAX_STUDENTS_LISTED);
}

// ---------- lesson files ----------
// Stored under UPLOAD_DIR/_courses/<account>/<random>: `_courses` is not a numeric account id, so the public
// `/uploads/:userId/:file` route can never reach these files. They are only served after an access check.

export const MAX_FILES_PER_LESSON = 20;

const filesDir = (userId: number) => path.join(UPLOAD_DIR, '_courses', String(userId));
export const storedFilePath = (userId: number, stored: string) => path.join(filesDir(userId), stored);

export function writeLessonFile(userId: number, buf: Buffer): string {
  const stored = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(filesDir(userId), { recursive: true });
  fs.writeFileSync(storedFilePath(userId, stored), buf, { flag: 'wx' });
  return stored;
}

/** Best effort: the database rows are the source of truth, a leftover file is unreachable. */
export function removeStoredFiles(files: { user_id: number; stored: string }[]) {
  for (const f of files) {
    try {
      fs.unlinkSync(storedFilePath(f.user_id, f.stored));
    } catch {
      /* already gone */
    }
  }
}

export const toLessonFile = (f: { id: number; lesson_id: number; name: string; size: number; created_at: string }): LessonFile => ({
  id: f.id,
  lesson_id: f.lesson_id,
  name: f.name,
  size: f.size,
  created_at: f.created_at,
});

/** Display name of an uploaded file: no path, no control characters. */
export function cleanFileName(raw: unknown): string {
  const s = (typeof raw === 'string' ? raw : '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() ?? '';
  return s.trim().slice(0, 150);
}

/** `Content-Disposition: attachment` with an ASCII fallback and the RFC 5987 UTF-8 name. */
export function attachmentHeader(name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'fichier';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}
