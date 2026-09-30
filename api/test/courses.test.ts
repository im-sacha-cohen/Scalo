// Courses admin API: members area settings, courses / modules / lessons (CRUD + order), lesson files, students.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { db } from '../src/db';
import { storedFilePath } from '../src/services/courses';
import { client, http, registerUser, shutdown, startApp, type TestCtx } from './helpers';

let ctx: TestCtx;
before(async () => {
  ctx = await startApp();
});
after(() => shutdown(ctx));

let seq = 0;
async function account(name = `Académie ${++seq}`) {
  const reg = await registerUser(ctx, name);
  return { api: client(ctx, reg.token), userId: reg.user.id, token: reg.token };
}

const upload = (token: string, lessonId: number, name: string, body = '%PDF-1.4 contenu du fichier') =>
  http(ctx, 'POST', `/api/lessons/${lessonId}/files?name=${encodeURIComponent(name)}`, { token, body });

describe('members area settings', () => {
  test('created on first access from the account name, unique slug, editable', async () => {
    const a = await account('École Zoé');
    const b = await account('École Zoé');
    const areaA = (await a.api.get('/api/member-area')).body;
    const areaB = (await b.api.get('/api/member-area')).body;
    assert.equal(areaA.slug, 'ecole-zoe');
    assert.equal(areaB.slug, 'ecole-zoe-2');
    assert.equal(areaA.name, 'École Zoé');
    assert.match(areaA.url, /\/m\/ecole-zoe$/);
    assert.match(areaA.preview_url, /\/m\/ecole-zoe\?preview=/);

    const up = await a.api.put('/api/member-area', { name: 'Zoé Académie', slug: 'Zoe-Academie', color: '#ff6600', logo_url: 'https://cdn.exemple.fr/logo.png' });
    assert.equal(up.status, 200, up.text);
    assert.deepEqual([up.body.name, up.body.slug, up.body.color, up.body.logo_url], ['Zoé Académie', 'zoe-academie', '#ff6600', 'https://cdn.exemple.fr/logo.png']);
    assert.equal((await a.api.put('/api/member-area', { logo_url: '' })).body.logo_url, null);

    assert.equal((await b.api.put('/api/member-area', { slug: 'zoe-academie' })).status, 409, 'slug already used by another account');
    assert.equal((await b.api.put('/api/member-area', { slug: 'login' })).status, 400, 'reserved');
    assert.equal((await b.api.put('/api/member-area', { slug: 'pas valide !' })).status, 400);
    assert.equal((await b.api.put('/api/member-area', { color: 'red;background:url(x)' })).status, 400);
    assert.equal((await b.api.put('/api/member-area', { logo_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await http(ctx, 'GET', '/api/member-area')).status, 401);
  });
});

describe('courses, modules, lessons', () => {
  test('course CRUD, slugs, validation, isolation', async () => {
    const a = await account();
    const b = await account();
    const c1 = await a.api.post('/api/courses', { title: 'Méthode Piano' });
    assert.equal(c1.status, 201, c1.text);
    assert.equal(c1.body.slug, 'methode-piano');
    assert.equal(c1.body.status, 'draft');
    assert.equal(c1.body.modules.length, 1, 'a first module is created');
    const c2 = (await a.api.post('/api/courses', { title: 'Méthode Piano' })).body;
    assert.equal(c2.slug, 'methode-piano-2');
    assert.equal((await a.api.post('/api/courses', { title: 'Login' })).body.slug, 'login-2', 'reserved path segment avoided');
    assert.equal((await a.api.post('/api/courses', { title: '' })).status, 400);

    const tagA = (await a.api.post('/api/tags', { name: 'client' })).body;
    const tagB = (await b.api.post('/api/tags', { name: 'client' })).body;
    const up = await a.api.patch(`/api/courses/${c1.body.id}`, {
      title: 'Piano pour tous',
      description: 'Apprenez le piano.',
      image_url: '/uploads/1/abc.png',
      status: 'published',
      access_tag_id: tagA.id,
      access_days: 365,
      purchase_url: 'https://exemple.fr/acheter',
    });
    assert.equal(up.status, 200, up.text);
    assert.equal(up.body.title, 'Piano pour tous');
    assert.equal(up.body.slug, 'methode-piano', 'renaming does not change the address');
    assert.deepEqual([up.body.status, up.body.access_tag_id, up.body.access_days, up.body.purchase_url], ['published', tagA.id, 365, 'https://exemple.fr/acheter']);

    assert.equal((await a.api.patch(`/api/courses/${c1.body.id}`, { access_tag_id: tagB.id })).status, 404, 'tag of another account');
    assert.equal((await a.api.patch(`/api/courses/${c1.body.id}`, { purchase_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await a.api.patch(`/api/courses/${c1.body.id}`, { slug: 'files' })).status, 400, 'reserved');
    assert.equal((await a.api.patch(`/api/courses/${c1.body.id}`, { slug: 'methode-piano-2' })).status, 409);
    assert.equal((await a.api.patch(`/api/courses/${c1.body.id}`, { slug: 'piano' })).body.slug, 'piano');
    assert.equal((await a.api.patch(`/api/courses/${c1.body.id}`, { access_days: 0 })).status, 400);

    // isolation
    assert.equal((await b.api.get(`/api/courses/${c1.body.id}`)).status, 404);
    assert.equal((await b.api.patch(`/api/courses/${c1.body.id}`, { title: 'x' })).status, 404);
    assert.equal((await b.api.del(`/api/courses/${c1.body.id}`)).status, 404);
    assert.deepEqual((await b.api.get('/api/courses')).body, []);

    // order of the courses
    const list = (await a.api.get('/api/courses')).body;
    assert.deepEqual(list.map((c: any) => c.slug), ['piano', 'methode-piano-2', 'login-2']);
    const reordered = await a.api.post('/api/courses/reorder', { ids: [list[2].id, list[0].id, list[1].id] });
    assert.deepEqual(reordered.body.map((c: any) => c.slug), ['login-2', 'piano', 'methode-piano-2']);
    assert.equal((await a.api.post('/api/courses/reorder', { ids: [list[0].id] })).status, 400, 'partial list');

    assert.equal((await a.api.del(`/api/courses/${c2.id}`)).status, 200);
    assert.equal((await a.api.get(`/api/courses/${c2.id}`)).status, 404);
  });

  test('modules and lessons: create, rename, reorder, move, delete', async () => {
    const a = await account();
    const b = await account();
    const course = (await a.api.post('/api/courses', { title: 'Cours' })).body;
    const other = (await a.api.post('/api/courses', { title: 'Autre' })).body;
    const m1 = course.modules[0];
    let c = (await a.api.post(`/api/courses/${course.id}/modules`, { title: 'Avancé' })).body;
    c = (await a.api.post(`/api/courses/${course.id}/modules`, { title: 'Bonus' })).body;
    const [, m2, m3] = c.modules;
    assert.deepEqual(c.modules.map((m: any) => m.title), ['Module 1', 'Avancé', 'Bonus']);
    assert.equal((await a.api.patch(`/api/course-modules/${m1.id}`, { title: 'Bases' })).body.modules[0].title, 'Bases');
    assert.equal((await b.api.patch(`/api/course-modules/${m1.id}`, { title: 'x' })).status, 404);

    c = (await a.api.post(`/api/courses/${course.id}/modules/reorder`, { ids: [m3.id, m1.id, m2.id] })).body;
    assert.deepEqual(c.modules.map((m: any) => m.title), ['Bonus', 'Bases', 'Avancé']);
    assert.equal((await a.api.post(`/api/courses/${course.id}/modules/reorder`, { ids: [m1.id, m2.id] })).status, 400, 'missing module');
    assert.equal((await a.api.post(`/api/courses/${course.id}/modules/reorder`, { ids: [m1.id, m2.id, other.modules[0].id] })).status, 400, 'module of another course');

    const mk = async (moduleId: number, title: string) => (await a.api.post(`/api/course-modules/${moduleId}/lessons`, { title })).body;
    const la = await mk(m1.id, 'A');
    const lb = await mk(m1.id, 'B');
    const lc = await mk(m1.id, 'C');
    const ld = await mk(m2.id, 'D');
    assert.deepEqual([la.status, la.free_preview, la.drip_days, la.video_url], ['draft', false, 0, null]);
    assert.ok(la.content.blocks.length > 0 && la.preview_url.includes('?preview='));
    assert.equal((await b.api.post(`/api/course-modules/${m1.id}/lessons`, { title: 'x' })).status, 404);

    const titles = (course: any, moduleId: number) => course.modules.find((m: any) => m.id === moduleId).lessons.map((l: any) => l.title);
    c = (await a.api.post(`/api/course-modules/${m1.id}/lessons/reorder`, { ids: [lc.id, la.id, lb.id] })).body;
    assert.deepEqual(titles(c, m1.id), ['C', 'A', 'B']);
    // D moves from m2 into m1 (second position)
    c = (await a.api.post(`/api/course-modules/${m1.id}/lessons/reorder`, { ids: [lc.id, ld.id, la.id, lb.id] })).body;
    assert.deepEqual(titles(c, m1.id), ['C', 'D', 'A', 'B']);
    assert.deepEqual(titles(c, m2.id), []);
    assert.equal((await a.api.post(`/api/course-modules/${m1.id}/lessons/reorder`, { ids: [lc.id, ld.id] })).status, 400, 'lessons of the module missing');
    assert.equal((await a.api.post(`/api/course-modules/${m1.id}/lessons/reorder`, { ids: [lc.id, lc.id, ld.id, la.id, lb.id] })).status, 400, 'duplicate');
    const foreign = await (async () => (await a.api.post(`/api/course-modules/${other.modules[0].id}/lessons`, { title: 'Z' })).body)();
    assert.equal((await a.api.post(`/api/course-modules/${m1.id}/lessons/reorder`, { ids: [lc.id, ld.id, la.id, lb.id, foreign.id] })).status, 400, 'lesson of another course');

    // PATCH module_id: appended at the end of the target module; another course's module is refused
    const moved = await a.api.patch(`/api/lessons/${la.id}`, { module_id: m3.id });
    assert.equal(moved.body.module_id, m3.id);
    assert.equal((await a.api.patch(`/api/lessons/${la.id}`, { module_id: other.modules[0].id })).status, 400);
    c = (await a.api.get(`/api/courses/${course.id}`)).body;
    assert.deepEqual(titles(c, m1.id), ['C', 'D', 'B']);
    assert.deepEqual(titles(c, m3.id), ['A']);
    assert.equal(c.lessons_count, 4);

    // lesson settings
    const up = await a.api.patch(`/api/lessons/${lb.id}`, { title: 'B2', status: 'published', free_preview: true, drip_days: 7, video_url: 'https://youtu.be/dQw4w9WgXcQ' });
    assert.deepEqual([up.body.title, up.body.status, up.body.free_preview, up.body.drip_days, up.body.video_url], ['B2', 'published', true, 7, 'https://youtu.be/dQw4w9WgXcQ']);
    assert.equal((await a.api.patch(`/api/lessons/${lb.id}`, { video_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await a.api.patch(`/api/lessons/${lb.id}`, { drip_days: -1 })).status, 400);
    assert.equal((await a.api.patch(`/api/lessons/${lb.id}`, { video_url: '' })).body.video_url, null);
    assert.equal((await b.api.get(`/api/lessons/${lb.id}`)).status, 404);
    assert.equal((await b.api.patch(`/api/lessons/${lb.id}`, { title: 'x' })).status, 404);

    // deleting a module deletes its lessons
    c = (await a.api.del(`/api/course-modules/${m1.id}`)).body;
    assert.equal(c.lessons_count, 1);
    assert.equal((await a.api.get(`/api/lessons/${lc.id}`)).status, 404);
    assert.equal((await a.api.del(`/api/lessons/${la.id}`)).status, 200);
    assert.equal((await a.api.get(`/api/courses/${course.id}`)).body.lessons_count, 0);
  });

  test('lesson content: builder blocks kept, custom HTML / forms / head code removed', async () => {
    const a = await account();
    const course = (await a.api.post('/api/courses', { title: 'Cours' })).body;
    const lesson = (await a.api.post(`/api/course-modules/${course.modules[0].id}/lessons`, { title: 'L' })).body;
    const r = await a.api.patch(`/api/lessons/${lesson.id}`, {
      content: {
        settings: { accent: '#ff0000', headCode: '<script>alert(1)</script>' },
        blocks: [
          { id: 'a', type: 'heading', text: 'Titre', level: 2 },
          { id: 'b', type: 'html', html: '<script>alert(1)</script>' },
          { id: 'c', type: 'section', children: [{ id: 'd', type: 'form', fields: [], submitLabel: 'x' }, { id: 'e', type: 'text', text: 'ok' }] },
          { id: 'f', type: 'columns', columns: [{ id: 'g', width: 100, children: [{ id: 'h', type: 'html', html: 'x' }, { id: 'i', type: 'video', url: 'https://vimeo.com/123' }] }] },
        ],
      },
    });
    assert.equal(r.status, 200, r.text);
    const { content } = r.body;
    assert.equal(content.settings.headCode, undefined);
    assert.equal(content.settings.accent, '#ff0000');
    assert.deepEqual(content.blocks.map((b: any) => b.id), ['a', 'c', 'f']);
    assert.deepEqual(content.blocks[1].children.map((b: any) => b.id), ['e']);
    assert.deepEqual(content.blocks[2].columns[0].children.map((b: any) => b.id), ['i']);
    assert.equal((await a.api.patch(`/api/lessons/${lesson.id}`, { content: { blocks: 'nope' } })).status, 400);
  });
});

describe('lesson files', () => {
  test('upload, list, download (owner only), never public, removed with the lesson', async () => {
    const a = await account();
    const b = await account();
    const course = (await a.api.post('/api/courses', { title: 'Cours' })).body;
    const lesson = (await a.api.post(`/api/course-modules/${course.modules[0].id}/lessons`, { title: 'L' })).body;

    const up = await upload(a.token, lesson.id, '../../Support de cours été.pdf');
    assert.equal(up.status, 201, up.text);
    assert.equal(up.body.name, 'Support de cours été.pdf', 'path removed from the name');
    assert.equal(up.body.size, 27);
    assert.equal((await upload(a.token, lesson.id, 'virus.exe')).status, 415);
    assert.equal((await upload(a.token, lesson.id, 'page.html')).status, 415);
    assert.equal((await upload(a.token, lesson.id, 'sansextension')).status, 415);
    assert.equal((await upload(a.token, lesson.id, 'vide.pdf', '')).status, 400);
    assert.equal((await upload(b.token, lesson.id, 'a.pdf')).status, 404, 'lesson of another account');
    assert.equal((await http(ctx, 'POST', `/api/lessons/${lesson.id}/files?name=a.pdf`, { body: 'x' })).status, 401);

    const full = (await a.api.get(`/api/lessons/${lesson.id}`)).body;
    assert.deepEqual(full.files.map((f: any) => f.name), ['Support de cours été.pdf']);
    assert.equal((await a.api.get(`/api/courses/${course.id}`)).body.modules[0].lessons[0].files_count, 1);

    const dl = await a.api.get(`/api/lesson-files/${up.body.id}/download`);
    assert.equal(dl.status, 200);
    assert.equal(dl.text, '%PDF-1.4 contenu du fichier');
    assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; filename="Support de cours _t_.pdf"; filename\*=UTF-8''Support%20de%20cours%20%C3%A9t%C3%A9\.pdf$/);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await b.api.get(`/api/lesson-files/${up.body.id}/download`)).status, 404);
    assert.equal((await http(ctx, 'GET', `/api/lesson-files/${up.body.id}/download`)).status, 401);

    // not reachable through the public media library route
    const row = await db.selectFrom('course_files').selectAll().where('id', '=', up.body.id).executeTakeFirstOrThrow();
    const onDisk = storedFilePath(a.userId, row.stored);
    assert.ok(fs.existsSync(onDisk));
    for (const p of [`/uploads/${a.userId}/${row.stored}`, `/uploads/_courses/${a.userId}/${row.stored}`, `/uploads/_courses/${row.stored}`]) {
      assert.equal((await http(ctx, 'GET', p)).status, 404, p);
    }

    const second = await upload(a.token, lesson.id, 'notes.txt', 'bonjour');
    assert.equal((await b.api.del(`/api/lesson-files/${second.body.id}`)).status, 404);
    assert.equal((await a.api.del(`/api/lesson-files/${second.body.id}`)).status, 200);
    assert.equal((await a.api.get(`/api/lesson-files/${second.body.id}/download`)).status, 404);

    assert.equal((await a.api.del(`/api/courses/${course.id}`)).status, 200);
    assert.ok(!fs.existsSync(onDisk), 'file removed from the disk with the course');
  });
});

describe('students', () => {
  test('manual access (email / contact), dates, tag access, removal, timeline', async () => {
    const a = await account();
    const b = await account();
    const tag = (await a.api.post('/api/tags', { name: 'client' })).body;
    const course = (await a.api.post('/api/courses', { title: 'Cours' })).body;
    await a.api.patch(`/api/courses/${course.id}`, { access_tag_id: tag.id });
    const path = `/api/courses/${course.id}/students`;
    assert.deepEqual((await a.api.get(path)).body, []);

    // by email: unknown address → contact created
    const r1 = await a.api.post(path, { email: 'Nouvelle@Mail.fr' });
    assert.equal(r1.status, 201, r1.text);
    assert.equal(r1.body.length, 1);
    const s1 = r1.body[0];
    assert.equal(s1.contact.email, 'nouvelle@mail.fr');
    assert.deepEqual([s1.via, s1.active, s1.expires_at, s1.percent], [['manual'], true, null, 0]);
    const detail = (await a.api.get(`/api/contacts/${s1.contact.id}`)).body;
    const granted = detail.events.filter((e: any) => e.type === 'course_access_granted');
    assert.equal(granted.length, 1);
    assert.deepEqual([granted[0].data.course, granted[0].data.course_id, granted[0].data.via], ['Cours', course.id, 'manual']);

    // again: dates updated, no second event
    const accessAt = '2026-01-10T08:00:00.000Z';
    const r2 = await a.api.post(path, { contact_id: s1.contact.id, access_at: accessAt, expires_at: '2099-01-01T00:00:00.000Z' });
    assert.equal(r2.status, 200);
    assert.deepEqual([r2.body[0].access_at, r2.body[0].expires_at], [accessAt, '2099-01-01T00:00:00.000Z']);
    assert.equal((await a.api.get(`/api/contacts/${s1.contact.id}`)).body.events.filter((e: any) => e.type === 'course_access_granted').length, 1);

    // validation
    assert.equal((await a.api.post(path, {})).status, 400);
    assert.equal((await a.api.post(path, { email: 'a@b.fr', contact_id: s1.contact.id })).status, 400);
    assert.equal((await a.api.post(path, { email: 'pas-un-email' })).status, 400);
    assert.equal((await a.api.post(path, { contact_id: s1.contact.id, access_at: '2026-05-01T00:00:00Z', expires_at: '2026-04-01T00:00:00Z' })).status, 400);
    const foreign = (await b.api.post('/api/contacts', { email: 'autre@mail.fr' })).body;
    assert.equal((await a.api.post(path, { contact_id: foreign.id })).status, 404, 'contact of another account');
    assert.equal((await b.api.get(path)).status, 404);
    assert.equal((await b.api.post(path, { email: 'x@mail.fr' })).status, 404);

    // expired manual access
    const p1 = await a.api.patch(`${path}/${s1.contact.id}`, { expires_at: '2026-02-01T00:00:00.000Z' });
    assert.deepEqual([p1.body[0].active, p1.body[0].expires_at], [false, '2026-02-01T00:00:00.000Z']);
    assert.equal((await a.api.patch(`${path}/${s1.contact.id}`, { expires_at: null })).body[0].active, true);

    // access by tag
    const tagged = (await a.api.post('/api/contacts', { email: 'tag@mail.fr', tags: ['client'] })).body;
    let list = (await a.api.get(path)).body;
    const t = list.find((s: any) => s.contact.id === tagged.id);
    assert.deepEqual([t.via, t.active, t.manual], [['tag'], true, null]);
    assert.equal((await a.api.get(`/api/courses/${course.id}`)).body.students_count, 2);
    assert.equal((await a.api.patch(`${path}/${tagged.id}`, { expires_at: null })).status, 404, 'no manual access to edit');

    // both sources: removing the manual access keeps the tag access unless remove_tag=1
    await a.api.post(path, { contact_id: tagged.id });
    list = (await a.api.get(path)).body;
    assert.deepEqual(list.find((s: any) => s.contact.id === tagged.id).via.sort(), ['manual', 'tag']);
    const d1 = await a.api.del(`${path}/${tagged.id}`);
    assert.deepEqual(d1.body, { ok: true, still_has_access: true });
    const d2 = await a.api.del(`${path}/${tagged.id}?remove_tag=1`);
    assert.deepEqual(d2.body, { ok: true, still_has_access: false });
    assert.deepEqual((await a.api.get(`/api/contacts/${tagged.id}`)).body.tags, []);
    assert.deepEqual((await a.api.get(path)).body.map((s: any) => s.contact.id), [s1.contact.id]);
    assert.equal((await a.api.del(`${path}/${foreign.id}`)).status, 404);

    // deleting the contact removes its enrollment
    await a.api.del(`/api/contacts/${s1.contact.id}`);
    assert.deepEqual((await a.api.get(path)).body, []);
  });

  test('automation trigger "Formation terminée": validated against the account', async () => {
    const a = await account();
    const b = await account();
    const tag = (await a.api.post('/api/tags', { name: 'diplômé' })).body;
    const course = (await a.api.post('/api/courses', { title: 'Cours' })).body;
    const foreign = (await b.api.post('/api/courses', { title: 'Cours' })).body;
    const body = (course_id: number | null) => ({ name: 'Fin', trigger: { type: 'course_completed', course_id }, actions: [{ type: 'add_tag', tag_id: tag.id }] });
    assert.equal((await a.api.post('/api/automations', body(foreign.id))).status, 404);
    const ok = await a.api.post('/api/automations', body(course.id));
    assert.equal(ok.status, 201, ok.text);
    assert.deepEqual(ok.body.trigger, { type: 'course_completed', course_id: course.id });
    assert.equal((await a.api.post('/api/automations', body(null))).status, 201, 'any course');
  });
});
