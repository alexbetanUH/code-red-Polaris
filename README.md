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

If you see 404s or the wrong page, another `server.py` (e.g. a second copy of the repo) has the port: stop it, or run `python server.py 8001`.

Open http://localhost:8000 in Chrome (the landing page) and pick **AI DJ**, or go straight to http://localhost:8000/index.html. Click **Start camera**, then **Calibrate pinch**. Click **Queue** and pick
songs from the **Library** (▶ plays one now, + adds it, **Add all** queues them all), or let the AI DJ choose. Drag
songs to reorder them. The player bar (in the Song card and the queue) shows the song's progress (click or drag it to
jump), with ⏮ (restart, or previous song near the start), ⏯ and ⏭. Songs around the current one are decoded ahead,
so skipping back and forth is instant.

### Song library

`library.json` is the list of songs (YouTube video id, artist, title, BPM). They play from `music/<id>.m4a`, the same
folder the landing page uses. `music/` is gitignored, so fill it once on each machine:

```bash
python prefetch.py
```

To change the songs, edit `library.json` and run `prefetch.py` again.

**Beta:** at the bottom of the queue panel you can add any song from YouTube (a link or a song name) or a file.
YouTube downloads can take 10–30 seconds, with a progress bar.

### AI DJ

In the Queue panel, type a vibe (e.g. "chill into hype") and press **Start**. Gemini picks songs from the library that
fit the vibe and flow from what's playing: same or neighboring genre, close tempo, no repeats until every song has
played. With the DJ on, it mixes into the next song before the current one's ending fades out (it keeps two queued
ahead), and a DJ voice speaks up over the mix when the genre switches (and at the start of the set):

- **Blend** when the tempos are close: the next song comes in beat-matched on a downbeat, the two swap bass lines
  halfway, and the new song then eases back to its own tempo.
- **Echo out** when they're far apart (or a song's tempo can't be detected reliably): the current song echoes out and
  the next one fades in under the echoes.

Tempo and downbeats are detected from the audio (`analyzeTempo` in `mix-audio.js`) and checked against the library's
BPM. The browser console logs each mix.

**Short mixes** (on by default, a checkbox under the DJ) bring each song in where it first gets going (skipping a
quiet intro) and mix it out after about 20 s, in whole phrases, with shorter blends: a one-minute demo hears several
transitions. The camera view shows what's up next, when the DJ mixes into it and
how (blend or echo out). Hand gestures steer the DJ (the right hand is best: the left one also sets the speed):

| Gesture | Does |
|---|---|
| ✋ Sweep an open hand sideways | Mix into the next song now, on the next downbeat |
| 🤘 Hold horns for a moment | More energy: the DJ says so and re-picks the upcoming songs |
| ✌️ Hold a peace sign for a moment | Less energy | **Change vibe** swaps the upcoming picks, **Stop** goes back to normal
looping. You can still drag, remove or ▶ anything (those switch instantly).

It needs API keys, set as environment variables in the terminal before starting the server (they stay on your
machine and never reach the browser):

```bash
export GEMINI_API_KEY="..." ELEVENLABS_API_KEY="..."   # PowerShell: $env:GEMINI_API_KEY="..."; $env:ELEVENLABS_API_KEY="..."
python3 server.py
```

The server prints whether the DJ is on. Without an ElevenLabs key the browser's built-in voice is used. Optional:
`GEMINI_MODEL` (default `gemini-3.5-flash-lite`, 500 free requests a day) and `ELEVENLABS_VOICE_ID`.
The landing page's **Talk to the AI DJ** opens `index.html#ai-dj`, which shows the queue with the DJ ready.

### Files

- `index.html`: hand tracking, gesture smoothing, hand → audio mapping, drawing
- `audio.js`: audio engine (load, play/pause, speed, filter, volume, waveform)
- `queue.js`: song queue and its panel (add from YouTube or files, reorder, remove, play, next, AI DJ)
- `transitions.js`: the AI DJ's mixes between songs (beat-matched blends, echo-outs)
- `djGestures.js`: the swipe / 🤘 / ✌️ gestures that steer the AI DJ
- `server.py`: local server; serves the site, downloads YouTube audio via yt-dlp into `downloads/`, and runs the AI DJ (Gemini picks, ElevenLabs voice)
- `library.json`, `prefetch.py`: the song library and a script that fills `music/` with it

Tuning values (pinch range, smoothing, speed/filter ranges) are at the top of the script in `index.html`.

## AirDeck Mix (two decks): `mix.html`

Open http://localhost:8000/mix.html. Each deck has an on-screen **volume fader** and **filter knob** (deck A on the left, deck B on the right). Both decks are beat-synced to deck A's tempo (detected automatically).

The point between your thumb and index finger is your cursor. Either hand can use any control.

| Gesture | Does |
|---|---|
| Move your cursor onto a fader or knob | It lights up gold |
| Pinch, then move up/down | Fader: volume |
| Pinch, then circle around the knob | Filter: clockwise = high-pass (thin), counter-clockwise = low-pass (muffled), centre = off |
| Open your fingers | Let go (the control keeps its value) |
| Both open hands held low (~1 s) | Pause / resume hand tracking (music keeps playing) |

If grabbing feels unreliable, click **Calibrate pinch** once (it's saved). No camera? Keys: Space play/pause, 1/2 toggle deck, P pause tracking, H debug overlay. **Load demo tracks** renders two synth loops (124 and 128 BPM) so you can try it without downloading anything.

- `mix-worklet.js`: audio-thread engine (variable-rate playback, master beat clock, phase lock, bar-aligned loops; also supports scratching, currently unused)
- `mix-audio.js`: graph, filters, faders, tempo detection, demo loops
- `mix.html`: hand tracking, on-screen controls, stage visuals. Tuning values are at the top of its script.
