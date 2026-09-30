// Illustrations of the kits: small inline SVGs drawn with the kit's tokens (no external image, no licence question).
// `hero` is a decorative visual; `portrait` is a clearly marked image slot (« Votre photo ») meant to be replaced.
import type { KitLayout, KitTokens } from './types';

export type ArtKind = 'hero' | 'portrait';

const uri = (svg: string) => 'data:image/svg+xml,' + encodeURIComponent(svg).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function shapes(style: KitLayout['art'], t: KitTokens, w: number, h: number): string {
  const r = (x: number, y: number, ww: number, hh: number, a: string) => `<rect x="${x}" y="${y}" width="${ww}" height="${hh}" ${a}/>`;
  const c = (x: number, y: number, rad: number, a: string) => `<circle cx="${x}" cy="${y}" r="${rad}" ${a}/>`;
  const cx = w / 2;
  switch (style) {
    case 'frames':
      return (
        r(0, 0, w, h, `fill="${t.alt}"`) +
        r(w * 0.16, h * 0.12, w * 0.5, h * 0.7, `fill="none" stroke="${t.accent2}" stroke-width="2"`) +
        r(w * 0.26, h * 0.2, w * 0.5, h * 0.7, `fill="${t.surface}" stroke="${t.border}"`) +
        c(w * 0.76, h * 0.24, h * 0.11, `fill="${t.accent}"`) +
        [0, 1, 2, 3].map((i) => r(w * 0.32, h * (0.36 + i * 0.09), w * (i === 3 ? 0.2 : 0.38), 6, `fill="${i ? t.border : t.accent2}"`)).join('')
      );
    case 'shapes':
      return (
        r(0, 0, w, h, `fill="${t.accent2}"`) +
        c(w * 0.34, h * 0.46, h * 0.3, `fill="${t.accent}" stroke="${t.text}" stroke-width="5"`) +
        `<path d="M${w * 0.58} ${h * 0.16}h${w * 0.3}v${h * 0.4}a${w * 0.3} ${h * 0.4} 0 0 1 -${w * 0.3} -${h * 0.4}z" fill="${t.surface}" stroke="${t.text}" stroke-width="5"/>` +
        r(w * 0.56, h * 0.62, w * 0.26, h * 0.22, `fill="${t.text}"`) +
        `<polyline points="${[0, 1, 2, 3, 4, 5, 6].map((i) => `${w * (0.08 + i * 0.06)},${h * (i % 2 ? 0.84 : 0.92)}`).join(' ')}" fill="none" stroke="${t.text}" stroke-width="5"/>` +
        c(w * 0.69, h * 0.73, h * 0.05, `fill="${t.accent2}"`)
      );
    case 'mock':
      return (
        r(0, 0, w, h, `fill="${t.alt}"`) +
        r(w * 0.08, h * 0.1, w * 0.84, h * 0.8, `rx="18" fill="${t.surface}" stroke="${t.border}" stroke-width="2"`) +
        [0, 1, 2].map((i) => c(w * 0.12 + i * 18, h * 0.16, 5, `fill="${t.border}"`)).join('') +
        r(w * 0.08, h * 0.22, w * 0.84, 2, `fill="${t.border}"`) +
        [0, 1, 2, 3].map((i) => r(w * 0.12, h * (0.3 + i * 0.08), w * 0.13, 10, `rx="5" fill="${i === 0 ? t.accent : t.border}"`)).join('') +
        [0, 1, 2].map((i) => r(w * (0.32 + i * 0.19), h * 0.29, w * 0.165, h * 0.15, `rx="10" fill="${t.alt}"`) + r(w * (0.34 + i * 0.19), h * 0.33, w * 0.07, 9, `rx="4" fill="${i === 1 ? t.accent2 : t.accent}"`)).join('') +
        [0.2, 0.34, 0.26, 0.4, 0.31, 0.46, 0.38].map((v, i) => r(w * (0.335 + i * 0.075), h * (0.82 - v), w * 0.045, h * v, `rx="5" fill="${i % 3 === 2 ? t.accent2 : t.accent}"`)).join('')
      );
    case 'figure':
      return (
        r(0, 0, w, h, `fill="${t.alt}"`) +
        r(w * 0.06, h * 0.08, w * 0.88, h * 0.84, `fill="none" stroke="${t.text}" stroke-width="1.5"`) +
        c(cx, h * 0.48, h * 0.26, `fill="none" stroke="${t.text}" stroke-width="1.5"`) +
        c(cx + h * 0.13, h * 0.4, h * 0.13, `fill="${t.accent}"`) +
        `<path d="M${w * 0.06} ${h * 0.92}L${w * 0.94} ${h * 0.08}" stroke="${t.text}" stroke-width="1"/>`
      );
    case 'blobs':
      return (
        r(0, 0, w, h, `fill="${t.alt}"`) +
        c(w * 0.4, h * 0.46, h * 0.34, `fill="${t.accent2}" opacity=".6"`) +
        c(w * 0.62, h * 0.56, h * 0.26, `fill="${t.accent}" opacity=".4"`) +
        c(w * 0.62, h * 0.26, h * 0.1, `fill="${t.surface}"`) +
        `<path d="M${w * 0.14} ${h * 0.84}Q${cx} ${h * 0.6} ${w * 0.86} ${h * 0.84}" fill="none" stroke="${t.text}" stroke-width="2" opacity=".5"/>`
      );
    case 'deco':
      return (
        r(0, 0, w, h, `fill="${t.surface}"`) +
        [0.12, 0.2, 0.28, 0.36].map((k) => c(cx, h * 0.52, h * k, `fill="none" stroke="${t.accent}" stroke-width="1.2" opacity="${1.1 - k * 2}"`)).join('') +
        `<path d="M${cx} ${h * 0.08}V${h * 0.92}M${w * 0.14} ${h * 0.52}H${w * 0.86}" stroke="${t.accent}" stroke-width="1" opacity=".45"/>` +
        `<path d="M${cx} ${h * 0.45}l${h * 0.07} ${h * 0.07}l-${h * 0.07} ${h * 0.07}l-${h * 0.07} -${h * 0.07}z" fill="${t.accent}"/>`
      );
    case 'arch':
      return (
        r(0, 0, w, h, `fill="${t.alt}"`) +
        `<path d="M${w * 0.27} ${h * 0.9}V${h * 0.42}a${w * 0.23} ${w * 0.23} 0 0 1 ${w * 0.46} 0V${h * 0.9}z" fill="${t.accent2}"/>` +
        c(cx, h * 0.46, h * 0.12, `fill="${t.accent}"`) +
        `<path d="M${w * 0.27} ${h * 0.76}q${w * 0.115} -${h * 0.1} ${w * 0.23} 0t${w * 0.23} 0V${h * 0.9}H${w * 0.27}z" fill="${t.text}" opacity=".85"/>` +
        r(w * 0.14, h * 0.9, w * 0.72, 3, `fill="${t.text}"`)
      );
    case 'rays':
      return (
        r(0, 0, w, h, `fill="${t.inverse}"`) +
        [-3, -2, -1, 0, 1, 2, 3].map((i) => `<path d="M${cx} ${h}L${cx + i * w * 0.2 - w * 0.06} 0h${w * 0.12}z" fill="${t.inverseAccent}" opacity="${i % 2 ? 0.1 : 0.22}"/>`).join('') +
        c(cx, h * 0.62, h * 0.2, `fill="${t.accent}"`) +
        c(cx, h * 0.62, h * 0.28, `fill="none" stroke="${t.inverseAccent}" stroke-width="3"`)
      );
  }
}

/** Data URI of an illustration of the kit. */
export function kitArt(style: KitLayout['art'], t: KitTokens, kind: ArtKind = 'hero'): string {
  const [w, h] = kind === 'portrait' ? [600, 600] : [800, 600];
  const label =
    kind === 'portrait'
      ? `<rect x="${w / 2 - 96}" y="${h - 84}" width="192" height="40" rx="${Math.min(20, t.radius)}" fill="${t.surface}" stroke="${t.border}"/>` +
        `<text x="${w / 2}" y="${h - 58}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="${t.text}">Votre photo</text>`
      : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${shapes(style, t, w, h)}${label}</svg>`;
  return uri(svg.replace(/(\d+\.\d)\d+/g, '$1'));
}
