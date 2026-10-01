# 120 bpm electro-pop bed for the 36 s Scalo film. Pure numpy, no samples.
# `python3 music.py sfx` writes sfx.wav: risers, impacts, whooshes and ticks only, to lay over a licensed track.
import numpy as np, wave, sys
SFX = 'sfx' in sys.argv
SR = 48000; DUR = 36.0; N = int(SR * DUR); BEAT = 0.5; BAR = 2.0
DROP, HIT = 10.0, 32.0
rng = np.random.default_rng(7)
out = np.zeros((N, 2))
def add(sig, start, gain=1.0, pan=0.0):
    i = int(round(start * SR));
    if i >= N or i + len(sig) <= 0: return
    s = sig * gain
    if i < 0: s = s[-i:]; i = 0
    j = min(N, i + len(s)); s = s[: j - i]
    out[i:j, 0] += s * np.sqrt(0.5 * (1 - pan)); out[i:j, 1] += s * np.sqrt(0.5 * (1 + pan))
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
T = lambda d: np.arange(int(d * SR)) / SR

def saw(f, d, fc, voices=5, spread=0.18):
    t = T(d); s = np.zeros_like(t)
    nh = int(min(40, 16000 / f))
    for v in range(voices):
        det = 1 + (v - (voices - 1) / 2) * spread / 100 * 2
        ph = rng.random() * 2 * np.pi
        for n in range(1, nh + 1):
            g = (1 / n) / np.sqrt(1 + (n * f / fc) ** 4)
            if g < 1e-3: break
            s += g * np.sin(2 * np.pi * n * f * det * t + ph * n)
    return s / voices
def env(d, a=0.005, r=0.05):
    t = T(d); return np.minimum(1, t / a) * np.minimum(1, np.maximum(0, (d - t) / r))
def kick(g=1.0):
    t = T(0.42); f = 150 * np.exp(-t * 32) + 48
    return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 7.5) + 0.4 * rng.standard_normal(len(t)) * np.exp(-t * 300)) * g
def noise(d): return rng.standard_normal(int(d * SR))
def hp(x, k=0.9):  # crude high-pass (difference)
    y = np.empty_like(x); y[0] = x[0]; y[1:] = x[1:] - k * x[:-1]; return y
def clap():
    t = T(0.25); n = hp(noise(0.25), 0.98)
    e = np.zeros_like(t)
    for o in (0, 0.011, 0.022): e += (t >= o) * np.exp(-np.maximum(0, t - o) * 60)
    return n * (e * 0.5 + 0.5 * np.exp(-t * 18)) * 0.6
def hat(open_=False):
    d = 0.22 if open_ else 0.05; t = T(d); return hp(noise(d), 0.99) * np.exp(-t * (18 if open_ else 90)) * 0.5
def boom():
    t = T(2.2); f = 70 * np.exp(-t * 2.5) + 30
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.6) + hp(noise(2.2), 0.7) * np.exp(-t * 3) * 0.35
def whoosh(d=0.45, up=True):
    t = T(d); x = noise(d); y = np.zeros_like(x); a = 0.0
    cut = np.linspace(0.02, 0.4, len(t)) if up else np.linspace(0.4, 0.02, len(t))
    for i in range(0, len(x)): a += cut[i] * (x[i] - a); y[i] = a
    return y * np.sin(np.pi * t / d) ** 2
def tick(f=2200):
    t = T(0.06); return np.sin(2 * np.pi * f * t * (1 + t * 8)) * np.exp(-t * 70) * 0.5

# chords (Ab major: Fm, Db, Ab, Eb)
PROG = [[53, 56, 60, 65], [49, 53, 56, 61], [56, 60, 63, 68], [51, 55, 58, 63]]
BASS = [41, 37, 44, 39]
def section(t):
    if t < 8: return 'intro'
    if t < DROP: return 'build'
    if t < 30: return 'drop'
    if t < HIT: return 'break'
    return 'outro'

step = BEAT / 4
for i in range(0 if SFX else int(DUR / step)):
    t0 = i * step; sec = section(t0); bar = int(t0 // BAR); ch = PROG[bar % 4]; b16 = i % 16
    # cutoff: muffled intro, sweep in build, open in drop
    fc = {'intro': 700, 'build': 700 + 5000 * ((t0 - 8) / 2) ** 2, 'drop': 5500, 'break': 1400, 'outro': 4000}[sec]
    # chord stabs: offbeat 8ths (pumping house feel)
    if b16 % 4 == 2 and sec != 'break':
        for m in ch: add(saw(hz(m + 12), 0.22, fc) * env(0.22, 0.004, 0.08), t0, 0.09 if sec in ('drop', 'outro') else 0.07, 0.25 * (1 if m % 2 else -1))
    # bass: 8ths, rolling
    if b16 % 2 == 0 and sec not in ('break',) and not (sec == 'build' and t0 > 9.0):
        add(saw(hz(BASS[bar % 4] + (12 if b16 % 4 == 2 else 0)), 0.2, 400 if sec == 'intro' else 900, voices=1) * env(0.2, 0.003, 0.05), t0, 0.32)
    # pluck arp 16ths in drop
    if sec in ('drop', 'outro') and t0 < 34:
        m = ch[[0, 1, 2, 3, 2, 1, 3, 2][b16 % 8]] + 24
        add(saw(hz(m), 0.14, 3500, voices=1) * np.exp(-T(0.14) * 22), t0, 0.05, 0.4 * np.sin(i))
    # drums
    if b16 % 4 == 0 and (sec in ('intro', 'drop', 'outro') or (sec == 'build' and t0 < 9.0)) and t0 < 34.5:
        add(kick(), t0, 0.55 if sec == 'intro' else 0.8)
    if sec in ('drop', 'outro') and b16 % 8 == 4 and t0 < 34.5: add(clap(), t0, 0.5)
    if t0 >= 2.0 and t0 < 34.5 and sec != 'break':
        if b16 % 4 == 2: add(hat(True), t0, 0.22 if sec != 'intro' else 0.14, 0.2)
        if sec in ('drop', 'outro') and b16 % 2 == 1: add(hat(), t0, 0.14, -0.3)
    # snare roll in build: 8ths then 16ths
    if sec == 'build' and ((t0 < 9 and b16 % 2 == 0) or t0 >= 9):
        add(clap(), t0, 0.15 + 0.35 * (t0 - 8) / 2)

# pads under break and outro tail
for (a, d, ch) in (() if SFX else ((30.0, 2.2, PROG[0]), (32.0, 4.0, PROG[2]))):
    for m in ch: add(saw(hz(m), d, 1800, voices=5, spread=0.3) * env(d, 0.3, 1.2), a, 0.07)
# riser + impacts + transitions
add(whoosh(2.0, True) * np.linspace(0, 1, int(2.0 * SR)), 8.0, 0.9)
add(whoosh(1.8, True) * np.linspace(0, 1, int(1.8 * SR)), 30.2, 0.6)
for h in (DROP, HIT): add(boom(), h, 0.9)
for c in (2.0, 3.0, 4.5, 11.5, 14.5, 20.0, 25.5, 27.25): add(whoosh(0.4, False), c - 0.12, 0.45)
for w in (0.45, 1.0, 2.0, 2.3, 3.0, 3.45, 4.5, 4.75, 5.0, 5.25, 5.5, 5.62, 5.74, 5.86, 6.2, 6.5, 6.95, 7.3, 7.75, 8.25,
          11.5, 12.1, 12.6, 13.5, 14.5, 15.0, 15.5, 20.85, 22.6, 22.85, 23.1, 23.95, 26.0, 26.25, 26.5, 28.9, 30.0, 30.9, 33.0, 33.5):
    add(tick(1800 + (hash(w) % 5) * 200), w, 0.35)

# sidechain pump on everything except kicks is approximated on the whole bus in the drop
t = np.arange(N) / SR
pump = np.ones(N)
m = ((t >= DROP) & (t < 30)) | ((t >= HIT) & (t < 34.5))
ph = (t % BEAT)
pump[m] = 1 - 0.35 * np.exp(-ph[m] / 0.09)
if not SFX: out *= pump[:, None]
# fades
out[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))[:, None]
fl = int(2.0 * SR); out[-fl:] *= np.linspace(1, 0, fl)[:, None] ** 1.5
out = np.tanh(out * 1.4) / np.tanh(1.4)
out /= np.abs(out).max() * 1.02
w = wave.open('sfx.wav' if SFX else 'music.wav', 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((out * 32767).astype('<i2').tobytes()); w.close()
print('ok')
