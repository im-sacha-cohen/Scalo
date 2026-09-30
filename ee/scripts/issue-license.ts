/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// License issuing CLI (used by Scalo, not by customers). No database, no network.
//
//   npx tsx ee/scripts/issue-license.ts keygen --out ~/.scalo/license-private-key.pem
//   npx tsx ee/scripts/issue-license.ts issue --private-key ~/.scalo/license-private-key.pem \
//        --customer "Agence Dupont" --plan enterprise --seats 10 --days 365 [--features team,audit_log,white_label]
//   npx tsx ee/scripts/issue-license.ts verify <key> --public-key <base64url>
//
// The private key must NEVER be committed: keep it outside the repository (password manager / KMS).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTERPRISE_FEATURES, type LicensePayload } from '../shared/types';
import { exportPublicKey, generateKeyPair, signLicense, validity, verifyLicense } from '../api/src/license/format';
import { PRODUCTION_PUBLIC_KEYS } from '../api/src/license/keys';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      flags[k] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    } else rest.push(a);
  }
  return { flags, rest };
}

const expand = (p: string) => path.resolve(p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function fail(msg: string): never {
  console.error(`Erreur : ${msg}`);
  process.exit(1);
}

const USAGE = `Usage :
  issue-license.ts keygen --out <fichier.pem>
  issue-license.ts issue --private-key <fichier.pem> --customer <nom> [--plan enterprise] [--seats 5]
                         (--days 365 | --expires 2027-12-31) [--features ${ENTERPRISE_FEATURES.join(',')}] [--id lic_…]
  issue-license.ts verify <clé> [--public-key <base64url>]`;

const { flags, rest } = parseArgs(process.argv.slice(2));
const [command, ...args] = rest;

if (command === 'keygen') {
  const out = expand(flags.out ?? fail('--out <fichier.pem> est requis (hors du dépôt)'));
  if (!path.relative(repoRoot, out).startsWith('..')) fail('la clé privée ne doit pas être écrite dans le dépôt : choisissez un chemin extérieur (ex. ~/.scalo/license-private-key.pem)');
  if (fs.existsSync(out)) fail(`${out} existe déjà (une nouvelle clé invaliderait les licences émises)`);
  const pair = generateKeyPair();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, pair.privateKeyPem, { mode: 0o600 });
  console.log(`Clé privée écrite dans ${out} (à conserver hors du dépôt, jamais partagée).`);
  console.log('\nClé publique — à coller dans PRODUCTION_PUBLIC_KEYS (ee/api/src/license/keys.ts),');
  console.log('ou dans SCALO_LICENSE_PUBLIC_KEY pour un essai hors production :\n');
  console.log(pair.publicKey);
} else if (command === 'issue') {
  const keyFile = expand(flags['private-key'] ?? fail('--private-key <fichier.pem> est requis'));
  if (!fs.existsSync(keyFile)) fail(`clé privée introuvable : ${keyFile}`);
  const customer = flags.customer && flags.customer !== 'true' ? flags.customer : fail('--customer <nom> est requis');
  const seats = Number(flags.seats ?? 5);
  if (!Number.isSafeInteger(seats) || seats < 1) fail('--seats doit être un entier ≥ 1');
  const features = (flags.features ?? ENTERPRISE_FEATURES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = features.filter((f) => !(ENTERPRISE_FEATURES as readonly string[]).includes(f));
  if (unknown.length) fail(`fonction(s) inconnue(s) : ${unknown.join(', ')} (connues : ${ENTERPRISE_FEATURES.join(', ')})`);
  let expires: Date;
  if (flags.expires) {
    expires = new Date(/^\d{4}-\d{2}-\d{2}$/.test(flags.expires) ? `${flags.expires}T23:59:59Z` : flags.expires);
  } else if (flags.days) {
    expires = new Date(Date.now() + Number(flags.days) * 86_400_000);
  } else fail('--days <n> ou --expires <date ISO> est requis');
  if (!Number.isFinite(expires.getTime())) fail('date d’expiration invalide');
  const payload: LicensePayload = {
    v: 1,
    id: flags.id ?? `lic_${crypto.randomBytes(8).toString('hex')}`,
    customer,
    plan: flags.plan ?? 'enterprise',
    features,
    seats,
    issued_at: new Date().toISOString(),
    expires_at: expires.toISOString(),
  };
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, 'utf8'));
  const key = signLicense(payload, privateKey);
  const publicKey = exportPublicKey(crypto.createPublicKey(privateKey));
  console.error(JSON.stringify(payload, null, 2));
  if (!PRODUCTION_PUBLIC_KEYS.includes(publicKey)) {
    console.error(`\nAttention : la clé publique correspondante (${publicKey}) n’est pas dans PRODUCTION_PUBLIC_KEYS — cette licence ne sera pas acceptée en production.`);
  }
  console.error('\nClé de licence (SCALO_LICENSE_KEY, ou Paramètres → Licence) :\n');
  console.log(key);
} else if (command === 'verify') {
  const key = args[0] ?? fail('clé de licence manquante');
  const keys = flags['public-key'] ? [flags['public-key']] : PRODUCTION_PUBLIC_KEYS;
  const r = verifyLicense(key, keys);
  if (!r.ok) fail(r.error);
  const v = validity(r.payload);
  console.log(JSON.stringify({ ...r.payload, status: v.status, days_left: v.daysLeft, grace_until: v.graceUntil }, null, 2));
} else {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}
