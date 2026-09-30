// Courses (admin API, session JWT): members area settings, courses → modules → lessons, lesson files, students.
import fs from 'node:fs';
import express, { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { LESSON_FILE_EXTENSIONS, LESSON_FILE_MAX_BYTES, type Lesson } from '@scalo/shared';
import { db, isUniqueViolation, nowIso, type Db } from '../db';
import { getContactRow, logEvent, normEmail, removeTag, upsertContact } from '../services/contacts';
import {
  attachmentHeader,
  cleanFileName,
  courseAccess,
  defaultLessonContent,
  freeCourseSlug,
  getArea,
  getCourse,
  lessonContent,
  lessonPath,
  listCourses,
  listStudents,
  MAX_FILES_PER_LESSON,
  memberPreviewToken,
  removeStoredFiles,
  RESERVED_SLUGS,
  SLUG_RE,
  storedFilePath,
  toArea,
  toLesson,
  toLessonFile,
  writeLessonFile,
  type CourseRow,
} from '../services/courses';
import { safeRedirect } from '../services/optin';
import { HttpError, notFound, pageContentSchema, paramId, PUBLIC_URL, uid } from '../util';

export const coursesRouter = Router();

const MAX_COURSES = 200;
const MAX_MODULES = 100;
const MAX_LESSONS = 500;

// ---------- validation ----------

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SLUG_RE, 'Adresse invalide : lettres minuscules, chiffres et tirets uniquement (60 caractères max)')
  .refine((s) => !RESERVED_SLUGS.has(s), 'Cette adresse est réservée');
/** Image / link: http(s) URL or a path of the app (`/uploads/…`, `/p/…`); empty = removed. */
const link = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    const safe = safeRedirect(v);
    if (!safe) ctx.addIssue({ code: 'custom', message: 'URL invalide (http:// ou https:// attendu)' });
    return safe;
  });
const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    try {
      const u = new URL(v);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
    } catch {
      /* invalid */
    }
    ctx.addIssue({ code: 'custom', message: 'URL de vidéo invalide (http:// ou https:// attendu)' });
    return null;
  });
const title = z.string().trim().min(1).max(200);
const status = z.enum(['draft', 'published']);
const ids = z.array(z.number().int().positive()).min(1).max(1000);
const date = z.iso.datetime({ offset: true });

const areaSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug,
    logo_url: link,
    color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Couleur invalide (format #rrggbb)'),
  })
  .partial();

const courseSchema = z
  .object({
    title,
    slug,
    description: z.string().trim().max(5000),
    image_url: link,
    status,
    access_tag_id: z.number().int().positive().nullable(),
    access_days: z.number().int().min(1).max(3650).nullable(),
    purchase_url: link,
  })
  .partial();

const lessonSchema = z
  .object({
    title,
    content: pageContentSchema,
    video_url: httpUrl,
    status,
    free_preview: z.boolean(),
    drip_days: z.number().int().min(0).max(3650),
    module_id: z.number().int().positive(),
  })
  .partial();

const enrollSchema = z
  .object({
    contact_id: z.number().int().positive().optional(),
    email: z.email().max(254).optional(),
    access_at: date.optional(),
    expires_at: date.nullable().optional(),
  })
  .refine((b) => (b.contact_id === undefined) !== (b.email === undefined), 'Indiquez soit contact_id, soit email');

function checkDates(accessAt: string, expiresAt: string | null) {
  if (expiresAt && new Date(expiresAt).getTime() <= new Date(accessAt).getTime()) throw new HttpError(400, 'La date d’expiration doit être postérieure à la date d’accès');
}

// ---------- ownership ----------

async function ownCourse(userId: number, id: number, ex: Db = db): Promise<CourseRow> {
  const c = await ex.selectFrom('courses').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!c) throw notFound('Formation');
  return c;
}

async function ownModule(userId: number, id: number, ex: Db = db) {
  const m = await ex
    .selectFrom('course_modules as m')
    .innerJoin('courses as c', 'c.id', 'm.course_id')
    .select(['m.id', 'm.course_id', 'm.title', 'm.position'])
    .where('m.id', '=', id)
    .where('c.user_id', '=', userId)
    .executeTakeFirst();
  if (!m) throw notFound('Module');
  return m;
}

async function ownLesson(userId: number, id: number, ex: Db = db) {
  const l = await ex
    .selectFrom('course_lessons as l')
    .innerJoin('courses as c', 'c.id', 'l.course_id')
    .selectAll('l')
    .select(['c.slug as course_slug'])
    .where('l.id', '=', id)
    .where('c.user_id', '=', userId)
    .executeTakeFirst();
  if (!l) throw notFound('Leçon');
  return l;
}

const touchCourse = (id: number, ex: Db = db) => ex.updateTable('courses').set({ updated_at: nowIso() }).where('id', '=', id).execute();

async function fullCourse(userId: number, id: number) {
  const c = await getCourse(userId, id);
  if (!c) throw notFound('Formation');
  return c;
}

async function fullLesson(userId: number, id: number): Promise<Lesson> {
  const l = await ownLesson(userId, id);
  const [files, area] = await Promise.all([
    db.selectFrom('course_files').select(['id', 'lesson_id', 'name', 'size', 'created_at']).where('lesson_id', '=', id).orderBy('id').execute(),
    getArea(userId),
  ]);
  return {
    ...toLesson({ ...l, files_count: files.length }),
    content: lessonContent(l.content),
    files: files.map(toLessonFile),
    preview_url: `${PUBLIC_URL}${lessonPath(area, { slug: l.course_slug }, l.id)}?preview=${memberPreviewToken(userId)}`,
  };
}

/** Applies `ids` as the new order: they must be exactly the rows of the parent. */
function sameSet(given: number[], existing: number[]) {
  return given.length === existing.length && new Set(given).size === given.length && given.every((id) => existing.includes(id));
}

// ---------- members area settings ----------

coursesRouter.get('/member-area', async (req, res) => {
  res.json(toArea(await getArea(uid(req))));
});

coursesRouter.put('/member-area', async (req, res) => {
  const userId = uid(req);
  const body = areaSchema.parse(req.body);
  await getArea(userId);
  try {
    await db.updateTable('member_areas').set({ ...body, updated_at: nowIso() }).where('user_id', '=', userId).execute();
  } catch (e) {
    if (isUniqueViolation(e, 'member_areas_slug_key')) throw new HttpError(409, 'Cette adresse est déjà utilisée par un autre espace membres');
    throw e;
  }
  res.json(toArea(await getArea(userId)));
});

// ---------- courses ----------

coursesRouter.get('/courses', async (req, res) => {
  res.json(await listCourses(uid(req)));
});

coursesRouter.post('/courses', async (req, res) => {
  const userId = uid(req);
  const body = z.object({ title }).parse(req.body);
  const id = await db.transaction().execute(async (trx) => {
    const { n } = await trx.selectFrom('courses').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow();
    if (n >= MAX_COURSES) throw new HttpError(409, `Limite de ${MAX_COURSES} formations atteinte`);
    const course = await trx
      .insertInto('courses')
      .values({ user_id: userId, title: body.title, slug: await freeCourseSlug(userId, body.title, trx), position: n })
      .returning('id')
      .executeTakeFirstOrThrow();
    // a first module, so that lessons can be added right away
    await trx.insertInto('course_modules').values({ course_id: course.id, title: 'Module 1', position: 0 }).execute();
    return course.id;
  });
  res.status(201).json(await fullCourse(userId, id));
});

coursesRouter.post('/courses/reorder', async (req, res) => {
  const userId = uid(req);
  const body = z.object({ ids }).parse(req.body);
  await db.transaction().execute(async (trx) => {
    const existing = (await trx.selectFrom('courses').select('id').where('user_id', '=', userId).execute()).map((r) => r.id);
    if (!sameSet(body.ids, existing)) throw new HttpError(400, 'La liste doit contenir toutes les formations, une seule fois');
    for (const [i, id] of body.ids.entries()) await trx.updateTable('courses').set({ position: i }).where('id', '=', id).execute();
  });
  res.json(await listCourses(userId));
});

coursesRouter.get('/courses/:id', async (req, res) => {
  res.json(await fullCourse(uid(req), paramId(req.params.id, 'Formation')));
});

coursesRouter.patch('/courses/:id', async (req, res) => {
  const userId = uid(req);
  const course = await ownCourse(userId, paramId(req.params.id, 'Formation'));
  const body = courseSchema.parse(req.body);
  if (body.access_tag_id) {
    const tag = await db.selectFrom('tags').select('id').where('id', '=', body.access_tag_id).where('user_id', '=', userId).executeTakeFirst();
    if (!tag) throw notFound('Tag');
  }
  try {
    await db.updateTable('courses').set({ ...body, updated_at: nowIso() }).where('id', '=', course.id).execute();
  } catch (e) {
    if (isUniqueViolation(e, 'courses_user_slug_key')) throw new HttpError(409, 'Une autre formation utilise déjà cette adresse');
    throw e;
  }
  res.json(await fullCourse(userId, course.id));
});

coursesRouter.delete('/courses/:id', async (req, res) => {
  const userId = uid(req);
  const course = await ownCourse(userId, paramId(req.params.id, 'Formation'));
  const files = await db
    .selectFrom('course_files as f')
    .innerJoin('course_lessons as l', 'l.id', 'f.lesson_id')
    .select(['f.user_id', 'f.stored'])
    .where('l.course_id', '=', course.id)
    .execute();
  await db.deleteFrom('courses').where('id', '=', course.id).execute();
  removeStoredFiles(files);
  res.json({ ok: true });
});

// ---------- modules ----------

coursesRouter.post('/courses/:id/modules', async (req, res) => {
  const userId = uid(req);
  const course = await ownCourse(userId, paramId(req.params.id, 'Formation'));
  const body = z.object({ title }).parse(req.body);
  await db.transaction().execute(async (trx) => {
    const { n, max } = await trx
      .selectFrom('course_modules')
      .select((eb) => [eb.fn.countAll<number>().as('n'), eb.fn.max('position').as('max')])
      .where('course_id', '=', course.id)
      .executeTakeFirstOrThrow();
    if (n >= MAX_MODULES) throw new HttpError(409, `Limite de ${MAX_MODULES} modules par formation atteinte`);
    await trx.insertInto('course_modules').values({ course_id: course.id, title: body.title, position: (max ?? -1) + 1 }).execute();
    await touchCourse(course.id, trx);
  });
  res.status(201).json(await fullCourse(userId, course.id));
});

coursesRouter.post('/courses/:id/modules/reorder', async (req, res) => {
  const userId = uid(req);
  const course = await ownCourse(userId, paramId(req.params.id, 'Formation'));
  const body = z.object({ ids }).parse(req.body);
  await db.transaction().execute(async (trx) => {
    const existing = (await trx.selectFrom('course_modules').select('id').where('course_id', '=', course.id).execute()).map((r) => r.id);
    if (!sameSet(body.ids, existing)) throw new HttpError(400, 'La liste doit contenir tous les modules de la formation, une seule fois');
    for (const [i, id] of body.ids.entries()) await trx.updateTable('course_modules').set({ position: i }).where('id', '=', id).execute();
    await touchCourse(course.id, trx);
  });
  res.json(await fullCourse(userId, course.id));
});

coursesRouter.patch('/course-modules/:id', async (req, res) => {
  const userId = uid(req);
  const m = await ownModule(userId, paramId(req.params.id, 'Module'));
  const body = z.object({ title }).parse(req.body);
  await db.updateTable('course_modules').set({ title: body.title }).where('id', '=', m.id).execute();
  await touchCourse(m.course_id);
  res.json(await fullCourse(userId, m.course_id));
});

coursesRouter.delete('/course-modules/:id', async (req, res) => {
  const userId = uid(req);
  const m = await ownModule(userId, paramId(req.params.id, 'Module'));
  const files = await db
    .selectFrom('course_files as f')
    .innerJoin('course_lessons as l', 'l.id', 'f.lesson_id')
    .select(['f.user_id', 'f.stored'])
    .where('l.module_id', '=', m.id)
    .execute();
  await db.deleteFrom('course_modules').where('id', '=', m.id).execute();
  removeStoredFiles(files);
  await touchCourse(m.course_id);
  res.json(await fullCourse(userId, m.course_id));
});

// ---------- lessons ----------

coursesRouter.post('/course-modules/:id/lessons', async (req, res) => {
  const userId = uid(req);
  const m = await ownModule(userId, paramId(req.params.id, 'Module'));
  const body = z.object({ title }).parse(req.body);
  const area = await getArea(userId);
  const id = await db.transaction().execute(async (trx) => {
    const { n } = await trx.selectFrom('course_lessons').select((eb) => eb.fn.countAll<number>().as('n')).where('course_id', '=', m.course_id).executeTakeFirstOrThrow();
    if (n >= MAX_LESSONS) throw new HttpError(409, `Limite de ${MAX_LESSONS} leçons par formation atteinte`);
    const { max } = await trx.selectFrom('course_lessons').select((eb) => eb.fn.max('position').as('max')).where('module_id', '=', m.id).executeTakeFirstOrThrow();
    const lesson = await trx
      .insertInto('course_lessons')
      .values({ course_id: m.course_id, module_id: m.id, title: body.title, position: (max ?? -1) + 1, content: JSON.stringify(defaultLessonContent(area.color)) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await touchCourse(m.course_id, trx);
    return lesson.id;
  });
  res.status(201).json(await fullLesson(userId, id));
});

/** New order of the lessons of a module; lessons of another module of the same course are moved into it. */
coursesRouter.post('/course-modules/:id/lessons/reorder', async (req, res) => {
  const userId = uid(req);
  const m = await ownModule(userId, paramId(req.params.id, 'Module'));
  const body = z.object({ ids }).parse(req.body);
  await db.transaction().execute(async (trx) => {
    const inCourse = new Set((await trx.selectFrom('course_lessons').select('id').where('course_id', '=', m.course_id).execute()).map((r) => r.id));
    if (new Set(body.ids).size !== body.ids.length || !body.ids.every((id) => inCourse.has(id))) throw new HttpError(400, 'La liste contient une leçon inconnue ou en double');
    const inModule = (await trx.selectFrom('course_lessons').select('id').where('module_id', '=', m.id).execute()).map((r) => r.id);
    if (!inModule.every((id) => body.ids.includes(id))) throw new HttpError(400, 'La liste doit contenir toutes les leçons du module');
    for (const [i, id] of body.ids.entries()) await trx.updateTable('course_lessons').set({ module_id: m.id, position: i }).where('id', '=', id).execute();
    await touchCourse(m.course_id, trx);
  });
  res.json(await fullCourse(userId, m.course_id));
});

coursesRouter.get('/lessons/:id', async (req, res) => {
  res.json(await fullLesson(uid(req), paramId(req.params.id, 'Leçon')));
});

coursesRouter.patch('/lessons/:id', async (req, res) => {
  const userId = uid(req);
  const lesson = await ownLesson(userId, paramId(req.params.id, 'Leçon'));
  const { content, module_id, ...rest } = lessonSchema.parse(req.body);
  await db.transaction().execute(async (trx) => {
    let move: { module_id: number; position: number } | undefined;
    if (module_id !== undefined && module_id !== lesson.module_id) {
      const target = await ownModule(userId, module_id, trx);
      if (target.course_id !== lesson.course_id) throw new HttpError(400, 'Le module doit appartenir à la même formation');
      const { max } = await trx.selectFrom('course_lessons').select((eb) => eb.fn.max('position').as('max')).where('module_id', '=', target.id).executeTakeFirstOrThrow();
      move = { module_id: target.id, position: (max ?? -1) + 1 }; // appended at the end of its new module
    }
    await trx
      .updateTable('course_lessons')
      .set({ ...rest, ...(content ? { content: JSON.stringify(lessonContent(content as never)) } : {}), ...(move ?? {}), updated_at: nowIso() })
      .where('id', '=', lesson.id)
      .execute();
    await touchCourse(lesson.course_id, trx);
  });
  res.json(await fullLesson(userId, lesson.id));
});

coursesRouter.delete('/lessons/:id', async (req, res) => {
  const userId = uid(req);
  const lesson = await ownLesson(userId, paramId(req.params.id, 'Leçon'));
  const files = await db.selectFrom('course_files').select(['user_id', 'stored']).where('lesson_id', '=', lesson.id).execute();
  await db.deleteFrom('course_lessons').where('id', '=', lesson.id).execute();
  removeStoredFiles(files);
  await touchCourse(lesson.course_id);
  res.json({ ok: true });
});

// ---------- lesson files (downloads) ----------

coursesRouter.post('/lessons/:id/files', express.raw({ type: () => true, limit: LESSON_FILE_MAX_BYTES }), async (req, res) => {
  const userId = uid(req);
  const lesson = await ownLesson(userId, paramId(req.params.id, 'Leçon'));
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'Fichier vide ou manquant');
  const name = cleanFileName(req.query.name);
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  if (!name || !(LESSON_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new HttpError(415, `Type de fichier non pris en charge. Formats acceptés : ${LESSON_FILE_EXTENSIONS.join(', ')}`);
  }
  const { n } = await db.selectFrom('course_files').select((eb) => eb.fn.countAll<number>().as('n')).where('lesson_id', '=', lesson.id).executeTakeFirstOrThrow();
  if (n >= MAX_FILES_PER_LESSON) throw new HttpError(409, `Limite de ${MAX_FILES_PER_LESSON} fichiers par leçon atteinte`);
  const stored = writeLessonFile(userId, buf);
  try {
    const row = await db
      .insertInto('course_files')
      .values({ user_id: userId, lesson_id: lesson.id, name, stored, size: buf.length })
      .returning(['id', 'lesson_id', 'name', 'size', 'created_at'])
      .executeTakeFirstOrThrow();
    res.status(201).json(toLessonFile(row));
  } catch (e) {
    removeStoredFiles([{ user_id: userId, stored }]);
    throw e;
  }
});

async function ownFile(userId: number, id: number) {
  const f = await db.selectFrom('course_files').selectAll().where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!f) throw notFound('Fichier');
  return f;
}

/** Sends a stored lesson file as an attachment (never rendered inline, never sniffed). */
export function sendLessonFile(res: express.Response, f: { user_id: number; stored: string; name: string }) {
  const file = storedFilePath(f.user_id, f.stored);
  if (!fs.existsSync(file)) throw notFound('Fichier');
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': attachmentHeader(f.name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
  });
  fs.createReadStream(file).pipe(res);
}

coursesRouter.get('/lesson-files/:id/download', async (req, res) => {
  sendLessonFile(res, await ownFile(uid(req), paramId(req.params.id, 'Fichier')));
});

coursesRouter.delete('/lesson-files/:id', async (req, res) => {
  const f = await ownFile(uid(req), paramId(req.params.id, 'Fichier'));
  await db.deleteFrom('course_files').where('id', '=', f.id).execute();
  removeStoredFiles([f]);
  res.json({ ok: true });
});

// ---------- students ----------

coursesRouter.get('/courses/:id/students', async (req, res) => {
  res.json(await listStudents(await ownCourse(uid(req), paramId(req.params.id, 'Formation'))));
});

/** Manual access (created or updated). An unknown email creates the contact. */
coursesRouter.post('/courses/:id/students', async (req, res) => {
  const userId = uid(req);
  const course = await ownCourse(userId, paramId(req.params.id, 'Formation'));
  const body = enrollSchema.parse(req.body);
  const accessAt = body.access_at ?? nowIso();
  checkDates(accessAt, body.expires_at ?? null);
  const created = await db.transaction().execute(async (trx) => {
    const contact = body.contact_id ? await getContactRow(userId, body.contact_id, trx) : (await upsertContact(userId, { email: normEmail(body.email!) }, {}, trx)).contact;
    if (!contact) throw notFound('Contact');
    const row = await trx
      .insertInto('course_enrollments')
      .values({ user_id: userId, course_id: course.id, contact_id: contact.id, access_at: accessAt, expires_at: body.expires_at ?? null })
      .onConflict((oc) => oc.columns(['course_id', 'contact_id']).doUpdateSet({ access_at: accessAt, expires_at: body.expires_at ?? null }))
      .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
      .executeTakeFirstOrThrow();
    // timeline: only when the access is new (changing its dates is not a new access)
    if (row.inserted) await logEvent(userId, contact.id, 'course_access_granted', { course: course.title, course_id: course.id, via: 'manual' }, {}, trx);
    return row.inserted;
  });
  res.status(created ? 201 : 200).json(await listStudents(course));
});

coursesRouter.patch('/courses/:id/students/:contactId', async (req, res) => {
  const userId = uid(req);
  const course = await ownCourse(userId, paramId(req.params.id, 'Formation'));
  const contactId = paramId(req.params.contactId, 'Élève');
  const body = z.object({ access_at: date.optional(), expires_at: date.nullable().optional() }).parse(req.body);
  const cur = await db.selectFrom('course_enrollments').select(['id', 'access_at', 'expires_at']).where('course_id', '=', course.id).where('contact_id', '=', contactId).executeTakeFirst();
  if (!cur) throw new HttpError(404, 'Cet élève n’a pas d’accès manuel à modifier');
  const accessAt = body.access_at ?? cur.access_at;
  const expiresAt = body.expires_at === undefined ? cur.expires_at : body.expires_at;
  checkDates(accessAt, expiresAt);
  await db.updateTable('course_enrollments').set({ access_at: accessAt, expires_at: expiresAt }).where('id', '=', cur.id).execute();
  res.json(await listStudents(course));
});

/**
 * Removes the manual access. `?remove_tag=1` also removes the access tag of the course from the contact (otherwise a
 * contact who has the tag keeps its access). The progress is kept.
 */
coursesRouter.delete('/courses/:id/students/:contactId', async (req, res) => {
  const userId = uid(req);
  const course = await ownCourse(userId, paramId(req.params.id, 'Formation'));
  const contactId = paramId(req.params.contactId, 'Élève');
  if (!(await getContactRow(userId, contactId))) throw notFound('Élève');
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('course_enrollments').where('course_id', '=', course.id).where('contact_id', '=', contactId).execute();
    if (req.query.remove_tag === '1' && course.access_tag_id) await removeTag(userId, contactId, course.access_tag_id, trx);
  });
  const access = await courseAccess(course, contactId);
  res.json({ ok: true, still_has_access: access.granted });
});
