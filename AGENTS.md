# AirDeck agent guide

## Workflow

- Inspect Git status/diffs before editing this shared checkout; preserve unrelated work.
- Use the user's current instructions to determine scope. Prefer focused changes and verify the result.
- Current working branch is `merge-main`. Only publish to `main` when the user explicitly asks; preserve `virtual-effects` as fallback.
- Commit/push or create a PR when the user asks. Exclude the personal untracked `HANDOFF.md` from every commit.
- Give short, plain progress updates and describe actual verification limits.

## Current application

- `index.html` is DJ Deck; `mix.html` redirects there. `/` serves `landing.html`.
- Arcade is now integrated at `arcade-versus.html` (two-player games); `ai-dj.html` is AirMix, its single-player rhythm game. Preserve both routes and the homepage links.
- DJ Deck Song, Queue, Library and Up next belong in the sidebar, outside camera pixels, including fullscreen. Mobile may stack them below the camera.
- Other controls/help are hidden behind a toggle. Preserve the site's Aero styling.
- Manual hand blends accept all tempos without beat alignment, speed matching or automatic bass cuts. Keep automatic AI DJ behavior distinct.
- Comfortable hand ranges: blend palm Y .90→.55, effect palm Y .85→.40, volume distance .04→.42 of canvas width. Keep controls clear of the top lock zone (.32).
- Bubble Aero includes particles escaping the polygon. Clear them when switching visual; keep emission bounded.
- Do not restore the colorful startup test pattern. Synthetic preview is explicit (L or fake hands).

## Files and verification

- `index.html`: camera, gesture logic, canvas HUD, fullscreen/sidebar integration.
- `audio.js`: DJ Deck audio engine; `aiDeck.js`: AirMix's engine copy.
- `queue.js`: shared queue, playback requests, embedded/floating panels, announcements.
- `transitions.js`: manual level blends and automatic tempo/echo transitions.
- `frame.js`: polygon WebGL visuals; `bubble-particles.js`: screen-space particles.
- `djGame.js` / `djStart.js`: AirMix gameplay, set selection, onboarding and results.
- `arcade-versus.html`: two-player Arcade games.
- `server.py`: local serving/downloads, Gemini picks, ElevenLabs speech; loads a gitignored `.env` at startup.
- `FEATURES_PLAN.md` is historical, not the current product specification.

Run relevant regression suites: `node tests/tracking.cjs`, `node tests/effects.cjs`, `node tests/queue-default.cjs`, `node tests/queue-selection.cjs`, `node tests/hand-blend.cjs`, `node tests/bubble-particles.cjs`, `node tests/queue-airmix.cjs`, `python3 tests/server-static.py`; run `git diff --check`. Browser checks matter for rendering and fullscreen. Stub tests do not replace real webcam/listening validation.

AirMix may select uncached library songs; they download on Play. Loading failures must show retry/new-set controls. The server must never serve dotfiles (including `.env` and `.git`) or directory listings.

Run `python3 server.py 8001` after checking for an existing listener. Keys are server environment variables (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`); never reveal or commit secrets. Do not claim APIs are active just because integration exists. Check runtime configuration/logs.
