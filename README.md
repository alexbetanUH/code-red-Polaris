# code-red-Polaris
Hackathon repo for Code Red 2026 for team Polaris

## AirDeck

DJ with your hands in the browser, using your webcam (MediaPipe hand tracking + Web Audio).

| Gesture | Controls |
|---|---|
| Left hand pinch (thumb ↔ index) | Speed, 0.9× – 1.1× |
| Right hand pinch | Low-pass filter, 150 Hz – 10 kHz (fully open = off) |
| Distance between hands | Volume |

The line between your hands is the live audio waveform.

More gestures (turn the basic controls off with the **Basic controls** button if you only want these):

| Gesture | Controls |
|---|---|
| Right fist in the **right-side zone**, then 1–5 fingers on the left hand | Choose a song slot; it applies when the fist leaves the zone. If a song is already playing, the new one queues on the next beat and you blend with your hands: **left hand height** = crossfade, **right hand height** = filter sweep + echo on the old song |
| Left fist in the **left-side zone**, then 1–4 fingers on the right hand (open hand = all off) | Toggle reverb / echo / bitcrush / flanger; hand height sets the amount |
| Both hands as an **L** (thumb + index out) | A window between your hands with a video effect (8-bit, glitch, wave or kaleidoscope, following the latest audio effect) |
| A hand held in the **top zone** | Locks speed / filter / volume (the readouts show up there). Hold again for 2 s to unlock |

Keyboard test keys (no camera needed): `S` song mode, `F` effects mode, `1`–`5` pick, `←→` blend, `↑↓` amount / sweep, `L` frame, `K` lock, `Esc` leave a mode.

### Run it

Requirements: Python 3, [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp`), ffmpeg (`brew install ffmpeg`), Chrome.

```bash
python3 server.py
```

Open http://localhost:8000 in Chrome, click **Start camera**, then **Calibrate pinch**. Load a song by pasting a YouTube link or with **Upload file**.

### Files

- `index.html`: hand tracking, gesture smoothing, hand → audio mapping, drawing
- `audio.js`: audio engine (load, play/pause, speed, filter, volume, waveform, effects, 5 song slots, beat-synced and hand-driven transitions)
- `frame.js`: WebGL window effect for the L gesture
- `server.py`: local server (localhost only; set `AIRDECK_HOST=0.0.0.0` to open it to the network); serves the site and downloads YouTube audio via yt-dlp into `downloads/`
- `FEATURES_PLAN.md`: the plan the gesture modes were built from

Tuning values (pinch range, smoothing, speed/filter ranges) are at the top of the script in `index.html`.
