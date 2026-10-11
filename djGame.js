// The AI DJ as a rhythm game played with your fingertips on the camera view.
//
// Each target is a shape of four dots: your left thumb and index fingertip (blue) and
// your right thumb and index fingertip (green). Shapes fly in about 2 seconds before
// their beat, shrinking onto their place; have your fingertips on the dots as they land.
// Those four fingertips are the DJ controls, so the chart is choreography:
//   - the right thumb–index gap is the filter: wide = open, narrowing through a build-up
//     closes it, and it snaps open on the drop;
//   - the distance between your hands is the volume: wider on drops, closer in quiet parts;
//   - the left gap is the speed, which stays at 1.00× while you play (it's held);
//   - where the shape sits moves with the music (sways, bobs, circles, steps), one shape
//     every beat or two, each joined to the next so you see where you're going.
// Hitting the shapes is how a good DJ would move right then; your hands really set the
// filter and volume, so missing them sounds like it.
//
// The mixes are part of the chart:
//   - Choose: the DJ's next songs come in as circles on the right with balloons saying
//     what each is and why. Your right index finger in one on its beat picks it;
//     otherwise the DJ's pick plays.
//   - Blend (tempos close): your right thumb and index slide the new song in along a
//     track, then your left ones slide the old song out. Not following? The AI does it.
//   - Cut (tempos far apart): one shape on the downbeat; the new song slams in and the
//     old one is thrown into an echo.
//
// Shapes hit within ~160 ms of the beat are Perfect (both hands), within ~320 ms Good
// (or one hand on time). Hits clap on their beat and every 10 in a row sounds the air
// horn. Slides have a tick on every beat: each one your fingers are on clicks and keeps
// the combo going. How well you play is the crowd's hype, which the DJ hears about when
// it picks the next songs. With nobody in frame, nothing counts as a miss.
//
// The page calls update() every camera frame with its hands (ai-dj.html's hand objects:
// thumb and index = the fingertips in camera-canvas pixels, pose).

const approachBeats = 3; // shapes show up this many beats early,
const approachMinMs = 1600; // but never less than this
const approachMaxMs = 2400; // or more than this
const perfectMs = 160;
const goodMs = 320;
const dotSize = 0.05; // a target dot's radius, as a share of the stage height
const reach = 0.1; // a fingertip within this share of the stage height of its dot counts
const followReach = 0.18; // fingertips within this of a slider's dots are following it
const gapBars = { short: 2, full: 4 }; // the new song's slide
const outBars = 2; // the old song's slide
const chooseBars = 4; // the choice lands this many bars before the mix (or as early as it can after the last one)
const idleMs = 2000; // no hands this long: shapes are skipped, not missed
const hypeWeight = 0.08; // how fast the crowd's hype follows your hits
const hornEvery = 10; // the air horn sounds every this many hits in a row
const approachMs = (beatMs) => Math.max(approachMinMs, Math.min(approachMaxMs, approachBeats * beatMs));

// The shape's choreography, in shares of the stage (gaps in shares of its height).
const shapeLook = {
  spread: { quiet: 0.42, normal: 0.52, loud: 0.58, drop: 0.68 }, // between the hands' pinch points
  openGap: 0.16, // the right thumb–index gap with the filter open
  closedGap: 0.05, // ... and closed, at the end of a build-up (the dots overlap: pinched)
  leftGap: 0.11, // the left gap (speed is held at 1.00× anyway)
  tilt: 0.35, // radians: index fingertips lean in toward each other
};
const choiceSpots = [[0.86, 0.24], [0.86, 0.45], [0.86, 0.66]];
const inPath = [[0.9, 0.24], [0.56, 0.6]]; // the right hand slides the new song in
const outPath = [[0.44, 0.5], [0.08, 0.5]]; // the left hand slides the old song out
const cutShape = { cx: 0.5, cy: 0.46, spread: shapeLook.spread.drop, rightGap: shapeLook.openGap };

const colors = { left: "#1e95e3", right: "#5cb82c", accent: "#f5861f", ink: "#1b1b1b", balloon: "#ffffe1" };
const gameFont = '"Trebuchet MS", "Segoe UI", sans-serif'; // Windows XP's title-bar face
const uiFont = 'Tahoma, "Segoe UI", sans-serif'; // and its interface face

const clamp01 = (value) => Math.max(0, Math.min(1, value));
// Small seeded random numbers, so a song's chart is the same every time it plays.
function seeded(text) {
  let seed = 2166136261;
  for (const char of text) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createDjGame(queue, { stage, camera, rail, deck, startEnabled = true }) {
  const canvas = document.createElement("canvas");
  canvas.className = "djGame";
  stage.append(canvas);
  const context = canvas.getContext("2d");
  const card = buildCard(queue, rail);

  let enabled = startEnabled;
  let wasActive = false;
  let lastFrame = 0;
  let lastHands = 0; // when a hand was last in frame
  let sounds = null;
  // Your fingertips, in stage pixels: { left: { thumb, index } | null, right: ... }.
  const tips = { left: null, right: null };

  // The chart: shapes by key, generated a little ahead of the music.
  const shapes = new Map();
  let chartSong = null;
  let charted = -1; // the last bar charted
  let random = Math.random;
  let pattern = null; // the current phrase's movement
  let step = 0; // shapes so far in this song (the movement's position)

  let mix = null; // the next mix: planned on the playing song, then performed in real time
  const score = { combo: 0, best: 0, hits: 0, judged: 0, points: 0, hype: 0.5 };
  const effects = [];

  // ---- geometry -------------------------------------------------------------------

  const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
  const point = ([x, y]) => ({ x: x * size().width, y: y * size().height });
  const dot = () => size().height * dotSize;
  function toStage(p) {
    const { width, height } = size();
    const scale = Math.min(width / camera.width, height / camera.height);
    return { x: p.x * scale + (width - camera.width * scale) / 2, y: p.y * scale + (height - camera.height * scale) / 2 };
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const middle = (pair) => lerp(pair.thumb, pair.index, 0.5);
  function along(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy));
  }

  // A shape's four dots (stage shares) from where it sits, how far apart the hands are
  // and how open the right pinch is.
  function makeShape({ cx, cy, spread, rightGap }) {
    const aspect = size().height / size().width || 9 / 16;
    const pair = (side, gap) => {
      const inward = side === "left" ? 1 : -1;
      const x = cx - (inward * spread) / 2;
      // Index fingertip above the thumb, leaning in toward the other hand.
      const dx = inward * Math.sin(shapeLook.tilt) * (gap / 2) * aspect;
      const dy = Math.cos(shapeLook.tilt) * (gap / 2);
      return { thumb: [x - dx, cy + dy], index: [x + dx, cy - dy] };
    };
    return { left: pair("left", shapeLook.leftGap), right: pair("right", rightGap) };
  }
  // A pinch pair (thumb + index) placed at a point, open like the right hand normally is.
  function pairAt([x, y], side, gap = shapeLook.openGap) {
    const shape = makeShape({ cx: x + (side === "left" ? 0.25 : -0.25), cy: y, spread: 0.5, rightGap: gap });
    return shape[side];
  }

  // ---- scoring --------------------------------------------------------------------

  // when: the shape's beat (performance.now() ms), so its clap lands on it.
  function judge(target, verdict, when = performance.now(), at = null) {
    target.verdict = verdict;
    if (verdict === "skip") return;
    score.judged += 1;
    if (verdict === "miss") {
      score.combo = 0;
    } else {
      score.hits += 1;
      score.combo += 1;
      score.best = Math.max(score.best, score.combo);
      score.points += verdict === "perfect" ? 1 : 0.6;
      sounds ??= deck?.ctx ? createSounds(deck.ctx) : null;
      const delay = Math.max(0, (when - performance.now()) / 1000);
      sounds?.clap(delay, verdict === "perfect" ? 1 : 0.6);
      if (score.combo % hornEvery === 0) sounds?.horn(delay);
    }
    const value = verdict === "perfect" ? 1 : verdict === "good" ? 0.6 : 0;
    score.hype += (value - score.hype) * hypeWeight;
    queue.setCrowd(score.hype);
    effects.push({ text: verdict === "perfect" ? "Perfect" : verdict === "good" ? "Good" : "Miss", at: at ?? [0.5, 0.42], born: performance.now(), verdict });
  }

  // Which hands have both fingertips on their dots.
  function onDots(dots) {
    const hit = {};
    for (const side of ["left", "right"]) {
      const pair = dots[side];
      const hand = tips[side];
      hit[side] = Boolean(
        pair && hand && distance(hand.thumb, point(pair.thumb)) <= size().height * reach && distance(hand.index, point(pair.index)) <= size().height * reach,
      );
    }
    return hit;
  }

  // Watches one shape: the best moment each hand was on its dots around the beat.
  function track(target, when, now, present) {
    if (target.verdict) return;
    const offset = now - when;
    if (Math.abs(offset) <= goodMs) {
      const hit = onDots(target.dots);
      for (const side of ["left", "right"]) {
        if (target.dots[side] && hit[side]) target.best[side] = Math.min(target.best[side] ?? Infinity, Math.abs(offset));
      }
      const sides = ["left", "right"].filter((side) => target.dots[side]);
      if (sides.every((side) => target.best[side] <= perfectMs) && offset >= -perfectMs) judge(target, "perfect", when, target.center);
    }
    if (!target.verdict && offset > goodMs) {
      const sides = ["left", "right"].filter((side) => target.dots[side]);
      const landed = sides.filter((side) => target.best[side] !== undefined);
      if (landed.length === sides.length) judge(target, landed.every((side) => target.best[side] <= perfectMs) ? "perfect" : "good", when, target.center);
      else if (landed.length) judge(target, "good", when, target.center);
      else judge(target, present ? "miss" : "skip", when, target.center);
    }
  }

  // ---- the chart ------------------------------------------------------------------

  const patterns = ["sway", "bob", "circle", "step"];
  // Where the shape sits on a slot of a phrase's movement.
  function placement(name, slot) {
    switch (name) {
      case "sway":
        return [slot % 2 ? 0.56 : 0.44, 0.46];
      case "bob":
        return [0.5, slot % 2 ? 0.52 : 0.38];
      case "circle": {
        const angle = (slot / 4) * Math.PI * 2;
        return [0.5 + Math.cos(angle) * 0.07, 0.45 + Math.sin(angle) * 0.08];
      }
      default:
        return [[0.42, 0.5, 0.58, 0.5][slot % 4], 0.46];
    }
  }

  // Shapes for the bars coming up, from the beat grid and how loud the song gets.
  function chart(playback, beatsAhead) {
    if (chartSong !== playback.songId) {
      chartSong = playback.songId;
      charted = -1;
      random = seeded(String(playback.songId));
      shapes.clear();
      step = 0;
    }
    const grid = queue.beatGridAt(playback.position);
    if (!grid) return;
    const bar = 240 / grid.bpm;
    const beatSeconds = 60 / grid.bpm / playback.rate;
    const horizon = playback.position + (beatsAhead * bar) / 4;
    let k = Math.max(charted + 1, Math.floor((playback.position - grid.first) / bar));
    for (; grid.first + k * bar <= horizon; k += 1) {
      charted = k;
      const downbeat = grid.first + k * bar;
      if (downbeat < playback.position) continue;
      if (k % 4 === 0 || !pattern) pattern = patterns[Math.floor(random() * patterns.length)];
      const energy = queue.energyAt(downbeat + bar / 2);
      const before = queue.energyAt(downbeat - bar / 2);
      const ahead = queue.energyAt(downbeat + bar * 2.5);
      const drop = energy > 1 && energy > before * 1.3; // the bar where the energy jumps
      const quiet = energy < 0.6;
      const loud = energy > 1.15;
      // The two bars before a jump are a build-up: the filter closes over them.
      const buildUp = !drop && ahead > Math.max(1, energy * 1.3);
      const lastBarOfBuild = buildUp && queue.energyAt(downbeat + bar * 1.5) > Math.max(1, energy * 1.3);
      const beats = quiet ? [0] : loud && beatSeconds >= 0.42 ? [0, 1, 2, 3] : [0, 2];
      for (const beat of beats) {
        const time = downbeat + (beat * bar) / 4;
        if (quietAt(time)) continue; // the choice and the mix have their own targets
        // Every shape gets its whole approach (a new song's first ones too, after a mix).
        if (((time - playback.position) / playback.rate) * 1000 < approachMs(beatSeconds * 1000)) continue;
        let [cx, cy] = placement(pattern, step);
        step += 1;
        let spread = quiet ? shapeLook.spread.quiet : loud ? shapeLook.spread.loud : shapeLook.spread.normal;
        let rightGap = shapeLook.openGap;
        if (drop && beat === 0) spread = shapeLook.spread.drop;
        if (buildUp) {
          const progress = (lastBarOfBuild ? 0.5 : 0) + (beat + 1) / 8; // closes over the build
          rightGap = shapeLook.openGap - (shapeLook.openGap - shapeLook.closedGap) * clamp01(progress);
          cy -= 0.08 * clamp01(progress); // and the shape rises with it
        }
        const dots = makeShape({ cx, cy, spread, rightGap });
        // While the song choice is up, the right hand is picking: the left hand keeps playing.
        if (choosingAt(time)) delete dots.right;
        const key = `${playback.songId}:${k}:${beat}`;
        shapes.set(key, { key, song: playback.songId, time, dots, center: [cx, cy], best: {}, drop: drop && beat === 0 });
      }
    }
  }

  // ---- the mix --------------------------------------------------------------------

  // Song times kept clear of shapes: from the mix on.
  function quietAt(time) {
    return Boolean(mix) && time >= mix.cue - mix.bar / 2;
  }
  // Song times the choice is up (its balloons fill the right side).
  function choosingAt(time) {
    return Boolean(mix) && mix.chooseAt !== null && time >= mix.chooseAt - 2 * mix.bar && time <= mix.chooseAt + mix.bar / 2;
  }

  // Plans the next mix on the playing song (song seconds), or drops a stale plan.
  function planMix(playback) {
    if (mix && mix.song !== playback.songId && mix.state === "planned") mix = null;
    if (mix) return;
    const mixOut = queue.mixOutAt();
    if (mixOut === null) return;
    if (mixOut - playback.position < 2) {
      queue.mixNow(); // too late to play this one: the AI mixes it
      return;
    }
    const grid = queue.beatGridAt(mixOut);
    const bar = 240 / grid.bpm;
    const short = queue.getState().dj.short;
    const gap = short ? gapBars.short : gapBars.full;
    const onBar = (time) => grid.first + Math.round((time - grid.first) / bar) * bar;
    const barAfter = (time) => grid.first + Math.ceil((time - grid.first) / bar) * bar;
    const cue = onBar(mixOut - (gap + outBars) * bar);
    // The choice: ideally chooseBars before the mix, at least 2 bars from now (time to
    // read the balloons), and at least 2 bars before the mix (time to load the song).
    // (3 bars, so the chosen song is loaded well before its first targets show up.)
    const earliest = barAfter(playback.position + 2 * bar);
    const chooseAt = earliest <= cue - 3 * bar ? Math.max(earliest, cue - chooseBars * bar) : null;
    mix = {
      song: playback.songId,
      state: "planned", // → starting → blend | cut → landing → done
      bar,
      gap,
      cue,
      chooseAt, // null: no time to choose, the DJ's pick plays
      // When the mix is set up (it then waits for the cue): once the choice is made.
      startAt: chooseAt !== null ? Math.min(chooseAt + bar / 2, cue - bar / 2) : Math.max(playback.position, cue - 2 * bar),
      choices: null,
      // Blend or cut, from the songs' tempos in the library: known right away (before the
      // chosen song has loaded), so the mix's targets can show up on time; the mix obeys it.
      style: styleOf(queue.getUpNext()?.item),
    };
  }

  function styleOf(item) {
    const choice = item && queue.getChoices().find((option) => option.item.id === item.id);
    return choice?.blends === false ? "cut" : "blend";
  }

  function offerChoices() {
    const choices = queue.getChoices();
    if (choices.length < 2) return;
    mix.choices = choices.map((choice, index) => ({ spot: choiceSpots[index], choice }));
  }

  function startMix() {
    mix.state = "starting";
    const planned = mix;
    planned.style = styleOf(queue.getUpNext()?.item);
    queue.startHandMix({ startAt: planned.cue, style: planned.style }).then((controls) => {
      if (mix !== planned) return;
      if (!controls) {
        mix = null; // the AI mixed it after all (or there was nothing to mix)
        return;
      }
      const now = performance.now();
      const comesIn = now + controls.startsIn * 1000;
      const bar = controls.barSeconds * 1000;
      Object.assign(planned, {
        state: controls.style,
        controls,
        comesIn,
        swapAt: comesIn + planned.gap * bar,
        endAt: comesIn + (planned.gap + outBars) * bar,
        barMs: bar,
        inTicks: { passed: 0, held: 0, judged: false },
        outTicks: { passed: 0, held: 0, judged: false },
      });
      if (controls.style === "cut") {
        // The new song slams in on the downbeat and the old one gets thrown into an echo.
        controls.setIncoming(1);
        controls.echoOut();
        planned.heads = [{ dots: makeShape(cutShape), real: comesIn, best: {}, center: [cutShape.cx, cutShape.cy] }];
      } else {
        planned.heads = [
          { dots: { right: pairAt(inPath[0], "right") }, real: comesIn, best: {}, center: inPath[0] },
          { dots: { left: pairAt(outPath[0], "left") }, real: planned.swapAt, best: {}, center: outPath[0] },
        ];
      }
    });
  }

  // While a blend runs: each slide's dots move on the beat; following fingertips set the level.
  function performBlend(now) {
    const { controls } = mix;
    if (controls.done) return finishMix();
    const slide = (path, from, to, side) => {
      const ideal = clamp01((now - from) / (to - from));
      const hand = tips[side];
      const a = point(path[0]);
      const b = point(path[1]);
      const pinch = hand && middle(hand);
      const following = pinch && now >= from && distance(pinch, lerp(a, b, ideal)) <= size().height * followReach;
      return { ideal, level: following ? along(pinch, a, b) : ideal, following };
    };
    mix.in = slide(inPath, mix.comesIn, mix.swapAt, "right");
    controls.setIncoming(now < mix.swapAt ? mix.in.level : 1);
    ticks(mix.inTicks, mix.comesIn, mix.swapAt, mix.in.following, inPath[1], now);
    if (now >= mix.swapAt) {
      controls.swapBass();
      mix.out = slide(outPath, mix.swapAt, mix.endAt, "left");
      controls.setOutgoing(1 - mix.out.level);
      ticks(mix.outTicks, mix.swapAt, mix.endAt, mix.out.following, outPath[1], now);
      if (now >= mix.endAt) {
        controls.finish(mix.barMs / 2000);
        mix.state = "landing";
      }
    }
  }

  // A slide's ticks, one per beat: each one your fingers are on clicks and keeps the
  // combo going, a missed one breaks it. When the slide ends it's graded on how many held.
  function ticks(state, from, to, following, end, now) {
    const beat = mix.barMs / 4;
    const total = Math.round((to - from) / beat);
    const due = Math.min(total, Math.floor((now - from) / beat));
    const present = now - lastHands < idleMs;
    while (state.passed < due) {
      state.passed += 1;
      if (following) {
        state.held += 1;
        score.combo += 1;
        score.best = Math.max(score.best, score.combo);
        sounds ??= deck?.ctx ? createSounds(deck.ctx) : null;
        sounds?.tick();
      } else if (present) {
        score.combo = 0;
      }
    }
    if (!state.judged && now >= to) {
      state.judged = true;
      const share = total ? state.held / total : 0;
      const verdict = share >= 0.8 ? "perfect" : share >= 0.4 ? "good" : present ? "miss" : "skip";
      judge({}, verdict, now, end);
    }
  }

  function finishMix() {
    mix = null;
    shapes.clear();
    chartSong = null;
  }

  // ---- every camera frame ---------------------------------------------------------

  function update(input, now) {
    lastFrame = now;
    for (const side of ["left", "right"]) {
      const hand = input[side];
      tips[side] = hand?.thumb && hand?.index ? { thumb: toStage(hand.thumb), index: toStage(hand.index) } : null;
    }
    if (tips.left || tips.right) lastHands = now;
    const present = now - lastHands < idleMs;
    const active = enabled && queue.getState().dj.on;
    const mixing = Boolean(mix?.controls);
    // Speed holds at 1.00× while you play; the volume holds while you're mixing (your hands
    // move for the slides); the filter is always yours.
    queue.holdControls({ speed: active, volume: active && mixing });
    if (active && !wasActive) queue.resetSound();
    wasActive = active;
    if (!active) return;
    queue.coachPing(); // the game decides when to mix, not the DJ's timer

    const playback = queue.getPlayback();
    if (!playback.playing) return;
    const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;

    if (mix?.state === "landing") {
      if (mix.controls.done) finishMix();
    } else if (mix?.state === "blend") {
      performBlend(now);
    } else if (mix?.state === "cut" && mix.controls.done) {
      finishMix();
    }
    if (!mix) planMix(playback);
    if (mix?.state === "planned") {
      if (!mix.choices && mix.chooseAt !== null && playback.position >= mix.chooseAt - 2 * mix.bar) offerChoices();
      if (playback.position >= mix.startAt) startMix();
    }

    // Shapes of the song (not during a mix: those wait until it's landed).
    if (!mix || mix.state === "planned" || mix.state === "starting") chart(playback, 12);
    for (const shape of shapes.values()) if (shape.song === playback.songId) track(shape, realAt(shape.time), now, present);
    // The choice: the right index finger in one of the DJ's songs on its beat picks it.
    if (mix?.choices && !mix.chosen) {
      const when = realAt(mix.chooseAt);
      const finger = tips.right?.index;
      const picked =
        finger && Math.abs(now - when) <= goodMs ? mix.choices.find((choice) => distance(finger, point(choice.spot)) <= size().height * reach * 1.6) : null;
      if (picked) {
        queue.chooseNext(picked.choice.item.id);
        mix.chosen = picked;
        mix.style = styleOf(picked.choice.item);
        judge(picked, Math.abs(now - when) <= perfectMs ? "perfect" : "good", when, picked.spot);
      } else if (now - when > goodMs) {
        mix.chosen = mix.choices[0]; // the DJ's own pick stands
        mix.style = styleOf(mix.chosen.choice.item);
      }
    }
    // The mix's own shapes (where the slides start, the cut).
    if (mix?.heads) for (const head of mix.heads) track(head, head.real, now, present);
  }

  // ---- drawing --------------------------------------------------------------------

  // One target dot: translucent, rimmed in its hand's color, with a little Luna gloss.
  function targetDot(p, color, alpha, filled) {
    const r = dot();
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = filled ? color : "rgba(255, 255, 255, 0.6)";
    context.beginPath();
    context.arc(p.x, p.y, r, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = r * 0.32;
    context.strokeStyle = color;
    context.stroke();
    context.lineWidth = 1.5;
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.beginPath();
    context.arc(p.x, p.y, r * 0.84, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  // A shape: its outline (the four fingertips joined up), each hand's pinch gap, and the
  // dots, right where they'll be from the moment they show up. Thumbs are hollow, index
  // fingers filled. Each dot's ring closes in on it, landing on the beat.
  function drawShape(dots, when, now, beatMs, { emphasis = false } = {}) {
    const leadMs = approachMs(beatMs);
    if (when - now > leadMs || now - when > goodMs) return;
    const progress = clamp01(1 - (when - now) / leadMs);
    const alpha = clamp01(progress * 5);
    const corners = [dots.left?.thumb, dots.left?.index, dots.right?.index, dots.right?.thumb].filter(Boolean).map(point);
    if (corners.length === 4) {
      // The four fingertips joined up, faintly (a drop's shape is outlined in orange).
      context.save();
      context.globalAlpha = alpha * (emphasis ? 0.95 : 0.55);
      context.strokeStyle = emphasis ? colors.accent : "#ffffff";
      context.lineWidth = emphasis ? 3 : 1.5;
      context.setLineDash([6, 6]);
      context.beginPath();
      corners.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
      context.closePath();
      context.stroke();
      context.restore();
    }
    for (const side of ["left", "right"]) {
      const pair = dots[side];
      if (!pair) continue;
      const thumb = point(pair.thumb);
      const index = point(pair.index);
      context.save();
      context.globalAlpha = alpha;
      context.strokeStyle = colors[side];
      context.lineWidth = 3;
      context.beginPath();
      context.moveTo(thumb.x, thumb.y);
      context.lineTo(index.x, index.y);
      context.stroke();
      context.restore();
      targetDot(thumb, colors[side], alpha, false);
      targetDot(index, colors[side], alpha, true);
      if (now < when) {
        approachRing(thumb, colors[side], progress, alpha);
        approachRing(index, colors[side], progress, alpha);
      }
    }
  }

  // A dot's approach ring, in segments like the XP progress bar: it starts wide and
  // closes onto the dot exactly on the beat.
  function approachRing(p, color, progress, alpha) {
    const r = dot() * (1 + 2.2 * (1 - progress));
    const segments = 12;
    context.save();
    context.globalAlpha = alpha * (0.45 + 0.55 * progress);
    context.strokeStyle = color;
    context.lineWidth = Math.max(2, dot() * 0.16);
    for (let i = 0; i < segments; i += 1) {
      const start = (i / segments) * Math.PI * 2 - Math.PI / 2;
      context.beginPath();
      context.arc(p.x, p.y, r, start + 0.07, start + (Math.PI * 2) / segments - 0.07);
      context.stroke();
    }
    context.restore();
  }

  // Dotted trails from each hand's pinch on one shape to the same hand on the next.
  function followPoints(from, to, when, now, beatMs) {
    const leadMs = approachMs(beatMs);
    if (when - now > leadMs) return;
    context.save();
    context.globalAlpha = clamp01((1 - (when - now) / leadMs) * 4) * 0.75;
    for (const side of ["left", "right"]) {
      if (!from[side] || !to[side]) continue;
      const pinchPoint = (pair) => point([(pair.thumb[0] + pair.index[0]) / 2, (pair.thumb[1] + pair.index[1]) / 2]);
      const a = pinchPoint(from[side]);
      const b = pinchPoint(to[side]);
      const gap = distance(a, b);
      const clear = dot() * 2.2;
      if (gap < clear * 2) continue;
      context.fillStyle = colors[side];
      const dots = Math.floor((gap - clear * 2) / (dot() * 1.4));
      for (let i = 1; i < dots; i += 1) {
        const p = lerp(a, b, (clear + ((gap - clear * 2) * i) / dots) / gap);
        context.beginPath();
        context.arc(p.x, p.y, dot() * 0.22, 0, Math.PI * 2);
        context.fill();
      }
    }
    context.restore();
  }

  // A slide's track, with the pinch pair (thumb + index) that rides it on the beat.
  function slide(path, side, ball, following, alpha, tickCount = 0, ticksPassed = 0) {
    const a = point(path[0]);
    const b = point(path[1]);
    context.save();
    context.globalAlpha = alpha;
    context.lineCap = "round";
    context.lineWidth = size().height * 0.13;
    context.strokeStyle = "rgba(255, 255, 255, 0.22)";
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    context.restore();
    // The ticks still to come (one a beat), and the end: where the slide stops.
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = "#ffffff";
    context.strokeStyle = colors[side];
    context.lineWidth = 2;
    for (let i = Math.max(1, ticksPassed + 1); i < tickCount; i += 1) {
      const p = lerp(a, b, i / tickCount);
      context.beginPath();
      context.arc(p.x, p.y, dot() * 0.3, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
    context.restore();
    const endPair = pairAt([path[1][0], path[1][1]], side);
    for (const spot of [endPair.thumb, endPair.index]) {
      context.save();
      context.globalAlpha = alpha * 0.6;
      context.strokeStyle = colors[side];
      context.lineWidth = 2.5;
      context.setLineDash([5, 4]);
      context.beginPath();
      context.arc(point(spot).x, point(spot).y, dot(), 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
    if (ball === null) return;
    // The dots riding the slide, with the ring your fingers need to stay in: it lights up
    // while they're in it.
    const at = lerp(a, b, ball);
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = following ? colors[side] : "rgba(255, 255, 255, 0.85)";
    context.lineWidth = following ? 6 : 2;
    context.beginPath();
    context.arc(at.x, at.y, size().height * followReach * 0.8, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    const pair = pairAt([at.x / size().width, at.y / size().height], side);
    for (const [spot, filled] of [[pair.thumb, false], [pair.index, true]]) targetDot(point(spot), colors[side], alpha, filled);
  }

  // A choice circle and its XP notification balloon.
  function choiceCircle(p, progress, alpha) {
    const r = dot() * 2;
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = "rgba(255, 255, 255, 0.55)";
    context.strokeStyle = colors.accent;
    context.lineWidth = r * 0.2;
    context.beginPath();
    context.arc(p.x, p.y, r, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    if (progress < 1) {
      context.lineWidth = r * 0.1;
      context.beginPath();
      context.arc(p.x, p.y, r * (1 + 1.4 * (1 - progress)), 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }
  function balloon(p, title, detail, alpha) {
    const pad = 8;
    context.save();
    context.globalAlpha = alpha;
    context.font = `11px ${uiFont}`;
    const detailWidth = detail ? context.measureText(detail).width : 0;
    context.font = `bold 13px ${uiFont}`;
    const width = Math.min(Math.max(context.measureText(title).width, detailWidth) + pad * 2, size().width * 0.34);
    const height = detail ? 40 : 24;
    const right = p.x - dot() * 2.6;
    const x = right - width;
    const y = p.y - height / 2;
    context.fillStyle = colors.balloon;
    context.strokeStyle = colors.ink;
    context.lineWidth = 1;
    context.beginPath();
    context.roundRect(x, y, width, height, 6);
    context.moveTo(right, p.y - 6);
    context.lineTo(right + 9, p.y);
    context.lineTo(right, p.y + 6);
    context.fill();
    context.stroke();
    context.fillStyle = colors.balloon;
    context.fillRect(right - 1, p.y - 5, 2, 10);
    context.fillStyle = colors.ink;
    context.textBaseline = "middle";
    context.fillText(clip(title, width - pad * 2), x + pad, detail ? y + 13 : p.y);
    if (detail) {
      context.font = `11px ${uiFont}`;
      context.fillText(clip(detail, width - pad * 2), x + pad, y + 28);
    }
    context.restore();
  }
  function clip(text, width) {
    if (context.measureText(text).width <= width) return text;
    let cut = text;
    while (cut.length > 1 && context.measureText(`${cut}…`).width > width) cut = cut.slice(0, -1);
    return `${cut}…`;
  }

  function outlinedText(text, x, y, sizePx, color, alpha, align = "center") {
    context.save();
    context.globalAlpha = alpha;
    context.font = `italic bold ${sizePx}px ${gameFont}`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = Math.max(3, sizePx * 0.16);
    context.strokeStyle = "rgba(20, 30, 45, 0.85)";
    context.strokeText(text, x, y);
    context.fillStyle = color;
    context.fillText(text, x, y);
    context.restore();
  }

  function draw() {
    requestAnimationFrame(draw);
    const now = performance.now();
    const { width, height } = size();
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * scale)) canvas.width = Math.round(width * scale);
    if (canvas.height !== Math.round(height * scale)) canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    card.render(score, enabled);
    if (now - lastFrame > 1000 || !enabled || !queue.getState().dj.on) return; // camera off, or not playing

    const playback = queue.getPlayback();
    const grid = playback.loaded ? queue.beatGridAt(playback.position) : null;
    const beatMs = grid ? (60 / grid.bpm / playback.rate) * 1000 : 500;
    const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;

    const upcoming = [...shapes.values()].filter((shape) => shape.song === playback.songId && !shape.verdict).sort((a, b) => a.time - b.time);
    for (let i = 1; i < upcoming.length; i += 1) followPoints(upcoming[i - 1].dots, upcoming[i].dots, realAt(upcoming[i].time), now, beatMs);
    for (const shape of [...upcoming].reverse()) drawShape(shape.dots, realAt(shape.time), now, beatMs, { emphasis: shape.drop });

    if (mix?.choices && !mix.chosen) {
      const when = realAt(mix.chooseAt);
      mix.choices.forEach((option, index) => {
        const { choice } = option;
        const title = choice.item.title.split(" - ").slice(1).join(" - ") || choice.item.title;
        const artist = choice.item.title.split(" - ")[0];
        const detail = [index === 0 ? "The DJ's pick" : artist, choice.reason].filter(Boolean).join(": ");
        // Up 8 beats ahead (fading in over the first two), so there's time to read them.
        const shown = clamp01((beatMs * 8 - (when - now)) / (beatMs * 2));
        if (shown <= 0) return;
        const p = point(option.spot);
        balloon(p, title, detail, shown);
        choiceCircle(p, clamp01(1 - (when - now) / approachMs(beatMs)), shown);
      });
    }
    if (mix && (mix.state === "planned" || mix.state === "starting")) {
      // The mix's first targets, drawn from the plan with their whole approach (the mix
      // itself is only set up just before its downbeat).
      const when = realAt(mix.cue);
      if (mix.style === "cut") {
        drawShape(makeShape(cutShape), when, now, beatMs, { emphasis: true });
      } else if (when - now <= approachMs(beatMs)) {
        slide(inPath, "right", null, false, clamp01((1 - (when - now) / approachMs(beatMs)) * 4) * 0.8, Math.round(mix.gap * 4), 0);
        drawShape({ right: pairAt(inPath[0], "right") }, when, now, beatMs);
      }
    }
    if (mix?.heads) {
      if (mix.state === "blend" || mix.state === "landing") {
        // Each track shows from its approach until its slide is over, then fades away.
        const fadeOut = (end) => clamp01(1 - (now - end) / 300);
        const beatsIn = Math.round(mix.gap * 4);
        const beatsOut = outBars * 4;
        if (now < mix.swapAt + 300) {
          const ball = now >= mix.comesIn && now <= mix.swapAt ? mix.in?.ideal ?? 0 : null;
          slide(inPath, "right", ball, mix.in?.following, fadeOut(mix.swapAt), beatsIn, mix.inTicks?.passed ?? 0);
        }
        if (now >= mix.swapAt - approachMs(beatMs) && now < mix.endAt + 300) {
          const ball = now >= mix.swapAt && now <= mix.endAt ? mix.out?.ideal ?? 0 : null;
          slide(outPath, "left", ball, mix.out?.following, fadeOut(mix.endAt), beatsOut, mix.outTicks?.passed ?? 0);
        }
      }
      for (const head of mix.heads) if (!head.verdict) drawShape(head.dots, head.real, now, beatMs, { emphasis: mix.state === "cut" });
    }

    for (let i = effects.length - 1; i >= 0; i -= 1) {
      const effect = effects[i];
      const age = now - effect.born;
      if (age > 650) {
        effects.splice(i, 1);
        continue;
      }
      const p = point(effect.at);
      const color = effect.verdict === "perfect" ? colors.accent : effect.verdict === "good" ? "#ffffff" : "#c9cfd6";
      outlinedText(effect.text, p.x, p.y - dot() * 4 - age * 0.04, dot() * 1.5, color, 1 - age / 650);
    }
    if (playback.loaded && !playback.playing) outlinedText("Paused", width / 2, height / 2, dot() * 3.8, "#ffffff", 0.95);
    if (score.combo > 1) outlinedText(`${score.combo}×`, dot() * 2, height - dot() * 3, dot() * 4, "#ffffff", 0.95, "left");
    // Your fingertips.
    for (const side of ["left", "right"]) {
      const hand = tips[side];
      if (!hand) continue;
      for (const tip of [hand.thumb, hand.index]) {
        context.save();
        context.fillStyle = colors[side];
        context.strokeStyle = "#ffffff";
        context.lineWidth = 2;
        context.beginPath();
        context.arc(tip.x, tip.y, dot() * 0.45, 0, Math.PI * 2);
        context.fill();
        context.stroke();
        context.restore();
      }
    }
  }
  requestAnimationFrame(draw);

  card.onToggle((on) => {
    enabled = on;
    if (!on) queue.holdControls({});
  });
  card.setChecked(enabled);

  return {
    update,
    // Turns the game on or off (the start screen turns it on at "Go").
    setEnabled(on) {
      enabled = on;
      card.setChecked(on);
      if (!on) queue.holdControls({});
    },
    // For debugging and tests: the score, the mix, and the next targets: their dots (stage
    // shares) and when (performance.now() ms).
    peek(now = performance.now()) {
      const playback = queue.getPlayback();
      const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;
      const targets = [...shapes.values()]
        .filter((shape) => shape.song === playback.songId && !shape.verdict)
        .map((shape) => ({ dots: shape.dots, at: realAt(shape.time) }));
      for (const head of mix?.heads ?? []) if (!head.verdict) targets.push({ dots: head.dots, at: head.real });
      const choices = mix?.choices && !mix.chosen ? { at: realAt(mix.chooseAt), spots: mix.choices.map((choice) => choice.spot) } : null;
      const slides = mix?.state === "blend" ? { right: [inPath, mix.comesIn, mix.swapAt], left: [outPath, mix.swapAt, mix.endAt] } : null;
      return { score: { ...score }, mix: mix && { state: mix.state, style: mix.style, chosen: mix.chosen?.choice?.item.title ?? null }, targets: targets.sort((a, b) => a.at - b.at), choices, slides };
    },
  };
}

// The set card in the side rail: what's next and why, the crowd, and the score.
function buildCard(queue, rail) {
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const title = element("strong", "djSet-next");
  const why = element("p", "djSet-why");
  const hype = element("div", "djSet-hype");
  const chunks = Array.from({ length: 12 }, () => hype.appendChild(element("span")));
  const combo = element("span");
  const accuracy = element("span");
  const stats = element("p", "djSet-stats");
  stats.append(combo, accuracy);
  const toggle = element("input");
  toggle.type = "checkbox";
  toggle.checked = true;
  const label = element("label", "djSet-toggle");
  label.append(toggle, " Play the set: your hands do the mixes");
  const card = element("div", "card glass djSet");
  card.append(element("h2", null, "Set"), title, why, element("p", "djSet-label", "Crowd"), hype, stats, label);
  rail.append(card);
  addStyles();

  let last = "";
  return {
    onToggle(listener) {
      toggle.addEventListener("change", () => listener(toggle.checked));
    },
    setChecked(on) {
      toggle.checked = on;
    },
    render(score, enabled) {
      const next = queue.getUpNext();
      const shownNext = next ? next.item.title : queue.getState().dj.on ? "The DJ is picking…" : "Start the AI DJ in the queue";
      const reason = next?.item.dj?.reason ?? "";
      const lit = Math.round(score.hype * chunks.length);
      const accuracyText = score.judged ? `${Math.round((score.points / score.judged) * 100)}% accuracy` : "No hits yet";
      const key = [shownNext, reason, lit, score.combo, accuracyText, enabled].join("|");
      if (key === last) return;
      last = key;
      title.textContent = shownNext;
      why.textContent = reason;
      why.hidden = !reason;
      chunks.forEach((chunk, index) => chunk.classList.toggle("on", index < lit));
      combo.textContent = `Combo ${score.combo}`;
      accuracy.textContent = accuracyText;
      card.classList.toggle("off", !enabled);
    },
  };
}

// The sounds your hits make, on top of the music: a clap, and the DJ air horn.
function createSounds(context) {
  const out = context.createGain();
  out.gain.value = 0.55;
  out.connect(context.destination);
  const noise = context.createBuffer(1, context.sampleRate * 0.4, context.sampleRate);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;

  // A hand clap: three quick bursts of filtered noise and a short tail.
  function clap(delay, loudness) {
    const start = context.currentTime + delay;
    const source = context.createBufferSource();
    source.buffer = noise;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1300;
    band.Q.value = 0.9;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    for (const [offset, level] of [[0, 1], [0.011, 0.8], [0.022, 1]]) {
      gain.gain.setValueAtTime(level * loudness, start + offset);
      gain.gain.exponentialRampToValueAtTime(0.05 * loudness, start + offset + 0.009);
    }
    gain.gain.setValueAtTime(0.7 * loudness, start + 0.033);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.2);
    source.connect(band).connect(gain).connect(out);
    source.start(start);
    source.stop(start + 0.25);
  }

  // The air horn: two brassy saws a little apart, a quick blast and a long one.
  function horn(delay) {
    const start = context.currentTime + delay;
    const tone = context.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2600;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, start);
    for (const [at, length] of [[0, 0.12], [0.16, 0.5]]) {
      gain.gain.setValueAtTime(0, start + at);
      gain.gain.linearRampToValueAtTime(0.35, start + at + 0.02);
      gain.gain.setValueAtTime(0.35, start + at + length - 0.05);
      gain.gain.linearRampToValueAtTime(0, start + at + length);
    }
    tone.connect(gain).connect(out);
    for (const hz of [466, 470, 233]) {
      const saw = context.createOscillator();
      saw.type = "sawtooth";
      saw.frequency.setValueAtTime(hz, start);
      saw.frequency.linearRampToValueAtTime(hz * 0.97, start + 0.7);
      saw.connect(tone);
      saw.start(start);
      saw.stop(start + 0.72);
    }
  }

  // A slide tick: a short, bright click.
  function tick() {
    const start = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noise;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 6000;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.5, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.05);
    source.connect(high).connect(gain).connect(out);
    source.start(start);
    source.stop(start + 0.06);
  }

  return { clap, horn, tick };
}

function addStyles() {
  if (document.getElementById("djGame-styles")) return;
  const style = document.createElement("style");
  style.id = "djGame-styles";
  style.textContent = `
.djGame { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
.djSet .djSet-next { display: block; font-size: 15px; line-height: 1.3; }
.djSet .djSet-why { margin: 2px 0 0; font-size: 12px; color: var(--muted); }
.djSet .djSet-label { margin: 10px 0 4px; font-size: 12px; color: var(--muted); }
/* The crowd meter: chunks, like the Windows XP progress bar. */
.djSet .djSet-hype {
  display: grid; grid-template-columns: repeat(12, 1fr); gap: 2px; padding: 2px;
  border: 1px solid #8d9db4; border-radius: 3px; background: #fff;
}
.djSet .djSet-hype span { height: 10px; border-radius: 1px; background: transparent; }
.djSet .djSet-hype span.on { background: linear-gradient(#a6e98c, #37b029 45%, #2d9a22 55%, #6fd35a); }
.djSet .djSet-stats { display: flex; justify-content: space-between; margin: 8px 0 0; font-size: 12px; font-variant-numeric: tabular-nums; }
.djSet .djSet-toggle { display: flex; gap: 6px; align-items: center; margin-top: 8px; font-size: 12px; color: var(--muted); cursor: pointer; }
.djSet.off .djSet-hype, .djSet.off .djSet-stats { opacity: 0.45; }`;
  document.head.append(style);
}
