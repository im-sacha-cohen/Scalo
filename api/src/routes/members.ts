// Members area (public, server-rendered, `/m/<slug>/…`): magic-link login, library, course page, lesson player,
// progress, protected lesson files. Every request is resolved inside ONE account (the area's owner): courses,
// lessons, files, tokens and the session are always looked up with that account id.
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PageContent } from '@scalo/shared';
import { db, type ContactRow } from '../db';
import {
  areaPath,
  completedLessons,
  completeLesson,
  courseAccess,
  coursePath,
  lessonAvailableAt,
  lessonContent,
  lessonPath,
  percent,
  uncompleteLesson,
  verifyMemberPreviewToken,
  type AreaRow,
  type CourseAccess,
  type CourseRow,
} from '../services/courses';
import { normEmail } from '../services/contacts';
import { fieldVars, listFieldDefs } from '../services/fields';
import {
  badLinkPage,
  confirmLoginPage,
  coursePage,
  lessonPage,
  libraryPage,
  linkSentPage,
  lockedLessonPage,
  loginPage,
  messagePage,
  notFoundMemberPage,
  unknownAreaHtml,
  type Chrome,
  type CourseCard,
  type CourseView,
  type OutlineModule,
  type Page,
} from '../services/member-pages';
import {
  afterResponse,
  cleanupLoginTokens,
  consumeLoginToken,
  hashLoginToken,
  lookupLoginToken,
  MEMBER_LIMITS,
  memberCookieOptions,
  PREVIEW_COOKIE,
  requestLoginLink,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  signSession,
  verifySession,
} from '../services/members';
import { hit } from '../services/ratelimit';
import { PUBLIC_URL } from '../util';
import { sendLessonFile } from './courses';

export const membersRouter = Router();

interface Viewer extends Chrome {
  contact: ContactRow | null;
}

const send = (res: Response, p: Page) => void res.status(p.status).type('html').send(p.html);
const viewer = (res: Response) => res.locals.viewer as Viewer;
const emailCheck = z.email().max(254);

/** Only pages of this members area can be a post-login destination (no open redirect). */
function safeNext(area: AreaRow, v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  const home = areaPath(area);
  if (v !== home && !v.startsWith(`${home}/`)) return null;
  if (!/^[\w\-./]+$/.test(v) || v.includes('//') || v.includes('..')) return null;
  return v;
}

/**
 * State-changing forms: browsers send `Origin` on POST; a request coming from another site is refused (the session
 * cookie is SameSite=Lax already, this also covers the login forms which work without a session).
 */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return origin !== 'null';
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || host === new URL(PUBLIC_URL).host;
  } catch {
    return false;
  }
}

// ---------- area resolution, session, owner preview ----------

membersRouter.use('/m/:space', async (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // No script at all in the members area (lesson content is rendered from blocks; custom HTML is stripped), forms
  // only post back to the app, never framed.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self' https: http: data:; script-src 'none'; style-src 'unsafe-inline' https:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  const slug = String(req.params.space);
  const area = /^[a-z0-9-]{1,60}$/.test(slug) ? await db.selectFrom('member_areas').selectAll().where('slug', '=', slug).executeTakeFirst() : undefined;
  if (!area) return void res.status(404).type('html').send(unknownAreaHtml);

  // Owner preview link (?preview=<signed token>): remembered in a cookie scoped to this area, then the URL is cleaned.
  if (req.method === 'GET' && typeof req.query.preview === 'string') {
    const exp = verifyMemberPreviewToken(area.user_id, req.query.preview);
    if (exp) res.cookie(PREVIEW_COOKIE, req.query.preview, memberCookieOptions(area, exp - Date.now()));
    return res.redirect(302, safeNext(area, req.baseUrl + req.path.replace(/\/+$/, '')) ?? areaPath(area));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
    return send(res, messagePage({ area, member: null, preview: false }, 'Requête refusée', 'Cette action doit être lancée depuis l’espace membres.', 403));
  }

  const preview = verifyMemberPreviewToken(area.user_id, req.cookies?.[PREVIEW_COOKIE]) !== null;
  const contactId = verifySession(area.user_id, req.cookies?.[SESSION_COOKIE]);
  const contact = contactId
    ? ((await db.selectFrom('contacts').selectAll().where('id', '=', contactId).where('user_id', '=', area.user_id).executeTakeFirst()) ?? null)
    : null;
  res.locals.viewer = { area, preview, contact, member: contact ? { email: contact.email } : null } satisfies Viewer;
  next();
});

// ---------- login (magic link) ----------

membersRouter.get('/m/:space/login', (req, res) => {
  const v = viewer(res);
  const next = safeNext(v.area, req.query.next);
  if (v.contact) return res.redirect(302, next ?? areaPath(v.area));
  send(res, loginPage(v, { next }));
});

membersRouter.post('/m/:space/login', async (req, res) => {
  const v = viewer(res);
  const { area } = v;
  const next = safeNext(area, req.body?.next);
  // per IP: visible limit (429). Counted before anything else, whatever the address.
  const ip = await hit(`mlogin:ip:${area.user_id}:${req.ip ?? ''}`, MEMBER_LIMITS.loginIp);
  if (ip.blocked) {
    res.setHeader('Retry-After', String(ip.retryAfter));
    return send(res, messagePage(v, 'Trop de tentatives', 'Trop de demandes de lien de connexion. Réessayez dans quelques minutes.', 429));
  }
  const raw = typeof req.body?.email === 'string' ? req.body.email : '';
  const parsed = emailCheck.safeParse(normEmail(raw));
  if (!parsed.success) return send(res, loginPage(v, { error: 'Adresse email invalide. Merci de vérifier et de réessayer.', next, email: raw.slice(0, 254) }));
  const email = parsed.data;
  // per address: invisible limit. The response is the same whether the address is a member, unknown or limited.
  const perEmail = await hit(`mlogin:em:${area.user_id}:${hashLoginToken(email).slice(0, 32)}`, MEMBER_LIMITS.loginEmail);
  const contact = perEmail.blocked
    ? undefined
    : await db.selectFrom('contacts').selectAll().where('user_id', '=', area.user_id).where('email', '=', email).executeTakeFirst();
  send(res, linkSentPage(v));
  // The token and the email are created once the response is on its way: the response time does not tell a member
  // from an unknown address either.
  if (contact && !contact.bounced && !contact.complained) afterResponse(requestLoginLink(area, contact, next).then(() => cleanupLoginTokens()));
});

// GET only shows a button: mail scanners and link previewers open links automatically and must not consume the token.
membersRouter.get('/m/:space/auth/:token', async (req, res) => {
  // Referrer-Policy stays `same-origin` (set for the whole area): the token never leaves in a Referer to another
  // origin, and the form below still sends a real `Origin` (it would be `null` with `no-referrer`).
  const v = viewer(res);
  const state = await lookupLoginToken(v.area.user_id, String(req.params.token));
  if (state !== 'pending') return send(res, badLinkPage(v, state));
  send(res, confirmLoginPage(v, `${areaPath(v.area)}/auth/${encodeURIComponent(String(req.params.token))}`));
});

membersRouter.post('/m/:space/auth/:token', async (req, res) => {
  const v = viewer(res);
  const token = String(req.params.token);
  const done = await consumeLoginToken(v.area.user_id, token);
  if (!done) {
    const state = await lookupLoginToken(v.area.user_id, token);
    return send(res, badLinkPage(v, state === 'pending' ? 'invalid' : state));
  }
  res.cookie(SESSION_COOKIE, signSession(v.area.user_id, done.contactId), memberCookieOptions(v.area, SESSION_TTL_MS));
  res.redirect(303, safeNext(v.area, done.redirect) ?? areaPath(v.area));
});

membersRouter.post('/m/:space/logout', (_req, res) => {
  const v = viewer(res);
  res.clearCookie(SESSION_COOKIE, { path: areaPath(v.area) });
  res.redirect(303, `${areaPath(v.area)}/login`);
});

membersRouter.post('/m/:space/preview/exit', (_req, res) => {
  const v = viewer(res);
  res.clearCookie(PREVIEW_COOKIE, { path: areaPath(v.area) });
  res.redirect(303, areaPath(v.area));
});

// ---------- data ----------

interface LessonRow {
  id: number;
  module_id: number;
  title: string;
  status: 'draft' | 'published';
  free_preview: boolean;
  drip_days: number;
}

interface Loaded {
  course: CourseRow;
  access: CourseAccess | null;
  /** Lessons in display order (published only, unless owner preview). */
  lessons: LessonRow[];
  done: Set<number>;
  view: CourseView;
}

const gateOpen = (v: Viewer, l: LessonRow, access: CourseAccess | null, now = Date.now()) =>
  v.preview || l.free_preview || (!!access?.granted && new Date(lessonAvailableAt(access.start!, l.drip_days)).getTime() <= now);

/** Course of this area by slug with its outline for the viewer. Drafts only exist for the owner preview. */
async function loadCourse(v: Viewer, slug: string): Promise<Loaded | null> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const course = await db.selectFrom('courses').selectAll().where('user_id', '=', v.area.user_id).where('slug', '=', slug).executeTakeFirst();
  if (!course || (course.status !== 'published' && !v.preview)) return null;
  const [modules, allLessons, access, done] = await Promise.all([
    db.selectFrom('course_modules').select(['id', 'title']).where('course_id', '=', course.id).orderBy('position').orderBy('id').execute(),
    db
      .selectFrom('course_lessons')
      .select(['id', 'module_id', 'title', 'status', 'free_preview', 'drip_days'])
      .where('course_id', '=', course.id)
      .orderBy('position')
      .orderBy('id')
      .execute(),
    v.contact && !v.preview ? courseAccess(course, v.contact.id) : null,
    v.contact && !v.preview ? completedLessons(course.id, v.contact.id) : new Set<number>(),
  ]);
  const visible = allLessons.filter((l) => v.preview || l.status === 'published');
  const lessons: LessonRow[] = [];
  const outline: OutlineModule[] = [];
  for (const m of modules) {
    const own = visible.filter((l) => l.module_id === m.id);
    if (!own.length) continue;
    lessons.push(...own);
    outline.push({
      title: m.title,
      lessons: own.map((l) => {
        const open = gateOpen(v, l, access);
        return {
          id: l.id,
          title: l.title,
          url: lessonPath(v.area, course, l.id),
          done: done.has(l.id),
          open,
          free_preview: l.free_preview,
          draft: l.status !== 'published',
          available_at: !open && access?.granted ? lessonAvailableAt(access.start!, l.drip_days) : undefined,
        };
      }),
    });
  }
  return {
    course,
    access,
    lessons,
    done,
    view: { title: course.title, description: course.description, image_url: course.image_url, url: coursePath(v.area, course), draft: course.status !== 'published', modules: outline },
  };
}

const progressOf = (l: Loaded) => {
  const published = l.lessons.filter((x) => x.status === 'published');
  const done = published.filter((x) => l.done.has(x.id)).length;
  return { done, total: published.length, percent: percent(done, published.length) };
};

const loginLink = (v: Viewer, next: string) => `${areaPath(v.area)}/login?next=${encodeURIComponent(next)}`;

// ---------- library ----------

membersRouter.get('/m/:space', async (req, res) => {
  const v = viewer(res);
  if (!v.contact && !v.preview) return res.redirect(302, `${areaPath(v.area)}/login`);
  const courses = await db
    .selectFrom('courses')
    .selectAll()
    .where('user_id', '=', v.area.user_id)
    .$if(!v.preview, (q) => q.where('status', '=', 'published'))
    .orderBy('position')
    .orderBy('id')
    .execute();
  const mine: CourseCard[] = [];
  const others: CourseCard[] = [];
  for (const c of courses) {
    const base = { title: c.title, description: c.description, image_url: c.image_url, url: coursePath(v.area, c), draft: c.status !== 'published' };
    if (v.preview) {
      mine.push(base);
      continue;
    }
    const access = await courseAccess(c, v.contact!.id);
    if (!access.granted) {
      others.push({ ...base, expired: access.expired });
      continue;
    }
    const [total, done] = await Promise.all([
      db.selectFrom('course_lessons').select((eb) => eb.fn.countAll<number>().as('n')).where('course_id', '=', c.id).where('status', '=', 'published').executeTakeFirstOrThrow(),
      db
        .selectFrom('lesson_progress as p')
        .innerJoin('course_lessons as l', 'l.id', 'p.lesson_id')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('p.course_id', '=', c.id)
        .where('p.contact_id', '=', v.contact!.id)
        .where('l.status', '=', 'published')
        .executeTakeFirstOrThrow(),
    ]);
    mine.push({ ...base, progress: { done: done.n, total: total.n, percent: percent(done.n, total.n) } });
  }
  send(res, libraryPage(v, mine, others));
});

// ---------- protected lesson files ----------
// Before the course routes: `files` is a reserved course slug.

membersRouter.get('/m/:space/files/:fileId', async (req, res) => {
  const v = viewer(res);
  const id = /^\d{1,15}$/.test(String(req.params.fileId)) ? Number(req.params.fileId) : 0;
  const f = id
    ? await db
        .selectFrom('course_files as f')
        .innerJoin('course_lessons as l', 'l.id', 'f.lesson_id')
        .innerJoin('courses as c', 'c.id', 'l.course_id')
        .select(['f.user_id', 'f.stored', 'f.name', 'l.id as lesson_id', 'l.module_id', 'l.title', 'l.status', 'l.free_preview', 'l.drip_days', 'c.slug as course_slug', 'c.status as course_status'])
        .where('f.id', '=', id)
        .where('c.user_id', '=', v.area.user_id)
        .executeTakeFirst()
    : undefined;
  // same answer for an unknown file and a file the viewer may not download
  const denied = () => send(res, notFoundMemberPage(v));
  if (!f) return denied();
  if (!v.preview && (f.course_status !== 'published' || f.status !== 'published')) return denied();
  const loaded = await loadCourse(v, f.course_slug);
  if (!loaded) return denied();
  if (!gateOpen(v, { id: f.lesson_id, module_id: f.module_id, title: f.title, status: f.status, free_preview: f.free_preview, drip_days: f.drip_days }, loaded.access)) {
    if (!v.contact) return res.redirect(302, loginLink(v, lessonPath(v.area, loaded.course, f.lesson_id)));
    return denied();
  }
  sendLessonFile(res, f);
});

// ---------- course ----------

membersRouter.get('/m/:space/:courseSlug', async (req, res) => {
  const v = viewer(res);
  const loaded = await loadCourse(v, String(req.params.courseSlug));
  if (!loaded) return send(res, notFoundMemberPage(v));
  const { course, access, view } = loaded;
  if (v.preview || access?.granted) {
    const firstOpen = view.modules.flatMap((m) => m.lessons).find((l) => l.open && !l.done) ?? view.modules.flatMap((m) => m.lessons).find((l) => l.open);
    const completed = !v.preview && !!(await db.selectFrom('course_completions').select('course_id').where('course_id', '=', course.id).where('contact_id', '=', v.contact!.id).executeTakeFirst());
    return send(res, coursePage(v, view, { access: true, progress: progressOf(loaded), continueUrl: firstOpen?.url ?? null, completed }));
  }
  send(
    res,
    coursePage(v, view, {
      access: false,
      expired: !!access?.expired,
      purchaseUrl: course.purchase_url,
      loginUrl: v.contact ? null : loginLink(v, coursePath(v.area, course)),
    }),
  );
});

// ---------- lesson ----------

async function loadLesson(v: Viewer, req: Request) {
  const loaded = await loadCourse(v, String(req.params.courseSlug));
  const id = /^\d{1,15}$/.test(String(req.params.lessonId)) ? Number(req.params.lessonId) : 0;
  const idx = loaded ? loaded.lessons.findIndex((l) => l.id === id) : -1;
  if (!loaded || idx < 0) return null;
  return { loaded, idx, lesson: loaded.lessons[idx] };
}

membersRouter.get('/m/:space/:courseSlug/:lessonId', async (req, res) => {
  const v = viewer(res);
  const r = await loadLesson(v, req);
  if (!r) return send(res, notFoundMemberPage(v));
  const { loaded, idx, lesson } = r;
  const { course, access, view } = loaded;
  const here = lessonPath(v.area, course, lesson.id);

  if (!gateOpen(v, lesson, access)) {
    // nothing of the lesson (content, video URL, files) is rendered below this point
    if (!v.contact) return res.redirect(302, loginLink(v, here));
    if (!access?.granted) return res.redirect(302, coursePath(v.area, course));
    return send(res, lockedLessonPage(v, view, lesson.id, lesson.title, lessonAvailableAt(access.start!, lesson.drip_days)));
  }

  const [row, files, defs] = await Promise.all([
    db.selectFrom('course_lessons').select(['content', 'video_url']).where('id', '=', lesson.id).executeTakeFirstOrThrow(),
    db.selectFrom('course_files').select(['id', 'name', 'size']).where('lesson_id', '=', lesson.id).orderBy('id').execute(),
    listFieldDefs(v.area.user_id),
  ]);
  const c = v.contact;
  const vars: Record<string, string> = {
    first_name: c?.first_name ?? '',
    last_name: c?.last_name ?? '',
    email: c?.email ?? '',
    phone: c?.phone ?? '',
    ...fieldVars(defs, c?.fields ?? null),
  };
  const prev = loaded.lessons[idx - 1];
  const next = loaded.lessons[idx + 1];
  // progress is tracked for members with access to the course (not for the owner preview nor free-preview visitors)
  const tracked = !v.preview && !!c && !!access?.granted && lesson.status === 'published';
  const notice = req.query.termine === '1' ? 'Bravo, vous avez terminé cette formation !' : undefined;
  send(
    res,
    lessonPage(
      v,
      view,
      lesson.id,
      {
        title: lesson.title,
        content: lessonContent(row.content as PageContent),
        video_url: row.video_url,
        draft: lesson.status !== 'published',
        free_preview: lesson.free_preview,
        files: files.map((f) => ({ name: f.name, size: f.size, url: `${areaPath(v.area)}/files/${f.id}` })),
        done: loaded.done.has(lesson.id),
        completeAction: tracked ? `${here}/complete` : null,
        prevUrl: prev ? lessonPath(v.area, course, prev.id) : null,
        nextUrl: next ? lessonPath(v.area, course, next.id) : null,
        vars,
      },
      notice,
    ),
  );
});

membersRouter.post('/m/:space/:courseSlug/:lessonId/complete', async (req, res) => {
  const v = viewer(res);
  const r = await loadLesson(v, req);
  if (!r) return send(res, notFoundMemberPage(v));
  const { loaded, idx, lesson } = r;
  const { course, access } = loaded;
  const here = lessonPath(v.area, course, lesson.id);
  if (v.preview) return res.redirect(303, here);
  if (!v.contact) return res.redirect(303, loginLink(v, here));
  // only an open lesson of a course the member has access to (a free preview alone is not tracked)
  if (!access?.granted || lesson.status !== 'published' || !gateOpen({ ...v, preview: false }, { ...lesson, free_preview: false }, access)) {
    return res.redirect(303, coursePath(v.area, course));
  }
  if (req.body?.done === '0') {
    await uncompleteLesson(lesson.id, v.contact.id);
    return res.redirect(303, here);
  }
  const result = await completeLesson(course, lesson, v.contact.id);
  const next = loaded.lessons[idx + 1];
  if (result.courseCompleted) return res.redirect(303, `${here}?termine=1`);
  res.redirect(303, next ? lessonPath(v.area, course, next.id) : here);
});

// anything else under /m/<slug>
membersRouter.use('/m/:space', (_req, res) => send(res, notFoundMemberPage(viewer(res))));
