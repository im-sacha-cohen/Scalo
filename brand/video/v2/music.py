# Calm 96 bpm bed for the 37 s Scalo film v2 (pads, soft keys, light drums) + event chimes. Pure numpy, no samples.
import numpy as np, wave
SR = 48000; DUR = 37.0; N = int(SR * DUR); BEAT = 0.625; BAR = 2.5
out = np.zeros((N, 2)); wet = np.zeros((N, 2))
rng = np.random.default_rng(3)
hz = lambda m: 440 * 2 ** ((m - 69) / 12)
T = lambda d: np.arange(int(d * SR)) / SR
def add(sig, start, gain=1.0, pan=0.0, bus=None):
    bus = out if bus is None else bus
    i = int(round(start * SR))
    if i >= N: return
    s = sig[: N - i] * gain
    bus[i:i + len(s), 0] += s * np.sqrt(0.5 * (1 - pan)); bus[i:i + len(s), 1] += s * np.sqrt(0.5 * (1 + pan))
def env(d, a, r):
    t = T(d); return np.minimum(1, t / a) * np.minimum(1, np.maximum(0, (d - t) / r))

def pad(m, d):
    t = T(d); f = hz(m); s = np.zeros_like(t)
    for det in (-0.004, 0, 0.004):
        s += np.sin(2 * np.pi * f * (1 + det) * t + rng.random() * 6.28) + 0.25 * np.sin(2 * np.pi * 2 * f * (1 + det) * t) + 0.08 * np.sin(2 * np.pi * 3 * f * t)
    return s / 3 * env(d, 0.7, 1.0)
def key(m, d=1.6):
    t = T(d); f = hz(m)
    return (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 6) + 0.12 * np.sin(2 * np.pi * 4 * f * t) * np.exp(-t * 14)) * np.exp(-t * 3.2) * np.minimum(1, t / 0.004)
def bass(m, d):
    t = T(d); return np.tanh(1.6 * np.sin(2 * np.pi * hz(m) * t)) * env(d, 0.01, 0.12)
def kick():
    t = T(0.35); f = 95 * np.exp(-t * 26) + 46
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
def shaker(d=0.06):
    x = rng.standard_normal(int(d * SR)); x[1:] -= 0.95 * x[:-1]; return x * np.exp(-T(d) * 60)
def swell(d):
    x = rng.standard_normal(int(d * SR)); y = np.zeros_like(x); a = 0.0
    cut = np.linspace(0.01, 0.25, len(x))
    for i in range(len(x)): a += cut[i] * (x[i] - a); y[i] = a
    return y * np.linspace(0, 1, len(x)) ** 2

# D major: Dadd9, Bm7, Gmaj7, Aadd4
PROG = [[50, 57, 64, 66], [47, 54, 57, 62], [55, 59, 62, 66], [57, 61, 64, 69]]
ROOT = [38, 35, 31, 33]
ARP = [0, 2, 1, 3, 2, 1, 3, 2]
for b in range(int(DUR / BAR) + 1):
    t0 = b * BAR; ch = PROG[b % 4] if t0 < 30 else PROG[0]
    for j, m in enumerate(ch): add(pad(m, BAR + 1.2), t0, 0.05 if t0 < 5 else 0.065, (j - 1.5) * 0.3)
    if t0 >= 30: continue
    if t0 >= 5.0:                                    # keys enter when Ana lands on the page
        hi = 24 if 27.5 <= t0 < 30 else 12
        for k in range(8): add(key(ch[ARP[k]] + hi), t0 + k * BEAT / 2, 0.10 if k % 2 == 0 else 0.07, 0.5 * (-1) ** k, wet)
    if t0 >= 10.0:                                   # bass from the sign-up
        add(bass(ROOT[b % 4] + 12, 1.1), t0, 0.22); add(bass(ROOT[b % 4] + 12, 0.5), t0 + 1.5 * BEAT, 0.16)
    if 15.0 <= t0 < 25.0 or 27.5 <= t0 < 30:          # light drums; they breathe out for the wide shot
        for k in range(4):
            if k % 2 == 0: add(kick(), t0 + k * BEAT, 0.5)
            add(shaker(), t0 + k * BEAT + BEAT / 2, 0.10, 0.3); add(shaker(0.03), t0 + k * BEAT, 0.05, -0.3)

# event chimes (same cues as scene.html)
def chime(notes, at, gap=0.09, g=0.16):
    for i, m in enumerate(notes): add(key(m, 1.2), at + i * gap, g, 0.2 * (-1) ** i, wet)
chime([86], 4.3, g=0.12)                 # click
chime([78, 85], 12.2)                    # signed up
chime([90], 12.8, g=0.10)                # tagged
for t in (15.2, 16.0, 16.8): chime([81], t, g=0.10); add(swell(0.25)[::-1] * 0.5, t - 0.05, 0.10)   # emails sent
chime([78, 85], 21.5)                    # call confirmed
chime([74, 78, 81, 86], 24.5, g=0.18)    # paid
add(swell(1.4), 28.2, 0.22)                 # a thousand more
chime([62, 69, 74, 78, 81], 31.3, 0.12, 0.2)   # logo

# space: feedback delay on the keys bus
d = int(0.3125 * SR)
for k in range(1, 5): wet[k * d:] += (0.42 ** k) * wet[: N - k * d][:, ::-1]
out += wet
fl = int(3.0 * SR); out[-fl:] *= np.linspace(1, 0, fl)[:, None] ** 1.5
out[: int(0.5 * SR)] *= np.linspace(0, 1, int(0.5 * SR))[:, None]
out = np.tanh(out * 1.2); out /= np.abs(out).max() * 1.05
w = wave.open('music.wav', 'wb'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes((out * 32767).astype('<i2').tobytes()); w.close()
print('ok')
