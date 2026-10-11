// The AI DJ as a rhythm game, osu!-style, played with your hands on the camera view.
//
// Circles come in about 2 beats before their beat, with a ring closing onto them: get
// that hand's palm into the circle as the ring closes (blue = left hand, green = right).
// They follow the song's beats, more of them in its loud parts, all the way through.
//
// The mixes are part of the chart:
//   - Choose: a few beats ahead, the DJ's next songs come in as circles on the right,
//     each with a balloon saying what it is and why. Your right hand in one on its beat
//     picks it; otherwise the DJ's own pick plays.
//   - Blend (tempos close): a green slider brings the new song in. Follow its ball with
//     your right hand and how far along it you are is the new song's volume. Then a
//     blue slider takes the old song out with your left hand. Not following? The AI
//     moves the music along the sliders for you.
//   - Cut (tempos far apart): one circle per hand on the downbeat; the new song slams
//     in and the old one is thrown into an echo.
//
// Hits within ~140 ms of the beat are Perfect, within ~280 ms Good. How well you play
// is the crowd's hype, which the DJ hears about when it picks the next songs. While the
// game runs, speed, filter and volume hold still (your hands are busy). With nobody in
// frame, nothing counts as a miss.
//
// The page calls update() every camera frame with its hands (ai-dj.html's hand objects:
// pts = landmarks in camera-canvas pixels), and gives it a stage, the camera canvas and
// an element in the side rail for the set card.

const leadBeats = 2; // circles show up this many beats early
const perfectMs = 140;
const goodMs = 280;
const circleSize = 0.065; // circle radius, as a share of the stage height
const reach = 1.3; // a palm within this many radii counts
const followReach = 2.2; // a palm within this many radii of a slider ball is following it
const gapBars = { short: 2, full: 4 }; // the new song's slider
const outBars = 2; // the old song's slider
const chooseBars = 4; // the choice lands this many bars before the mix (or as early as it can after the last one)
const idleMs = 2000; // no hands this long: notes are skipped, not missed
const hypeWeight = 0.08; // how fast the crowd's hype follows your hits

// Where things go, as shares of the stage. Each hand's circles stay on its own half.
const zones = { left: [0.1, 0.44], right: [0.56, 0.9], top: 0.2, bottom: 0.68 };
const choiceSpots = [[0.86, 0.24], [0.86, 0.45], [0.86, 0.66]];
const inPath = [[0.86, 0.3], [0.58, 0.56]];
const outPath = [[0.42, 0.42], [0.12, 0.42]];
const cutSpots = { left: [0.24, 0.42], right: [0.76, 0.42] };

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

export function createDjGame(queue, { stage, camera, rail }) {
  const canvas = document.createElement("canvas");
  canvas.className = "djGame";
  stage.append(canvas);
  const context = canvas.getContext("2d");
  const card = buildCard(queue, rail);

  let enabled = true;
  let lastFrame = 0;
  let lastHands = 0; // when a hand was last in frame
  const palms = { left: null, right: null };

  // The chart: notes by key, generated a little ahead of the music.
  const notes = new Map();
  let chartSong = null; // which song the chart is for
  let charted = -1; // the last bar charted
  const lastSpot = { left: [0.27, 0.45], right: [0.73, 0.45] };
  let random = Math.random;

  // The next mix: planned on the playing song, then performed in real time.
  let mix = null;
  const score = { combo: 0, best: 0, hits: 0, judged: 0, points: 0, hype: 0.5 };
  const effects = [];

  // ---- geometry -------------------------------------------------------------------

  const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
  const point = ([x, y]) => ({ x: x * size().width, y: y * size().height });
  const radius = () => size().height * circleSize;
  function toStage(p) {
    const { width, height } = size();
    const scale = Math.min(width / camera.width, height / camera.height);
    return { x: p.x * scale + (width - camera.width * scale) / 2, y: p.y * scale + (height - camera.height * scale) / 2 };
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  function along(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy));
  }

  // ---- scoring --------------------------------------------------------------------

  function judge(note, verdict) {
    note.verdict = verdict;
    note.judgedAt = performance.now();
    if (verdict === "skip") return;
    score.judged += 1;
    if (verdict === "miss") {
      score.combo = 0;
    } else {
      score.hits += 1;
      score.combo += 1;
      score.best = Math.max(score.best, score.combo);
      score.points += verdict === "perfect" ? 1 : 0.6;
    }
    const value = verdict === "perfect" ? 1 : verdict === "good" ? 0.6 : 0;
    score.hype += (value - score.hype) * hypeWeight;
    queue.setCrowd(score.hype);
    effects.push({ text: verdict === "perfect" ? "Perfect" : verdict === "good" ? "Good" : "Miss", at: note.spot, born: note.judgedAt, verdict });
  }

  // Watches one circle: the best moment its hand was inside it around its beat.
  function track(note, when, now, present) {
    if (note.verdict) return;
    const palm = palms[note.hand];
    const offset = now - when;
    if (palm && Math.abs(offset) <= goodMs && distance(palm, point(note.spot)) <= radius() * reach) {
      note.best = Math.min(note.best ?? Infinity, Math.abs(offset));
      if (note.best <= perfectMs && offset >= -perfectMs) judge(note, "perfect");
    }
    if (!note.verdict && offset > goodMs) {
      if (note.best !== undefined) judge(note, note.best <= perfectMs ? "perfect" : "good");
      else judge(note, present ? "miss" : "skip");
    }
  }

  // ---- the chart ------------------------------------------------------------------

  // Notes for the bars coming up, from the beat grid and how loud each bar is.
  function chart(playback, beatsAhead) {
    if (chartSong !== playback.songId) {
      chartSong = playback.songId;
      charted = -1;
      random = seeded(String(playback.songId));
      for (const key of notes.keys()) if (!key.startsWith("mix")) notes.delete(key);
    }
    const grid = queue.beatGridAt(playback.position);
    if (!grid) return;
    const bar = 240 / grid.bpm;
    const horizon = playback.position + (beatsAhead * bar) / 4;
    let k = Math.max(charted + 1, Math.floor((playback.position - grid.first) / bar));
    for (; grid.first + k * bar <= horizon; k += 1) {
      charted = k;
      const downbeat = grid.first + k * bar;
      if (downbeat < playback.position) continue;
      const energy = queue.energyAt(downbeat);
      const beats = energy < 0.45 ? [] : energy < 0.95 ? [0] : energy < 1.25 ? [0, 2] : [0, 1, 2, 3];
      beats.forEach((beat, index) => {
        const time = downbeat + (beat * bar) / 4;
        const hand = (k + index) % 2 === 0 ? "left" : "right";
        if (quiet(time, hand)) return; // the choice and the mix have their own circles
        // Each hand wanders around its half of the frame, a step at a time.
        const [x0, y0] = lastSpot[hand];
        const angle = random() * Math.PI * 2;
        const step = 0.1 + random() * 0.14;
        const [minX, maxX] = zones[hand];
        const x = Math.max(minX, Math.min(maxX, x0 + Math.cos(angle) * step));
        const y = Math.max(zones.top, Math.min(zones.bottom, y0 + Math.sin(angle) * step * 0.8));
        lastSpot[hand] = [x, y];
        const key = `${playback.songId}:${k}:${beat}`;
        notes.set(key, { key, kind: "tap", song: playback.songId, time, hand, spot: [x, y] });
      });
    }
  }

  // ---- the mix --------------------------------------------------------------------

  // Song times kept clear of ordinary circles: the right hand's while the choice is up
  // (its balloons fill the right half), and both from the mix on.
  function quiet(time, hand) {
    if (!mix) return false;
    const choosing = mix.chooseAt !== null && time >= mix.chooseAt - 2 * mix.bar && time <= mix.chooseAt + mix.bar / 2;
    return (choosing && hand === "right") || time >= mix.cue - mix.bar / 2;
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
    const earliest = barAfter(playback.position + 2 * bar);
    const chooseAt = earliest <= cue - 2 * bar ? Math.max(earliest, cue - chooseBars * bar) : null;
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
    };
  }

  function offerChoices(playback) {
    const choices = queue.getChoices();
    if (choices.length < 2) return;
    mix.choices = choices.map((choice, index) => ({
      key: `mix:choice:${index}`,
      kind: "choice",
      hand: "right",
      time: mix.chooseAt,
      spot: choiceSpots[index],
      choice,
    }));
  }

  function startMix() {
    mix.state = "starting";
    const planned = mix;
    queue.startHandMix({ startAt: planned.cue }).then((controls) => {
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
        heads: [],
      });
      if (controls.style === "cut") {
        // The new song slams in on the downbeat and the old one gets thrown into an echo.
        controls.setIncoming(1);
        controls.echoOut();
        planned.heads = ["left", "right"].map((hand) => ({ key: `mix:cut:${hand}`, kind: "tap", hand, spot: cutSpots[hand], real: comesIn }));
      } else {
        planned.heads = [
          { key: "mix:in", kind: "tap", hand: "right", spot: inPath[0], real: comesIn },
          { key: "mix:out", kind: "tap", hand: "left", spot: outPath[0], real: planned.swapAt },
        ];
      }
    });
  }

  // While a blend runs: each slider's ball moves on the beat; a following hand sets the level.
  function performBlend(now) {
    const { controls } = mix;
    if (controls.done) return finishMix();
    const slide = (path, from, to, hand) => {
      const ideal = clamp01((now - from) / (to - from));
      const palm = palms[hand];
      const a = point(path[0]);
      const b = point(path[1]);
      const following = palm && now >= from && distance(palm, lerp(a, b, ideal)) <= radius() * followReach;
      return { ideal, level: following ? along(palm, a, b) : ideal, following };
    };
    mix.in = slide(inPath, mix.comesIn, mix.swapAt, "right");
    controls.setIncoming(now < mix.swapAt ? mix.in.level : 1);
    if (now >= mix.swapAt) {
      controls.swapBass();
      mix.out = slide(outPath, mix.swapAt, mix.endAt, "left");
      controls.setOutgoing(1 - mix.out.level);
      if (now >= mix.endAt) {
        controls.finish(mix.barMs / 2000);
        mix.state = "landing";
      }
    }
  }

  function finishMix() {
    mix = null;
    notes.clear();
    chartSong = null;
  }

  // ---- every camera frame ---------------------------------------------------------

  function update(input, now) {
    lastFrame = now;
    for (const side of ["left", "right"]) {
      const hand = input[side];
      palms[side] = hand ? toStage(hand.pts[9]) : null; // the middle knuckle: the palm's center
    }
    if (palms.left || palms.right) lastHands = now;
    const present = now - lastHands < idleMs;
    const active = enabled && queue.getState().dj.on;
    queue.holdControls(active);
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
      if (!mix.choices && mix.chooseAt !== null && playback.position >= mix.chooseAt - 2 * mix.bar) offerChoices(playback);
      if (playback.position >= mix.startAt) startMix();
    }

    // Taps of the song (not during a mix: those wait until it's landed).
    if (!mix || mix.state === "planned" || mix.state === "starting") chart(playback, leadBeats + 4);
    for (const note of notes.values()) {
      if (note.kind !== "tap" || note.song !== playback.songId) continue;
      track(note, realAt(note.time), now, present);
    }
    // The choice: the right hand in one of the DJ's songs on its beat picks it.
    if (mix?.choices && !mix.chosen) {
      const when = realAt(mix.chooseAt);
      const palm = palms.right;
      const picked = palm && Math.abs(now - when) <= goodMs ? mix.choices.find((note) => distance(palm, point(note.spot)) <= radius() * reach) : null;
      if (picked) {
        queue.chooseNext(picked.choice.item.id);
        mix.chosen = picked;
        judge(picked, Math.abs(now - when) <= perfectMs ? "perfect" : "good");
      } else if (now - when > goodMs) {
        mix.chosen = mix.choices[0]; // the DJ's own pick stands
      }
    }
    // The mix's own circles (slider heads, the cut).
    if (mix?.heads) for (const head of mix.heads) track(head, head.real, now, present);
  }

  // ---- drawing --------------------------------------------------------------------

  // A circle: translucent, with the hand's color as its rim and a little Luna gloss.
  function circle(p, color, alpha, r = radius()) {
    context.save();
    context.globalAlpha = alpha;
    context.fillStyle = "rgba(255, 255, 255, 0.28)";
    context.beginPath();
    context.arc(p.x, p.y, r, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = r * 0.17;
    context.strokeStyle = color;
    context.stroke();
    context.lineWidth = 2;
    context.strokeStyle = "rgba(255, 255, 255, 0.9)";
    context.beginPath();
    context.arc(p.x, p.y, r * 0.9, 0, Math.PI * 2);
    context.stroke();
    const gloss = context.createLinearGradient(p.x, p.y - r, p.x, p.y);
    gloss.addColorStop(0, "rgba(255, 255, 255, 0.55)");
    gloss.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = gloss;
    context.beginPath();
    context.ellipse(p.x, p.y - r * 0.42, r * 0.6, r * 0.34, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  // The approach ring, in segments like the XP progress bar, closing onto the circle on the beat.
  function approachRing(p, color, progress, alpha) {
    const r = radius() * (1 + 1.6 * (1 - progress));
    const segments = 14;
    context.save();
    context.globalAlpha = alpha;
    context.strokeStyle = color;
    context.lineWidth = radius() * 0.1;
    context.lineCap = "butt";
    for (let i = 0; i < segments; i += 1) {
      const start = (i / segments) * Math.PI * 2 - Math.PI / 2;
      context.beginPath();
      context.arc(p.x, p.y, r, start + 0.06, start + (Math.PI * 2) / segments - 0.06);
      context.stroke();
    }
    context.restore();
  }

  function drawNote(spot, color, when, now, beatMs) {
    const leadMs = leadBeats * beatMs;
    const progress = clamp01(1 - (when - now) / leadMs);
    if (when - now > leadMs || now - when > goodMs) return;
    const fadeIn = clamp01(progress * 3);
    const p = point(spot);
    circle(p, color, fadeIn);
    if (now < when) approachRing(p, color, progress, fadeIn);
  }

  function slider(path, color, ball, following, alpha) {
    const a = point(path[0]);
    const b = point(path[1]);
    context.save();
    context.globalAlpha = alpha;
    context.lineCap = "round";
    context.lineWidth = radius() * 1.7;
    context.strokeStyle = "rgba(255, 255, 255, 0.22)";
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    context.lineWidth = 3;
    context.strokeStyle = color;
    context.setLineDash([radius() * 0.3, radius() * 0.2]);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
    context.restore();
    if (ball === null) return;
    const p = lerp(a, b, ball);
    circle(p, color, alpha, radius() * 0.75);
    if (following) {
      context.save();
      context.globalAlpha = alpha;
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.beginPath();
      context.arc(p.x, p.y, radius() * followReach * 0.7, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }

  // An XP notification balloon to the left of a choice circle.
  function balloon(p, title, detail, alpha) {
    const pad = 8;
    context.save();
    context.globalAlpha = alpha;
    context.font = `bold 13px ${uiFont}`;
    const width = Math.min(Math.max(context.measureText(title).width, detail ? measure(detail) : 0) + pad * 2, size().width * 0.34);
    const height = detail ? 40 : 24;
    const right = p.x - radius() * 1.25;
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
    context.font = `bold 13px ${uiFont}`;
    context.fillText(clip(title, width - pad * 2), x + pad, detail ? y + 13 : p.y);
    if (detail) {
      context.font = `11px ${uiFont}`;
      context.fillText(clip(detail, width - pad * 2), x + pad, y + 28);
    }
    context.restore();
  }
  function measure(text) {
    context.save();
    context.font = `11px ${uiFont}`;
    const width = context.measureText(text).width;
    context.restore();
    return width;
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
    card.render(score, mix, enabled);
    if (now - lastFrame > 1000 || !enabled || !queue.getState().dj.on) return; // camera off, or not playing

    const playback = queue.getPlayback();
    const grid = playback.loaded ? queue.beatGridAt(playback.position) : null;
    const beatMs = grid ? (60 / grid.bpm / playback.rate) * 1000 : 500;
    const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;

    // Later notes underneath earlier ones.
    const taps = [...notes.values()].filter((note) => note.kind === "tap" && note.song === playback.songId && !note.verdict);
    taps.sort((a, b) => b.time - a.time);
    for (const note of taps) drawNote(note.spot, colors[note.hand], realAt(note.time), now, beatMs);

    if (mix?.choices && !mix.chosen) {
      const when = realAt(mix.chooseAt);
      mix.choices.forEach((note, index) => {
        const { choice } = note;
        const title = choice.item.title.split(" - ").slice(1).join(" - ") || choice.item.title;
        const artist = choice.item.title.split(" - ")[0];
        const detail = [index === 0 ? "The DJ's pick" : artist, choice.reason].filter(Boolean).join(": ");
        // Up 8 beats ahead (fading in over the first two), so there's time to read them.
        const shown = clamp01((beatMs * 8 - (when - now)) / (beatMs * 2));
        if (shown <= 0) return;
        balloon(point(note.spot), title, detail, shown);
        circle(point(note.spot), colors.accent, shown);
        if (when - now <= leadBeats * beatMs && now < when) {
          approachRing(point(note.spot), colors.accent, clamp01(1 - (when - now) / (leadBeats * beatMs)), shown);
        }
      });
    }
    if (mix?.heads?.length) {
      if (mix.state === "blend" || mix.state === "landing") {
        slider(inPath, colors.right, now >= mix.comesIn ? mix.in?.ideal ?? 0 : null, mix.in?.following, now < mix.swapAt + mix.barMs ? 1 : 0.35);
        if (now >= mix.swapAt - leadBeats * beatMs) slider(outPath, colors.left, now >= mix.swapAt ? mix.out?.ideal ?? 0 : null, mix.out?.following, 1);
      }
      for (const head of mix.heads) if (!head.verdict) drawNote(head.spot, colors[head.hand], head.real, now, beatMs);
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
      outlinedText(effect.text, p.x, p.y - radius() * 1.3 - age * 0.04, radius() * 0.48, color, 1 - age / 650);
    }
    if (score.combo > 1) outlinedText(`${score.combo}×`, radius() * 0.6, height - radius() * 0.9, radius() * 1.25, "#ffffff", 0.95, "left");
    for (const side of ["left", "right"]) {
      const palm = palms[side];
      if (!palm) continue;
      context.save();
      context.fillStyle = colors[side];
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.beginPath();
      context.arc(palm.x, palm.y, radius() * 0.22, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.restore();
    }
  }
  requestAnimationFrame(draw);

  card.onToggle((on) => {
    enabled = on;
    if (!on) queue.holdControls(false);
  });

  return {
    update,
    // For debugging and tests: the score, the mix, and where the next targets are
    // (stage shares) and when (performance.now() ms).
    peek(now = performance.now()) {
      const playback = queue.getPlayback();
      const realAt = (songTime) => now + ((songTime - playback.position) / playback.rate) * 1000;
      const targets = [...notes.values()]
        .filter((note) => note.kind === "tap" && note.song === playback.songId && !note.verdict)
        .map((note) => ({ hand: note.hand, spot: note.spot, at: realAt(note.time) }));
      if (mix?.choices && !mix.chosen) targets.push(...mix.choices.map((note) => ({ hand: "right", spot: note.spot, at: realAt(mix.chooseAt), title: note.choice.item.title })));
      for (const head of mix?.heads ?? []) if (!head.verdict) targets.push({ hand: head.hand, spot: head.spot, at: head.real });
      const sliders = mix?.state === "blend" ? { in: [inPath, mix.comesIn, mix.swapAt], out: [outPath, mix.swapAt, mix.endAt] } : null;
      return { score: { ...score }, mix: mix && { state: mix.state, chosen: mix.chosen?.choice?.item.title ?? null }, targets: targets.sort((a, b) => a.at - b.at), sliders };
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
  const toggle = element("input");
  toggle.type = "checkbox";
  toggle.checked = true;
  const label = element("label", "djSet-toggle");
  label.append(toggle, " Play the set: your hands do the mixes");
  const card = element("div", "card glass djSet");
  card.append(
    element("h2", null, "Set"),
    title,
    why,
    element("p", "djSet-label", "Crowd"),
    hype,
    Object.assign(element("p", "djSet-stats"), {}),
    label,
  );
  card.querySelector(".djSet-stats").append(combo, accuracy);
  rail.append(card);
  addStyles();

  let last = "";
  return {
    onToggle(listener) {
      toggle.addEventListener("change", () => listener(toggle.checked));
    },
    render(score, mix, enabled) {
      const next = queue.getUpNext();
      const shownNext = next
        ? next.item.title
        : queue.getState().dj.on
          ? "The DJ is picking…"
          : "Start the AI DJ in the queue";
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
