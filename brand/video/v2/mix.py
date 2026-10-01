# Places each spoken line on the timeline (same start times as LINES in scene.html), ducks the music under it, writes mix.wav.
import subprocess
DUR = 37
# (start in film, take, trim from, trim to)
SEGS = [
    (1.2, 1, 0.11, 1.097), (3.0, 2, 0.197, 1.956), (5.6, 3, 0.53, 2.07), (7.6, 3, 3.035, 5.51),
    (10.9, 4, 0.85, 2.13), (12.7, 4, 2.95, 3.97), (14.7, 5, 0.34, 3.665), (18.9, 6, 0.43, 1.81),
    (20.5, 6, 3.565, 5.04), (22.9, 7, 0.124, 0.664), (23.9, 7, 1.484, 2.351), (25.8, 8, 0.617, 2.058),
    (28.2, 9, 0.905, 3.298),
]
TAKES = 9
parts = [f"[{k - 1}]atrim={a}:{b},asetpts=PTS-STARTPTS,afade=t=in:d=0.02,afade=t=out:st={b - a - 0.05:.3f}:d=0.05,adelay={int(s * 1000)}|{int(s * 1000)}[s{n}]" for n, (s, k, a, b) in enumerate(SEGS)]
voice = "".join(f"[s{n}]" for n in range(len(SEGS))) + f"amix=inputs={len(SEGS)}:normalize=0,aformat=sample_rates=48000:channel_layouts=stereo,highpass=f=80,acompressor=threshold=0.12:ratio=2.5:attack=8:release=120:makeup=1.6,apad=whole_dur={DUR},asplit=2[vo][sc]"
music = f"[{TAKES}]volume=0.5[mu];[mu][sc]sidechaincompress=threshold=0.05:ratio=3:attack=25:release=400[duck]"
final = f"[vo][duck]amix=inputs=2:normalize=0,loudnorm=I=-15:TP=-1.5:LRA=9,atrim=0:{DUR}[out]"
cmd = ["ffmpeg", "-v", "error", "-y"]
for k in range(1, TAKES + 1): cmd += ["-i", f"voice/l{k}.mp3"]
cmd += ["-i", "music.wav", "-filter_complex", ";".join(parts + [voice, music, final]), "-map", "[out]", "-ar", "48000", "mix.wav"]
subprocess.run(cmd, check=True)
print("mix.wav")
