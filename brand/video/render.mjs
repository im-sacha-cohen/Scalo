import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
const [,, mode, out, extra] = process.argv;   // mode: stills | video
const FPS = 30;
const W = Number(process.env.W) || 1920, H = Number(process.env.H) || 1080;   // frame size, e.g. W=1200 H=960 for hero/
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.error('CONSOLE', m.text()));
await page.goto('file://' + process.cwd() + '/scene.html' + (extra || ''));
await page.evaluate(() => window.ready);
if (mode === 'stills') {
  const times = out.split(',').map(Number);
  for (const t of times) { await page.evaluate((t) => window.render(t), t); await page.screenshot({ path: `still-${t}.png` }); }
} else {
  const dur = await page.evaluate(() => window.DURATION);
  const n = Math.round(dur * FPS);
  const ff = spawn('./ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log('frame', i, '/', n);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
}
await browser.close();
