# AirDeck: gesture modes plan

Historical plan retained for context. It contains superseded designs (including song slots and header controls). Do not use it as the current implementation checklist; see README.md and AGENTS.md for current behavior, and the local untracked HANDOFF.md for session context.

## Phase 0: Basic controls switch and modes framework

- Add a header button **"Basic controls: on/off"**, remembered in localStorage
  (`airdeck-basic`). When off, speed, filter and volume stop following the hands
  and stay at their last values.
- Add a mode state: `normal`, `song-select` (right hand is a fist), `fx-select`
  (left hand is a fist).
  - A fist has to hold for about 300 ms to enter a mode. Releasing it leaves the mode.
  - While either mode is on, basic controls pause automatically. The selecting
    hand's pinch shouldn't move the filter or speed.
  - If both hands are fists, nothing happens. That avoids a fight between the modes.
- Count fingers with the existing `fingerExtended` and `thumbExtended`, from 1 to 5,
  thumb included.
  - **Selection rule:** the count must stay the same for about 500 ms before it
    triggers. Fingers go up one at a time, so without the wait, raising 3 fingers
    would pick slots 1 and 2 on the way.
- Show a mode banner on screen (e.g. "🎵 SONG SELECT", "🎛 FX SELECT") and a fill
  ring that shows the hold progress.
- **Keyboard test keys**, needed because the camera doesn't work in the preview pane:
  - `S`: enter song mode. `F`: enter FX mode. `Esc`: leave the mode.
  - `1`–`5`: pick that number.
  - `L`: show the L-frame at a fixed rectangle.
  - These keys also give a backup for the live demo.

## Phase 1: Effect selector (left fist → right hand picks)

Add an effects chain to `audio.js`. The graph becomes:
source → lowpass → **fx chain** → gain → analyser → out.
Each effect is a dry/wet pair, so turning it off sets the wet level to 0 and
never rebuilds the graph.

| Fingers | Effect | Web Audio implementation |
|---|---|---|
| 1 | Reverb | `ConvolverNode` with a generated noise-decay impulse (about 2.5 s) |
| 2 | Echo | `DelayNode` (3/8 s) plus a feedback gain of about 0.45 |
| 3 | Bitcrush / distortion | `WaveShaperNode` with a stepped curve |
| 4 | Flanger | short `DelayNode` (about 5 ms) modulated by an LFO |
| 5 (open hand) | **All effects off** | set all the wet levels to 0 |

- Picking an effect turns it on. Picking the same one again turns it off.
  Effects stack.
- While in FX mode, the right hand's pinch sets the **amount** (wet level) of the
  most recently picked effect. On leaving the mode, the amount stays.
- Side panel: one chip per effect, lit when on, with a small bar for the amount.
- On screen: a radial or row menu of 5 icons near the right hand. The count lights
  the matching icon.

## Phase 2: Song selector + transition (right fist → left hand picks)

- **5 song slots** in the side panel. Each is loaded from YouTube or by upload
  (reuse the existing loader). The slot number is the finger count.
  - Pre-load the files already in `downloads/` so the demo needs no network.
- **Two decks.** Create a second `Deck` and mix both through a crossfade gain
  pair into the shared filter, fx, gain and analyser. The current song plays on
  the active deck. The newly picked song loads into the idle deck.
- **Transition effect** when a slot is picked:
  - It starts at the next beat. Estimate BPM once per song on load, using onset
    autocorrelation on the decoded buffer. If that's unreliable, fall back to
    starting right away.
  - It runs about 8 beats, or 4 s without a BPM:
    - The outgoing deck gets a highpass sweep up and a rising echo tail, then fades.
    - The incoming deck fades in with a lowpass opening up.
    - Optional: match the incoming deck's `playbackRate` to the outgoing BPM
      while blending, then ease it back to 1.0.
  - **Mashup option:** if the user picks a song while a transition is already
    running, both decks hold at 50/50 (a mashup) until the next pick.
- On screen: the 5 song titles in an arc near the left hand, the picked one
  highlighted, and a progress bar for the transition.

## Phase 3: L-frame visual effects

- **L pose:** index finger and thumb extended, the other three curled, and the
  angle between thumb and index around 50°–130°.
  Add it to `classifyPose` as "🫷 L" or similar.
- **Both hands in an L:** draw a rectangle (a quad) that uses the two thumb–index
  corners as opposite corners. The camera-crew "framing" gesture.
  - It stretches and moves live with the hands.
  - It holds 250 ms after a hand is lost, then fades.
- **Rendering:** add a WebGL canvas layered over the video, with a fragment
  shader that samples the webcam texture **only inside the quad**. Effects:
  1. **8-bit:** pixelate plus a 16-color palette and scanlines.
  2. **Glitch distortion:** RGB channel split plus horizontal slice offsets.
  3. **Wave / liquid:** sine displacement driven by time.
  4. **Kaleidoscope:** mirrored segments around the quad's center.
- **Which effect:** the frame's effect follows the most recent audio effect
  (reverb → wave, echo → kaleidoscope, bitcrush → 8-bit, flanger → glitch,
  none → 8-bit). That ties sound and visuals together.
- **Audio-reactive:** the bass level from the analyser drives the effect strength,
  so it pulses on hits.
- Draw a bright outline with corner brackets on the frame, like a camera viewfinder.

## Not in scope right now

- Hosting/HTTPS, the remaining required step. Do it after these features or
  in parallel.
- Bipolar filter, crowd mode, loop layering.

## Done means

- Every phase works with the keyboard test keys in the preview pane, with no
  console errors.
- The old basic controls still work when switched on, and the easter eggs still work.
- The tuning knobs for the new features sit in the "Tuning knobs" block.
- `HANDOFF.md` is updated with the new gestures and knobs.

## Subagents (allowed)

The goal may spawn subagents. Rules so they don't collide:

- **Never let two agents edit the same file at once.** `index.html` is the shared
  file, so only the main agent edits it.
- Split the work into separate files that subagents can own:
  - **Agent A, `audio.js` / `fx.js`:** the effects chain (phase 1) and the
    two-deck crossfade + BPM detection + transition (phase 2). It exposes a small API
    (`setEffect(name, on)`, `setAmount(v)`, `loadSlot(i, url)`, `pickSlot(i)`) and
    doesn't touch `index.html`.
  - **Agent B, `frame.js`:** the WebGL overlay for phase 3. It exposes
    `renderFrame(videoEl, quadPoints, effectName, bass)` and draws on its own
    canvas. It doesn't touch `index.html`.
  - **Main agent:** phase 0 plus all the wiring in `index.html`
    (gesture detection, mode state, finger-count selection, keyboard keys, UI).
- Agents A and B can run **in parallel** once phase 0 has agreed the API names.
  Use a cheaper model (Sonnet) for them.
- The main agent verifies in the browser preview. Subagents only write code and
  run a quick syntax check (`node --check`) on their own file.
