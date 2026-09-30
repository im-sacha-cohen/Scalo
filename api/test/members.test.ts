// Members area (public /m/<slug>): magic-link login, access by tag / manual / expiry, drip, protected content and
// files, progress, owner preview, isolation between accounts.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db';
import { removeStoredFiles } from '../src/services/courses';
import { MEMBER_LIMITS, settleLoginLinks } from '../src/services/members';
import { EmailWorker } from '../src/worker';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(async () => {
  removeStoredFiles(await db.selectFrom('course_files').select(['user_id', 'stored']).execute()); // files uploaded by the tests
  await shutdown(ctx);
});

let seq = 0;
const DAY = 86400_000;
const text = (id: string, t: string) => ({ settings: {}, blocks: [{ id, type: 'text', text: t }] });

/**
 * Account with a published course (access tag "client"):
 *   Module 1: L1 (published), L2 (published, drip 7 days, one file)
 *   Module 2: L3 (published, free preview, one file), L4 (draft)
 * and a second, draft course.
 */
async function setup() {
  const reg = await registerUser(ctx, `Campus ${++seq}`);
  const api = client(ctx, reg.token);
  const area = (await api.get('/api/member-area')).body;
  const tag = (await api.post('/api/tags', { name: 'client' })).body;
  let course = (await api.post('/api/courses', { title: 'Méthode Piano' })).body;
  const m1 = course.modules[0];
  const m2 = (await api.post(`/api/courses/${course.id}/modules`, { title: 'Bonus' })).body.modules[1];
  const mk = async (moduleId: number, title: string, patch: Record<string, unknown>) => {
    const l = (await api.post(`/api/course-modules/${moduleId}/lessons`, { title })).body;
    return (await api.patch(`/api/lessons/${l.id}`, { content: text('t', `SECRET-${title}`), ...patch })).body;
  };
  const l1 = await mk(m1.id, 'L1', { status: 'published', video_url: 'https://cdn.exemple.fr/video-l1.mp4' });
  const l2 = await mk(m1.id, 'L2', { status: 'published', drip_days: 7 });
  const l3 = await mk(m2.id, 'L3', { status: 'published', free_preview: true });
  const l4 = await mk(m2.id, 'L4', {});
  const file = async (lessonId: number, name: string) =>
    (await http(ctx, 'POST', `/api/lessons/${lessonId}/files?name=${name}`, { token: reg.token, body: `FILE-${name}` })).body;
  const f2 = await file(l2.id, 'l2.pdf');
  const f3 = await file(l3.id, 'l3.pdf');
  course = (await api.patch(`/api/courses/${course.id}`, { status: 'published', access_tag_id: tag.id, purchase_url: 'https://exemple.fr/acheter', description: 'Apprenez le piano.' })).body;
  const draft = (await api.post('/api/courses', { title: 'Cours secret' })).body;
  const home = `/m/${area.slug}`;
  const lessonUrl = (l: { id: number }) => `${home}/${course.slug}/${l.id}`;
  return { api, token: reg.token, userId: reg.user.id, area, tag, course, draft, l1, l2, l3, l4, f2, f3, home, lessonUrl, courseUrl: `${home}/${course.slug}` };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const loginSends = (contactId: number) =>
  db.selectFrom('email_sends').selectAll().where('contact_id', '=', contactId).where('subject', 'like', 'Votre lien de connexion%').orderBy('id').execute();
const tokenOf = (html: string | null) => /\/auth\/([\w-]{20,})/.exec(html ?? '')?.[1] ?? '';

/** Requests a magic link for `email` and returns the token found in the queued email ('' when nothing was sent). */
async function requestLink(s: Setup, email: string, next?: string) {
  const before = await db.selectFrom('email_sends').select((eb) => eb.fn.countAll<number>().as('n')).where('user_id', '=', s.userId).executeTakeFirstOrThrow();
  const res = await http(ctx, 'POST', `${s.home}/login`, { form: { email, ...(next ? { next } : {}) } });
  await settleLoginLinks(); // the email is queued right after the response
  const sends = await db.selectFrom('email_sends').selectAll().where('user_id', '=', s.userId).orderBy('id', 'desc').execute();
  return { res, token: sends.length > before.n ? tokenOf(sends[0].html) : '', send: sends.length > before.n ? sends[0] : null };
}

/** Full login: returns the member session cookie. */
async function login(s: Setup, email: string) {
  const { token } = await requestLink(s, email);
  assert.ok(token, 'login email queued');
  const r = await http(ctx, 'POST', `${s.home}/auth/${token}`);
  assert.equal(r.status, 303, r.text);
  assert.ok(r.cookies.scalo_member);
  return { scalo_member: r.cookies.scalo_member };
}

async function member(s: Setup, email: string, tags: string[] = ['client']) {
  const contact = (await s.api.post('/api/contacts', { email, tags })).body;
  return { contact, cookies: await login(s, email) };
}

const get = (path: string, cookies?: Record<string, string>) => http(ctx, 'GET', path, { cookies });
const post = (path: string, cookies?: Record<string, string>, form: Record<string, string> = {}) => http(ctx, 'POST', path, { cookies, form });

describe('magic link login', () => {
  test('unknown area → 404; library and lessons ask to log in', async () => {
    const s = await setup();
    assert.equal((await get('/m/espace-inconnu')).status, 404);
    assert.equal((await get('/m/espace-inconnu/login')).status, 404);
    const lib = await get(s.home);
    assert.equal(lib.status, 302);
    assert.equal(lib.headers.get('location'), `${s.home}/login`);
    const page = await get(`${s.home}/login`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Recevoir mon lien de connexion/);
    assert.match(page.text, new RegExp(s.area.name));
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
    const lesson = await get(s.lessonUrl(s.l1));
    assert.equal(lesson.status, 302);
    assert.equal(lesson.headers.get('location'), `${s.home}/login?next=${encodeURIComponent(s.lessonUrl(s.l1))}`);
  });

  test('same response whether the address is a member or not; link only sent to contacts of the account', async () => {
    const s = await setup();
    const other = await setup();
    const contact = (await s.api.post('/api/contacts', { email: 'eleve@mail.fr', first_name: 'Léa' })).body;
    await other.api.post('/api/contacts', { email: 'ailleurs@mail.fr' });

    const known = await requestLink(s, ' Eleve@Mail.fr ');
    const unknown = await requestLink(s, 'inconnu@mail.fr');
    const elsewhere = await requestLink(s, 'ailleurs@mail.fr'); // contact of another account
    for (const r of [known, unknown, elsewhere]) assert.equal(r.res.status, 200);
    assert.equal(unknown.res.text, known.res.text, 'no account enumeration');
    assert.equal(elsewhere.res.text, known.res.text);
    assert.match(known.res.text, /Vérifiez votre boîte mail/);
    assert.ok(known.token);
    assert.equal(unknown.token, '');
    assert.equal(elsewhere.token, '');

    // the email: queued with top priority, pre-rendered, link to this area, token stored hashed only
    const sends = await loginSends(contact.id);
    assert.equal(sends.length, 1);
    assert.deepEqual([sends[0].kind, sends[0].status, sends[0].to_email], ['confirmation', 'pending', 'eleve@mail.fr']);
    assert.ok(sends[0].html!.includes(`${s.home}/auth/${known.token}`));
    assert.match(sends[0].html!, /Bonjour Léa/);
    const rows = await db.selectFrom('member_login_tokens').selectAll().where('contact_id', '=', contact.id).execute();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].token_hash, known.token);
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
    const ttl = new Date(rows[0].expires_at).getTime() - Date.now();
    assert.ok(ttl > 15 * 60_000 && ttl <= 20 * 60_000, 'short expiry');

    // delivered by the worker as is (no click tracking: the link must stay intact), even to an unsubscribed contact
    await db.updateTable('contacts').set({ unsubscribed: true }).where('id', '=', contact.id).execute();
    await new EmailWorker({ throttle: false }).drain();
    const [sent] = await loginSends(contact.id);
    assert.equal(sent.status, 'sent', sent.error ?? '');
    assert.ok(sent.html!.includes(`${s.home}/auth/${known.token}`) && !sent.html!.includes('/t/c/'));

    // invalid address: form shown again (nothing sent)
    const bad = await http(ctx, 'POST', `${s.home}/login`, { form: { email: 'pas-un-email' } });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /Adresse email invalide/);

    // bounced address: nothing sent, same page
    await db.updateTable('contacts').set({ bounced: true }).where('id', '=', contact.id).execute();
    const bounced = await requestLink(s, 'eleve@mail.fr');
    assert.equal(bounced.token, '');
    assert.equal(bounced.res.text, known.res.text);
  });

  test('GET does not authenticate; POST logs in once; used / expired / foreign tokens are refused', async () => {
    const s = await setup();
    const other = await setup();
    const contact = (await s.api.post('/api/contacts', { email: 'eleve@mail.fr' })).body;
    const { token } = await requestLink(s, 'eleve@mail.fr');

    // mail scanners: any number of GETs leaves the token usable and sets no session
    for (let i = 0; i < 3; i++) {
      const g = await get(`${s.home}/auth/${token}`);
      assert.equal(g.status, 200);
      assert.match(g.text, /<form method="post"/);
      assert.deepEqual(g.cookies, {});
    }
    assert.equal((await db.selectFrom('member_login_tokens').select('used_at').where('contact_id', '=', contact.id).executeTakeFirstOrThrow()).used_at, null);

    // a token is only valid on its own members area
    assert.equal((await get(`${other.home}/auth/${token}`)).status, 404);
    const wrongArea = await post(`${other.home}/auth/${token}`);
    assert.equal(wrongArea.status, 404);
    assert.deepEqual(wrongArea.cookies, {});

    const ok = await post(`${s.home}/auth/${token}`);
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), s.home);
    const setCookie = ok.headers.getSetCookie().find((c) => c.startsWith('scalo_member='))!;
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, new RegExp(`Path=${s.home}(;|$)`));
    const cookies = { scalo_member: ok.cookies.scalo_member };
    const lib = await get(s.home, cookies);
    assert.equal(lib.status, 200);
    assert.match(lib.text, /Mes formations/);
    assert.match(lib.text, /eleve@mail\.fr/);

    // single use
    const again = await post(`${s.home}/auth/${token}`);
    assert.equal(again.status, 410);
    assert.match(again.text, /déjà été utilisé/);
    assert.deepEqual(again.cookies, {});
    assert.equal((await get(`${s.home}/auth/${token}`)).status, 410);

    // expired
    const second = await requestLink(s, 'eleve@mail.fr');
    await db.updateTable('member_login_tokens').set({ expires_at: new Date(Date.now() - 1000).toISOString() }).where('used_at', 'is', null).execute();
    const g = await get(`${s.home}/auth/${second.token}`);
    assert.equal(g.status, 410);
    assert.match(g.text, /expiré/);
    const expired = await post(`${s.home}/auth/${second.token}`);
    assert.equal(expired.status, 410);
    assert.deepEqual(expired.cookies, {});

    // garbage
    assert.equal((await post(`${s.home}/auth/${'x'.repeat(43)}`)).status, 404);
    assert.equal((await post(`${s.home}/auth/abc`)).status, 404);

    // the session is bound to its account: useless on another area, and tampering breaks it
    assert.equal((await get(other.home, cookies)).status, 302);
    const forged = { scalo_member: cookies.scalo_member.replace(/^\d+/, String(contact.id + 1)) };
    assert.equal((await get(s.home, forged)).status, 302);
    // the admin session (JWT) is not a member session either
    assert.equal((await http(ctx, 'GET', s.home, { token: s.token })).status, 302);

    // logout
    const out = await post(`${s.home}/logout`, cookies);
    assert.equal(out.status, 303);
    assert.match(out.headers.getSetCookie().join('\n'), /scalo_member=;/);

    // deleting the contact ends its session
    await s.api.del(`/api/contacts/${contact.id}`);
    assert.equal((await get(s.home, cookies)).status, 302);
  });

  test('rate limits: per address (silent) and per IP (429)', async () => {
    const s = await setup();
    const contact = (await s.api.post('/api/contacts', { email: 'eleve@mail.fr' })).body;
    const pages: string[] = [];
    for (let i = 0; i < MEMBER_LIMITS.loginEmail.max + 2; i++) {
      const r = await http(ctx, 'POST', `${s.home}/login`, { form: { email: 'eleve@mail.fr' } });
      assert.equal(r.status, 200);
      pages.push(r.text);
    }
    await settleLoginLinks();
    assert.equal((await loginSends(contact.id)).length, MEMBER_LIMITS.loginEmail.max, 'no more emails than the limit');
    assert.ok(pages.every((p) => p === pages[0]), 'the limit is invisible');

    // per IP: visible
    let last = await http(ctx, 'POST', `${s.home}/login`, { form: { email: 'a@mail.fr' } });
    for (let i = 0; i < MEMBER_LIMITS.loginIp.max && last.status !== 429; i++) {
      last = await http(ctx, 'POST', `${s.home}/login`, { form: { email: `autre${i}@mail.fr` } });
    }
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    assert.match(last.text, /Trop de/);
    const total = await db.selectFrom('auth_attempts').select('count').where('key', 'like', `mlogin:ip:${s.userId}:%`).executeTakeFirstOrThrow();
    assert.equal(total.count, MEMBER_LIMITS.loginIp.max + 1);
    // another members area is not affected
    const other = await setup();
    assert.equal((await http(ctx, 'POST', `${other.home}/login`, { form: { email: 'a@mail.fr' } })).status, 200);
  });

  test('no open redirect; forms refuse another origin', async () => {
    const s = await setup();
    await s.api.post('/api/contacts', { email: 'eleve@mail.fr', tags: ['client'] });
    for (const next of ['https://evil.example/', '//evil.example', `${s.home}/../../p/x`, `${s.home}//evil.example`, '/p/autre', `${s.home}?x=https://evil.example`]) {
      const page = await get(`${s.home}/login?next=${encodeURIComponent(next)}`);
      assert.ok(!page.text.includes('name="next"'), `next ignored: ${next}`);
      const { token } = await requestLink(s, 'eleve@mail.fr', next);
      const r = token ? await post(`${s.home}/auth/${token}`) : null;
      if (r) assert.equal(r.headers.get('location'), s.home, next);
    }
    // a page of the area is kept through the whole flow
    const s2 = await setup();
    await s2.api.post('/api/contacts', { email: 'eleve@mail.fr', tags: ['client'] });
    const target = s2.lessonUrl(s2.l1);
    assert.match((await get(`${s2.home}/login?next=${encodeURIComponent(target)}`)).text, new RegExp(`name="next" value="${target}"`));
    const { token } = await requestLink(s2, 'eleve@mail.fr', target);
    const r = await post(`${s2.home}/auth/${token}`);
    assert.equal(r.headers.get('location'), target);
    // already logged in: /login goes straight to the page
    const cookies = { scalo_member: r.cookies.scalo_member };
    assert.equal((await get(`${s2.home}/login?next=${encodeURIComponent(target)}`, cookies)).headers.get('location'), target);

    // cross-site form posts
    const evil = await fetch(`${ctx.base}${s2.home}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: 'email=eleve%40mail.fr',
      redirect: 'manual',
    });
    assert.equal(evil.status, 403);
    const same = await fetch(`${ctx.base}${s2.home}/logout`, { method: 'POST', headers: { origin: ctx.base }, redirect: 'manual' });
    assert.equal(same.status, 303);
  });
});

describe('access', () => {
  test('without access: course page with the purchase link, no lesson content, no file', async () => {
    const s = await setup();
    const { cookies } = await member(s, 'sans@mail.fr', []);

    const lib = await get(s.home, cookies);
    assert.match(lib.text, /Vous n’avez accès à aucune formation/);
    assert.match(lib.text, /Autres formations/);
    assert.match(lib.text, /Méthode Piano/);
    assert.ok(!lib.text.includes('Cours secret'), 'draft course hidden');

    const fiche = await get(s.courseUrl, cookies);
    assert.equal(fiche.status, 200);
    assert.match(fiche.text, /Apprenez le piano\./);
    assert.match(fiche.text, /href="https:\/\/exemple\.fr\/acheter"/);
    assert.match(fiche.text, /Obtenir l’accès/);
    assert.match(fiche.text, /L1/, 'outline (titles) shown');
    assert.ok(!fiche.text.includes('L4'), 'draft lesson hidden');
    assert.ok(!fiche.text.includes('SECRET-'));

    for (const l of [s.l1, s.l2]) {
      const r = await get(s.lessonUrl(l), cookies);
      assert.equal(r.status, 302);
      assert.equal(r.headers.get('location'), s.courseUrl);
      assert.ok(!r.text.includes('SECRET-') && !r.text.includes('video-l1.mp4'));
    }
    assert.equal((await get(`${s.home}/files/${s.f2.id}`, cookies)).status, 404);
    assert.equal((await post(`${s.lessonUrl(s.l1)}/complete`, cookies, { done: '1' })).headers.get('location'), s.courseUrl);
    assert.equal((await db.selectFrom('lesson_progress').selectAll().execute()).filter((p) => p.lesson_id === s.l1.id).length, 0);

    // draft lesson / draft course / unknown ids: 404
    assert.equal((await get(s.lessonUrl(s.l4), cookies)).status, 404);
    assert.equal((await get(`${s.home}/${s.draft.slug}`, cookies)).status, 404);
    assert.equal((await get(`${s.home}/${s.course.slug}/999999`, cookies)).status, 404);
    assert.equal((await get(`${s.home}/inconnu`, cookies)).status, 404);
  });

  test('visitor (no session): free preview lesson and its file only', async () => {
    const s = await setup();
    const fiche = await get(s.courseUrl);
    assert.equal(fiche.status, 200);
    assert.match(fiche.text, /Déjà inscrit \? Se connecter/);
    assert.match(fiche.text, /Aperçu gratuit/);

    const free = await get(s.lessonUrl(s.l3));
    assert.equal(free.status, 200);
    assert.match(free.text, /SECRET-L3/);
    assert.ok(!free.text.includes('/complete'), 'progress is not tracked for visitors');
    const dl = await get(`${s.home}/files/${s.f3.id}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.text, 'FILE-l3.pdf');
    assert.match(dl.headers.get('content-disposition') ?? '', /^attachment/);

    assert.equal((await get(s.lessonUrl(s.l1))).status, 302);
    const f2 = await get(`${s.home}/files/${s.f2.id}`);
    assert.equal(f2.status, 302);
    assert.match(f2.headers.get('location') ?? '', /\/login\?next=/);
    assert.equal((await get(`${s.home}/files/999999`)).status, 404);
    assert.equal((await post(`${s.lessonUrl(s.l3)}/complete`, undefined, { done: '1' })).status, 303);
    assert.equal((await db.selectFrom('lesson_progress').selectAll().where('lesson_id', '=', s.l3.id).execute()).length, 0);

    // unpublished: the free preview disappears with the course
    await s.api.patch(`/api/courses/${s.course.id}`, { status: 'draft' });
    assert.equal((await get(s.lessonUrl(s.l3))).status, 404);
    assert.equal((await get(`${s.home}/files/${s.f3.id}`)).status, 404);
  });

  test('access by tag: given, removed, expired after access_days', async () => {
    const s = await setup();
    const { contact, cookies } = await member(s, 'eleve@mail.fr', []);
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 302);

    await s.api.post(`/api/contacts/${contact.id}/tags`, { name: 'client' }); // what a purchase / an automation does
    const lesson = await get(s.lessonUrl(s.l1), cookies);
    assert.equal(lesson.status, 200);
    assert.match(lesson.text, /SECRET-L1/);
    assert.match(lesson.text, /<video[^>]+src="https:\/\/cdn\.exemple\.fr\/video-l1\.mp4"/);
    assert.match(lesson.text, /Marquer comme terminée/);
    const lib = await get(s.home, cookies);
    assert.match(lib.text, /0 % — 0 \/ 3 leçons/);
    assert.ok(!lib.text.includes('Autres formations'));
    const fiche = await get(s.courseUrl, cookies);
    assert.match(fiche.text, /Commencer/);
    assert.ok(!fiche.text.includes('exemple.fr/acheter'));

    // validity of the tag access
    await s.api.patch(`/api/courses/${s.course.id}`, { access_days: 30 });
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 200);
    await db.updateTable('contact_tags').set({ created_at: new Date(Date.now() - 40 * DAY).toISOString() }).where('contact_id', '=', contact.id).execute();
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 302);
    const expired = await get(s.courseUrl, cookies);
    assert.match(expired.text, /Votre accès à cette formation a expiré/);
    assert.match(expired.text, /Renouveler mon accès/);
    assert.match((await get(s.home, cookies)).text, /Accès expiré/);
    const students = (await s.api.get(`/api/courses/${s.course.id}/students`)).body;
    assert.deepEqual([students[0].active, students[0].via], [false, ['tag']]);
    await s.api.patch(`/api/courses/${s.course.id}`, { access_days: null });
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 200);

    // tag removed → access removed
    await s.api.del(`/api/contacts/${contact.id}/tags/${s.tag.id}`);
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 302);
    assert.equal((await get(`${s.home}/files/${s.f2.id}`, cookies)).status, 404);
  });

  test('manual access: access date, expiry, removal', async () => {
    const s = await setup();
    const { contact, cookies } = await member(s, 'eleve@mail.fr', []);
    const students = `/api/courses/${s.course.id}/students`;
    await s.api.post(students, { contact_id: contact.id });
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 200);

    await s.api.patch(`${students}/${contact.id}`, { access_at: new Date(Date.now() - 10 * DAY).toISOString(), expires_at: new Date(Date.now() - DAY).toISOString() });
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 302);
    assert.match((await get(s.courseUrl, cookies)).text, /a expiré/);
    assert.equal((await get(`${s.home}/files/${s.f2.id}`, cookies)).status, 404);

    await s.api.patch(`${students}/${contact.id}`, { expires_at: new Date(Date.now() + DAY).toISOString() });
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 200);

    // an expired manual access does not hide a valid tag access
    await s.api.patch(`${students}/${contact.id}`, { expires_at: new Date(Date.now() - DAY).toISOString() });
    await s.api.post(`/api/contacts/${contact.id}/tags`, { name: 'client' });
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 200);
    await s.api.del(`${students}/${contact.id}?remove_tag=1`);
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 302);
  });

  test('drip: lesson, file and completion locked until N days after the access', async () => {
    const s = await setup();
    const { contact, cookies } = await member(s, 'eleve@mail.fr', []);
    const students = `/api/courses/${s.course.id}/students`;
    const accessAt = new Date(Date.now() - 3 * DAY);
    await s.api.post(students, { contact_id: contact.id, access_at: accessAt.toISOString() });

    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 200, 'no drip on L1');
    const locked = await get(s.lessonUrl(s.l2), cookies);
    assert.equal(locked.status, 403);
    assert.match(locked.text, /Cette leçon sera disponible le/);
    const opens = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'Europe/Paris' }).format(new Date(accessAt.getTime() + 7 * DAY));
    assert.ok(locked.text.includes(opens), `opening date shown (${opens})`);
    assert.ok(!locked.text.includes('SECRET-L2'));
    assert.equal((await get(`${s.home}/files/${s.f2.id}`, cookies)).status, 404);
    assert.equal((await post(`${s.lessonUrl(s.l2)}/complete`, cookies, { done: '1' })).headers.get('location'), s.courseUrl);
    assert.equal((await db.selectFrom('lesson_progress').selectAll().where('lesson_id', '=', s.l2.id).execute()).length, 0);
    // the outline of an open lesson announces the date
    assert.ok((await get(s.lessonUrl(s.l1), cookies)).text.includes(`Le ${opens}`));

    await s.api.patch(`${students}/${contact.id}`, { access_at: new Date(Date.now() - 8 * DAY).toISOString() });
    const open = await get(s.lessonUrl(s.l2), cookies);
    assert.equal(open.status, 200);
    assert.match(open.text, /SECRET-L2/);
    assert.equal((await get(`${s.home}/files/${s.f2.id}`, cookies)).text, 'FILE-l2.pdf');

    // access in the future: nothing opens before that date
    await s.api.patch(`${students}/${contact.id}`, { access_at: new Date(Date.now() + 2 * DAY).toISOString() });
    assert.equal((await get(s.lessonUrl(s.l1), cookies)).status, 403);

    // tag access: the schedule starts when the tag was given
    await s.api.del(`${students}/${contact.id}`);
    await s.api.post(`/api/contacts/${contact.id}/tags`, { name: 'client' });
    assert.equal((await get(s.lessonUrl(s.l2), cookies)).status, 403);
    await db.updateTable('contact_tags').set({ created_at: new Date(Date.now() - 7 * DAY - 60_000).toISOString() }).where('contact_id', '=', contact.id).execute();
    assert.equal((await get(s.lessonUrl(s.l2), cookies)).status, 200);
  });
});

describe('progress', () => {
  test('lesson completed, percentage, course completed once, timeline and automation', async () => {
    const s = await setup();
    const graduate = (await s.api.post('/api/tags', { name: 'diplômé' })).body;
    const auto = (
      await s.api.post('/api/automations', {
        name: 'Fin de formation',
        enabled: true,
        trigger: { type: 'course_completed', course_id: s.course.id },
        actions: [{ type: 'add_tag', tag_id: graduate.id }],
      })
    ).body;
    const { contact, cookies } = await member(s, 'eleve@mail.fr');
    await db.updateTable('contact_tags').set({ created_at: new Date(Date.now() - 30 * DAY).toISOString() }).where('contact_id', '=', contact.id).execute();

    const r1 = await post(`${s.lessonUrl(s.l1)}/complete`, cookies, { done: '1' });
    assert.equal(r1.status, 303);
    assert.equal(r1.headers.get('location'), s.lessonUrl(s.l2), 'goes on to the next lesson');
    await post(`${s.lessonUrl(s.l1)}/complete`, cookies, { done: '1' }); // idempotent
    const l1 = await get(s.lessonUrl(s.l1), cookies);
    assert.match(l1.text, /Leçon terminée/);
    assert.match((await get(s.home, cookies)).text, /33 % — 1 \/ 3 leçons/);
    assert.match((await get(s.courseUrl, cookies)).text, /Continuer/);
    const events = async () => (await s.api.get(`/api/contacts/${contact.id}`)).body.events as { type: string; data: Record<string, unknown> }[];
    let ev = await events();
    assert.equal(ev.filter((e) => e.type === 'lesson_completed').length, 1);
    assert.deepEqual(ev.find((e) => e.type === 'lesson_completed')!.data, { course: 'Méthode Piano', course_id: s.course.id, lesson: 'L1', lesson_id: s.l1.id });

    // undo / redo
    assert.equal((await post(`${s.lessonUrl(s.l1)}/complete`, cookies, { done: '0' })).headers.get('location'), s.lessonUrl(s.l1));
    assert.match((await get(s.home, cookies)).text, /0 % — 0 \/ 3 leçons/);
    await post(`${s.lessonUrl(s.l1)}/complete`, cookies, { done: '1' });

    await post(`${s.lessonUrl(s.l2)}/complete`, cookies, { done: '1' });
    assert.equal((await db.selectFrom('course_completions').selectAll().where('contact_id', '=', contact.id).execute()).length, 0);
    const last = await post(`${s.lessonUrl(s.l3)}/complete`, cookies, { done: '1' });
    assert.equal(last.headers.get('location'), `${s.lessonUrl(s.l3)}?termine=1`);
    assert.match((await get(`${s.lessonUrl(s.l3)}?termine=1`, cookies)).text, /Bravo, vous avez terminé cette formation/);
    assert.match((await get(s.home, cookies)).text, /Terminée/);
    assert.match((await get(s.courseUrl, cookies)).text, /Formation terminée/);

    // completing again later (undo + redo) does not complete the course twice
    await post(`${s.lessonUrl(s.l3)}/complete`, cookies, { done: '0' });
    await post(`${s.lessonUrl(s.l3)}/complete`, cookies, { done: '1' });
    ev = await events();
    assert.equal(ev.filter((e) => e.type === 'course_completed').length, 1);
    assert.deepEqual(ev.find((e) => e.type === 'course_completed')!.data, { course: 'Méthode Piano', course_id: s.course.id });
    const runs = await db.selectFrom('automation_runs').selectAll().where('automation_id', '=', auto.id).execute();
    assert.equal(runs.length, 1, 'automation "Formation terminée" queued once');
    assert.equal(runs[0].contact_id, contact.id);

    // admin: students with progress
    const st = (await s.api.get(`/api/courses/${s.course.id}/students`)).body[0];
    assert.deepEqual([st.completed_lessons, st.total_lessons, st.percent], [3, 3, 100]);
    assert.ok(st.completed_at && st.last_activity_at);

    // a new published lesson lowers the percentage; the course stays "completed once"
    await s.api.patch(`/api/lessons/${s.l4.id}`, { status: 'published' });
    assert.equal((await s.api.get(`/api/courses/${s.course.id}/students`)).body[0].percent, 75);
    assert.match((await get(s.home, cookies)).text, /75 % — 3 \/ 4 leçons/);
  });
});

describe('owner preview', () => {
  test('signed link: everything visible (drafts, drip), nothing tracked; bound to the account', async () => {
    const s = await setup();
    const other = await setup();
    const course = (await s.api.get(`/api/courses/${s.course.id}`)).body;
    assert.match(course.preview_url, new RegExp(`${s.courseUrl}\\?preview=`));
    const path = new URL(course.preview_url).pathname + new URL(course.preview_url).search;
    const token = new URL(course.preview_url).searchParams.get('preview')!;

    const enter = await get(path);
    assert.equal(enter.status, 302);
    assert.equal(enter.headers.get('location'), s.courseUrl, 'token removed from the URL');
    const cookies = { scalo_member_preview: enter.cookies.scalo_member_preview };
    assert.ok(cookies.scalo_member_preview);
    assert.match(enter.headers.getSetCookie().join('\n'), /HttpOnly/i);

    const lib = await get(s.home, cookies);
    assert.equal(lib.status, 200);
    assert.match(lib.text, /Aperçu propriétaire/);
    assert.match(lib.text, /Cours secret/, 'draft course listed');
    assert.equal((await get(`${s.home}/${s.draft.slug}`, cookies)).status, 200);
    const l2 = await get(s.lessonUrl(s.l2), cookies);
    assert.equal(l2.status, 200, 'drip ignored');
    assert.match(l2.text, /SECRET-L2/);
    const l4 = await get(s.lessonUrl(s.l4), cookies);
    assert.equal(l4.status, 200, 'draft lesson visible');
    assert.match(l4.text, /Brouillon/);
    assert.ok(!l4.text.includes('/complete'));
    assert.equal((await get(`${s.home}/files/${s.f2.id}`, cookies)).text, 'FILE-l2.pdf');
    assert.equal((await post(`${s.lessonUrl(s.l1)}/complete`, cookies, { done: '1' })).status, 303);
    assert.equal((await db.selectFrom('lesson_progress').selectAll().where('lesson_id', '=', s.l1.id).execute()).length, 0);

    // lesson preview link from the editor
    const lessonPreview = new URL((await s.api.get(`/api/lessons/${s.l4.id}`)).body.preview_url);
    assert.equal((await get(lessonPreview.pathname + lessonPreview.search)).headers.get('location'), s.lessonUrl(s.l4));

    // the token / cookie of one account is worthless on another members area, tampered tokens too
    const foreign = await get(`${other.home}?preview=${token}`);
    assert.equal(foreign.cookies.scalo_member_preview, undefined);
    assert.equal((await get(other.home, cookies)).status, 302);
    assert.equal((await get(`${other.home}/${other.draft.slug}`, cookies)).status, 404);
    const tampered = await get(`${s.home}?preview=${token.slice(0, -2)}xx`);
    assert.equal(tampered.cookies.scalo_member_preview, undefined);
    assert.equal((await get(`${s.home}?preview=1`)).cookies.scalo_member_preview, undefined);
    assert.equal((await get(s.home, { scalo_member_preview: `${token.slice(0, -2)}xx` })).status, 302);

    const exit = await post(`${s.home}/preview/exit`, cookies);
    assert.equal(exit.status, 303);
    assert.match(exit.headers.getSetCookie().join('\n'), /scalo_member_preview=;/);
  });
});

describe('isolation between accounts', () => {
  test('a member of A sees nothing of B (courses, lessons, files), even with the same email', async () => {
    const a = await setup();
    const b = await setup();
    const { cookies } = await member(a, 'eleve@mail.fr');
    await b.api.post('/api/contacts', { email: 'eleve@mail.fr', tags: ['client'] }); // same person, customer of B too

    // B's course / lesson / file ids under A's area
    assert.equal((await get(`${a.home}/${b.course.slug}/${b.l1.id}`, cookies)).status, 404);
    assert.equal((await get(`${a.home}/files/${b.f3.id}`, cookies)).status, 404, 'even a free-preview file of B');
    assert.equal((await get(`${a.home}/files/${b.f2.id}`, cookies)).status, 404);
    assert.equal((await post(`${a.home}/${b.course.slug}/${b.l1.id}/complete`, cookies, { done: '1' })).status, 404);

    // A's session on B's area: not logged in
    assert.equal((await get(b.home, cookies)).status, 302);
    assert.equal((await get(b.lessonUrl(b.l1), cookies)).status, 302);
    assert.match((await get(b.lessonUrl(b.l1), cookies)).headers.get('location') ?? '', /\/login\?next=/);
    assert.equal((await get(`${b.home}/files/${b.f2.id}`, cookies)).status, 302);

    // logging in on B gives access to B only
    const onB = await login(b, 'eleve@mail.fr');
    assert.equal((await get(b.lessonUrl(b.l1), onB)).status, 200);
    assert.equal((await get(a.home, onB)).status, 302);

    // admin API of A never returns B's data
    assert.equal((await a.api.get(`/api/courses/${b.course.id}/students`)).status, 404);
    assert.equal((await a.api.get(`/api/lessons/${b.l1.id}`)).status, 404);
  });
});
