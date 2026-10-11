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
