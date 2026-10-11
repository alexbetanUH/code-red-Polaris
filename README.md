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

### Run it

Requirements: Python 3, [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp`), ffmpeg (`brew install ffmpeg`), Chrome.

```bash
python3 server.py
```

Open http://localhost:8000 in Chrome, click **Start camera**, then **Calibrate pinch**. Load a song by pasting a YouTube link or with **Upload file**.

### Files

- `index.html`: hand tracking, gesture smoothing, hand → audio mapping, drawing
- `audio.js`: audio engine (load, play/pause, speed, filter, volume, waveform)
- `server.py`: local server; serves the site and downloads YouTube audio via yt-dlp into `downloads/`

Tuning values (pinch range, smoothing, speed/filter ranges) are at the top of the script in `index.html`.

## AirDeck Mix (two decks): `mix.html`

Open http://localhost:8000/mix.html. Left hand = deck A, right hand = deck B. Both decks are beat-synced to deck A's tempo (detected automatically).

| Gesture | Does |
|---|---|
| Pinch + move hand up/down | Grab that deck's channel fader (volume) |
| Pinch + twist wrist | Filter knob: twist left = low-pass, right = high-pass, centre = off |
| Fist + slide left/right | Scratch (hand on the record; still fist = record stopped). Slip mode: on release the track jumps back in sync |
| Both open hands up high | Build-up: high-pass sweep, noise riser, accelerating snare roll |
| …then two fists | Drop on the next bar line |
| Both open hands held low (~1 s) | Pause / resume hand tracking (music keeps playing) |

No camera? Keys: Space play/pause, 1/2 toggle deck, B build, D drop, P pause tracking, H debug overlay. **Load demo tracks** renders two synth loops (124 and 128 BPM) so you can try it without downloading anything.

- `mix-worklet.js`: audio-thread engine (variable-rate/reverse playback, master beat clock, phase lock, slip mode, bar-aligned loops)
- `mix-audio.js`: graph, filters, faders, build/drop FX, tempo detection, demo loops
- `mix.html`: hand tracking, gestures, stage visuals. Tuning values are at the top of its script.
