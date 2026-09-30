// Image uploads for the page & email builders.
// Files live in api/uploads/<userId>/<random>.<ext> and are served publicly at /uploads/<userId>/<file>.
// Only raster images (png, jpeg, gif, webp) are accepted, detected by their magic bytes (never SVG).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router, type Request, type Response } from 'express';
import { HttpError, uid } from '../util';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads');
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_USER = 500;

const FILE_RE = /^[a-f0-9]{24}\.(png|jpg|gif|webp)$/;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface UploadItem { name: string; url: string; size: number; created_at: string }

/** Detects the image type from the first bytes. Returns the extension or null. */
export function sniffImage(buf: Buffer): 'png' | 'jpg' | 'gif' | 'webp' | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const userDir = (userId: number) => path.join(UPLOAD_DIR, String(userId));
const publicUrl = (userId: number, name: string) => `/uploads/${userId}/${name}`;

function listFiles(userId: number): UploadItem[] {
  const dir = userDir(userId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => FILE_RE.test(n))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, url: publicUrl(userId, name), size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export const uploadsRouter = Router();

uploadsRouter.get('/uploads', (req, res) => {
  res.json(listFiles(uid(req)));
});

uploadsRouter.post(
  '/uploads',
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    const userId = uid(req);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length === 0) throw new HttpError(400, 'Fichier vide ou manquant');
    const ext = sniffImage(buf);
    if (!ext) throw new HttpError(415, 'Format non pris en charge : PNG, JPEG, GIF ou WebP uniquement');
    const dir = userDir(userId);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).length >= MAX_FILES_PER_USER) throw new HttpError(409, `Limite de ${MAX_FILES_PER_USER} images atteinte : supprimez des images inutilisées`);
    const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buf, { flag: 'wx' });
    const item: UploadItem = { name, url: publicUrl(userId, name), size: buf.length, created_at: new Date().toISOString() };
    res.status(201).json(item);
  },
);

uploadsRouter.delete('/uploads/:name', (req, res) => {
  const userId = uid(req);
  const name = String(req.params.name);
  if (!FILE_RE.test(name)) throw new HttpError(404, 'Image introuvable');
  const file = path.join(userDir(userId), name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Image introuvable');
  fs.unlinkSync(file);
  res.json({ ok: true });
});

/** Public, unauthenticated file serving (used by public pages and emails). */
export function serveUpload(req: Request, res: Response) {
  const userId = String(req.params.userId);
  const name = String(req.params.file);
  const m = FILE_RE.exec(name);
  if (!/^\d{1,12}$/.test(userId) || !m) return res.status(404).type('text').send('Introuvable');
  const file = path.join(UPLOAD_DIR, userId, name);
  if (!fs.existsSync(file)) return res.status(404).type('text').send('Introuvable');
  res.set({
    'Content-Type': MIME[m[1]!]!,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(res);
}
