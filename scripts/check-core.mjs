#!/usr/bin/env node
// Proves that the AGPL core is independent from the Enterprise directory: copies the repository WITHOUT `ee/` to a
// temporary folder outside the repo, then typechecks the API and the web app there and runs the API test suite.
//
//   npm run check:core                      typecheck + tests (tests need TEST_DATABASE_URL)
//   npm run check:core -- --typecheck-only
//   npm run check:core -- --keep            keep the temporary copy (path printed)
//
// Nothing is deleted or modified in the working tree.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scalo-core-'));
const SKIP = new Set(['node_modules', 'dist', 'uploads', 'public', '.git', '.claude']);

function copy(src, dst) {
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) });
}

function run(label, cmd, cmdArgs, cwd, env = {}, shell = false) {
  console.log(`\n[check:core] ${label}`);
  const r = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ...env }, shell });
  if (r.status !== 0) {
    console.error(`[check:core] ÉCHEC : ${label}`);
    return false;
  }
  return true;
}

let ok = true;
try {
  // 1. the core, and only the core
  for (const dir of ['api', 'web', 'shared']) copy(path.join(root, dir), path.join(tmp, dir));
  for (const file of ['package.json', '.env']) if (fs.existsSync(path.join(root, file))) fs.copyFileSync(path.join(root, file), path.join(tmp, file));
  if (fs.existsSync(path.join(tmp, 'ee'))) throw new Error('ee/ ne doit pas être copié');

  // 2. node_modules: links to the installed packages, except the workspaces which must point to the copy
  const nm = path.join(tmp, 'node_modules');
  fs.mkdirSync(path.join(nm, '@scalo'), { recursive: true });
  for (const e of fs.readdirSync(path.join(root, 'node_modules'))) {
    if (e === '@scalo') continue;
    fs.symlinkSync(path.join(root, 'node_modules', e), path.join(nm, e));
  }
  for (const ws of ['api', 'web', 'shared']) fs.symlinkSync(path.join(tmp, ws), path.join(nm, '@scalo', ws));

  console.log(`[check:core] copie du cœur sans ee/ : ${tmp}`);
  const tsc = path.join(root, 'node_modules', '.bin', 'tsc');
  ok = run('typecheck api (sans ee/)', tsc, ['--noEmit', '-p', 'api'], tmp) && ok;
  ok = run('typecheck web (sans ee/)', tsc, ['--noEmit', '-p', 'web'], tmp) && ok;

  if (!args.has('--typecheck-only')) {
    if (!process.env.TEST_DATABASE_URL && !fs.existsSync(path.join(tmp, '.env'))) {
      console.log('\n[check:core] TEST_DATABASE_URL absent : tests ignorés (typecheck seul)');
    } else {
      ok = run('tests api (sans ee/)', 'node --import tsx --test --test-concurrency=1 --test-reporter=dot test/*.test.ts', [], path.join(tmp, 'api'), { NODE_ENV: 'test' }, true) && ok;
    }
  }
} finally {
  if (args.has('--keep')) console.log(`\n[check:core] copie conservée : ${tmp}`);
  else fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(ok ? '\n[check:core] OK — le cœur compile, passe ses tests et tourne sans ee/' : '\n[check:core] ÉCHEC');
process.exit(ok ? 0 : 1);
