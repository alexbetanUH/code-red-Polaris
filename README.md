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

More gestures, on the hand tracker page `index.html` (**DJ Deck** in the top bar; turn the basic controls off with the **Basic controls** button if you only want these):

| Gesture | Controls |
|---|---|
| Right fist in the **right-side zone** (above the visuals corner), then fingers on the left hand | Songs from the queue: **1** = next song, **2** = previous song, **3+** = nothing. It applies when the fist leaves the zone. An empty queue loads the default library and starts its first track for either Next or Previous. If the deck is idle or paused, the selected queued song starts immediately (Previous at the beginning starts the first song). With music playing and **Hand blend** on, "next" is beat-matched in on a downbeat and you mix it: **left hand height** = crossfade, **right hand up** = old song out faster; no left hand for 4 s and it finishes by itself. Songs whose tempos can't be matched echo out instead |
| Left fist in the **left-side zone**, then 1–4 fingers on the right hand (open hand = all off) | Toggle reverb / echo / bitcrush / flanger; raise/lower the right hand to set strength (85% down = subtle, 40% down = maximum, below the top lock zone). This also works after leaving effect selection; the last value holds in the lock zone |
| Right fist in the **bottom-right corner**, then 1–5 fingers on the left hand | Choose the visual effect: 1 Portal (swirling lens), 2 Color filter (neon palette), 3 Kaleidoscope, 4 Bubble Aero (floating glass bubbles), 5 all off |
| **Both hands visible, any pose** | A shape joins your two thumb tips and two index tips and shows the chosen visual only inside it; it stretches and moves with your fingers |
| A hand held in the **top zone** | Locks speed / filter / volume (the readouts show up there). Hold again for 2 s to unlock |

Songs come from the queue and the song library (**Queue** button; the up-next strip on the camera view shows what the AI DJ plays next).

Keyboard test keys (no camera needed): `S` song mode, `←→` blend, `Enter` finish blend, `F` effects mode, `V` visuals mode, `1`–`5` pick, `↑↓` effect amount, `L` frame, `K` lock, `Esc` leave a mode.

### Run it

Requirements: Python 3, [yt-dlp](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp` or `pip install -U "yt-dlp[default]"`), Chrome. ffmpeg is optional (one extra download fallback). On Windows, run `python server.py`.

```bash
python3 server.py
```

If you see 404s or the wrong page, another `server.py` (e.g. a second copy of the repo) has the port: stop it, or run `python server.py 8001`.

Open http://localhost:8000 in Chrome (the landing page) and pick **DJ Deck**. Click **Start camera**, then **Calibrate pinch**. Click **Queue** and pick
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
how (blend or echo out).

### AirMix

AirMix (`ai-dj.html`, on hold: not linked from the home page yet) is a single-player rhythm game in the style of
osu!: you play a DJ set with your hands. It opens on **Pick your set**: tick 2–5 songs from the library in the
order you want them (each pair shows whether it'll be a blend or a cut, and the last set is remembered). Then, the
first time, how to play in three pictures, the camera and a check that it sees both hands; the set loads while
you do that, then 3, 2, 1.

Each shape is four dots, two per hand: where your thumb (hollow) and index fingertip (filled) go. A ring closes in on
each dot, landing on the beat about 2 seconds after it shows up. One comes every beat or two, each joined to the next.
The targets are the DJ controls, and they're worked out from your pinch calibration and how big your hand is right
now: put your fingertips on the dots, with the gap between them, and you really get that sound. The right pinch is
the filter (open = filter off; it narrows through a build-up and snaps open on the drop), the distance between your
hands is the volume (wider on drops), and the speed stays at 1.00× while you play. A shape counts when both hands are
on their dots and the right pinch is about as open as asked. The mixes into each next song of your set are part of
the chart:

- **Blends** (tempos close): your right thumb and index slide the new song in along a track (how far along you are is
  its volume), then your left ones slide the old song out: it thins out (its high-pass sweeps up) as it goes, and its
  last beat is thrown into an echo. If you don't follow, the music moves along anyway.
- **Cuts** (tempos far apart): one shape on the downbeat; the new song slams in and the old one is thrown into an echo.

Shapes hit within about 160 ms of the beat are Perfect, within 320 ms Good, and you hear them: each hit claps on its
beat. Slides have a tick on every beat: each one your fingers are on
clicks and keeps the combo going, and the slide is graded on how many held. Your combo shows in the corner; the
Your set card shows the set (played, playing, to come), the crowd's hype and your accuracy. With nobody in frame
nothing counts as a miss. The last song fades out where it would have been mixed out, and the results come up
(grade, score, accuracy, best combo, Perfect / Good / Miss) with **Play again** and **New set**.

**Pause** with **Space**, **P** or **Esc** (or the Pause button in the Song card): the music and the game stop
together, even mid-mix, and a quick 3-2-1 brings them back. **R** (or Restart) plays the set again from the top.
Switching tabs pauses too. Targets stay in the middle of the camera view (about 18–82% across, 28–68% down), where
the hand tracking is steady.

The AI doesn't pick anything in AirMix; it only talks: with an ElevenLabs key, a DJ voice opens the set, calls out
genre switches and your result. Without a key it stays quiet.

It needs API keys. The easy way: copy `.env.example` to `.env` and put your keys in it; `server.py` reads it every
time it starts (`.env` is gitignored, so the keys never get pushed). Or set them in the terminal before starting the
server, which only lasts for that window (either way they stay on your machine and never reach the browser):

```bash
export GEMINI_API_KEY="..." ELEVENLABS_API_KEY="..."   # PowerShell: $env:GEMINI_API_KEY="..."; $env:ELEVENLABS_API_KEY="..."
python3 server.py
```

If Gemini can't be reached (no key, no internet, rate limit, overload), the DJ keeps going with the closest
library songs by genre and tempo, and says so. The server prints whether Gemini is on. Without an ElevenLabs key the browser's built-in voice is used. Optional:
`GEMINI_MODEL` (default `gemini-3.5-flash-lite`, 500 free requests a day) and `ELEVENLABS_VOICE_ID`.
The server only answers this computer, so nobody on the venue Wi-Fi can spend your API credits (set
`AIRDECK_HOST=0.0.0.0` to open it up), and only AirDeck's own pages may call its API.
`index.html` is the plain hand tracker, with the same queue as its music source.

### Files

- `index.html`: the hand tracker: hand tracking, gesture smoothing, hand → audio mapping, drawing, and the gesture
  modes (fist zones for effects and visuals; lock zone; easter eggs)
- `audio.js`: its audio engine (load, play/pause, speed, filter, volume, waveform, effects)
- `frame.js`: WebGL visual inside the shape between both hands' thumb and index tips
- `ai-dj.html`, `aiDeck.js`: AirMix, with the same hand tracking and a frozen copy of `audio.js`, so changes to
  `index.html` or `audio.js` can't break it
- `queue.js`: song queue and its panel (add from YouTube or files, reorder, remove, play, next, AI DJ, AirMix sets)
- `transitions.js`: the AI DJ's mixes between songs (beat-matched blends, echo-outs)
- `djGame.js`: AirMix's game: the chart, hits and their sounds, the playable mixes, the set's end, the Your set card
- `djStart.js`: AirMix's screens: pick your set, how to play, camera and hand check, loading, 3-2-1, results
- `server.py`: local server; serves the site, downloads YouTube audio via yt-dlp into `downloads/`, and runs the AI DJ (Gemini picks, ElevenLabs voice)
- `library.json`, `prefetch.py`: the song library and a script that fills `music/` with it
- `tests/tracking.cjs`: `node tests/tracking.cjs` runs the hand tracking / gesture mode tests
- `FEATURES_PLAN.md`: the plan the gesture modes were built from

Tuning values (pinch range, smoothing, speed/filter ranges) are at the top of the script in `index.html`.

## Archived two-deck implementation

`index.html` is now DJ Deck. `mix.html` redirects there; the former two-deck source remains in Git history. The notes below describe that former implementation.

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
