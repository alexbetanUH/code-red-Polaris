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

Requirements: Python 3, [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp` or `pip install -U "yt-dlp[default]"`), Chrome. ffmpeg is optional (one extra download fallback). On Windows, run `python server.py`.

```bash
python3 server.py
```

Open http://localhost:8000 in Chrome, click **Start camera**, then **Calibrate pinch**. Click **Queue** to add songs: paste a YouTube link, type a song name (downloads the top result), or pick a file. Downloads show a live progress bar. Drag songs to reorder them and ▶ plays one. The player bar (in the Song card and the queue) shows the song's progress (click or drag it to jump), with ⏮ (restart, or previous song near the start), ⏯ and ⏭. Songs around the current one are decoded ahead, so skipping back and forth is instant.

### AI DJ

In the Queue panel, type a vibe (e.g. "chill house into hype EDM") and press **Start**. Gemini picks songs that fit
the vibe and what's already playing, they download into the queue, and before each one a DJ voice introduces it.
With the DJ on, songs move on when they end (it keeps two queued ahead); **Change vibe** swaps the upcoming picks,
**Stop** goes back to normal looping. You can still drag, remove or ▶ anything.

It needs API keys, set as environment variables in the terminal before starting the server (they stay on your
machine and never reach the browser):

```bash
export GEMINI_API_KEY="..." ELEVENLABS_API_KEY="..."   # PowerShell: $env:GEMINI_API_KEY="..."; $env:ELEVENLABS_API_KEY="..."
python3 server.py
```

The server prints whether the DJ is on. Without an ElevenLabs key the browser's built-in voice is used. Optional:
`GEMINI_MODEL` (default `gemini-3.5-flash-lite`, 500 free requests a day) and `ELEVENLABS_VOICE_ID`.
The landing page's **Talk to the AI DJ** opens `index.html#ai-dj`, which shows the queue with the DJ ready.

### Demo set list

`setlist.txt` lists songs (one name or YouTube link per line). Before a demo, download them all once:

```bash
python prefetch.py
```

Then **Set list** in the queue panel adds them all in order, and they start instantly. It's also the backup if
the AI DJ or the internet misbehaves on stage.

### Files

- `index.html`: hand tracking, gesture smoothing, hand → audio mapping, drawing
- `audio.js`: audio engine (load, play/pause, speed, filter, volume, waveform)
- `queue.js`: song queue and its panel (add from YouTube or files, reorder, remove, play, next, AI DJ)
- `server.py`: local server; serves the site, downloads YouTube audio via yt-dlp into `downloads/`, and runs the AI DJ (Gemini picks, ElevenLabs voice)
- `setlist.txt`, `prefetch.py`: the demo set list and a script that downloads it ahead of time

Tuning values (pinch range, smoothing, speed/filter ranges) are at the top of the script in `index.html`.
