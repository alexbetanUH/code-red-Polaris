// The AI DJ's coach, Maestro style: big glossy orbs over the whole camera view that you
// reach into and grab (pinch) in time with the music. The AI suggests, you perform:
//
//   1. Choose: the DJ offers its next few songs as orbs on the right, each with its
//      reason. Grab one, or hold a left fist and show 1–3 fingers on your right hand.
//      Don't choose and the DJ's own pick (⭐) stands.
//   2. Grab the drop: a green orb with a closing ring. Grab it as the ring closes and
//      the song comes in on that downbeat; keep holding and pull it along its rail
//      toward the middle to turn it up.
//   3. Pull the plug: a blue orb (the old song) appears. Grab it on its beat (the bass
//      lines swap) and drag it off to the left to fade the old song out.
//   Songs whose tempos clash can't be blended by hand: the AI echoes them out (🌊).
//
// Grabs within a beat of the cue are PERFECT, within two GOOD. Miss one by a bar, or
// stall, and the AI does that part, so the music never stops. While you grab things (and
// for the whole mix) speed, filter and volume hold still, since grabbing pinches.
//
// The page calls update() every camera frame with its hands (ai-dj.html's hand objects:
// mid = the pinch point in camera-canvas pixels, pts = landmarks, pinch 0–1, pinched,
// pose, ext = which fingers are out).

const perfectBeats = 1;
const goodBeats = 2;
const missBars = 1; // a move this late is done by the AI instead
const earlyBars = 8; // the drop can be grabbed this early
const gapBars = { short: 2, full: 4 }; // from the drop to pulling the plug
const finishBars = 2; // the AI eases a mix home over this long
const stallBars = 6; // after the plug is grabbed, the hands get this long to finish
const chooseCloseBars = 2; // choosing closes this long before the drop
const releaseAt = 0.85; // the old song dragged this far along its rail ends the mix
const fistHoldMs = 300; // a left fist held this long starts finger counting
const countHoldMs = 500; // a finger count held this long picks that song
const orbSize = 0.09; // orb radius, as a share of the stage height
const grabReach = 1.5; // a pinch this many radii from an orb grabs it
const planEveryMs = 100;

// Where things sit, as shares of the stage: choices on the right; the drop's rail runs
// from the right toward the middle, the plug's from the middle off to the left.
const layout = {
  choices: [[0.83, 0.22], [0.83, 0.47], [0.83, 0.72]],
  dropFrom: [0.84, 0.3],
  dropTo: [0.6, 0.6],
  plugFrom: [0.4, 0.42],
  plugTo: [0.1, 0.42],
};
// Aero palette (matching aero.css): light, base and dark of each glossy color.
const palette = {
  green: ["#c8f59e", "#5cb82c", "#3f8f17"],
  blue: ["#a9defd", "#1e95e3", "#0a6bc0"],
  orange: ["#ffd3a8", "#f5861f", "#c35f08"],
  gold: ["#fff1b8", "#ffc93c", "#d99a00"],
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
// How far along a rail from `from` to `to` a point is, 0–1.
function along(point, from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return clamp01(((point.x - from.x) * dx + (point.y - from.y) * dy) / (dx * dx + dy * dy));
}
const lerp = (from, to, t) => ({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });

export function createDjCoach(queue, upNext, { stage, camera }) {
  const canvas = document.createElement("canvas");
  canvas.className = "maestro";
  stage.append(canvas);
  addStyles();
  const context = canvas.getContext("2d");

  let phase = "idle"; // idle → choose → drop → starting → bringIn → letGo → closing → idle
  let plan = null; // { item, style, cue1, cue2, beatMs, barMs } (performance.now() ms)
  let plannedAt = 0;
  let choices = [];
  let choseFor = null; // the song the next one was chosen for
  let controls = null; // transitions.js hand-mix controls while a hand mix runs
  let grab = null; // { orb: "drop" | "plug", side } while a hand holds an orb
  let progress = { drop: 0, plug: 0 }; // how far each orb has been pulled along its rail
  let letGoAt = 0;
  let lastUpdate = 0;
  let held = false;
  const hands = { left: null, right: null };
  const counting = { fistSince: 0, fingers: 0, fingersSince: 0 };
  const effects = []; // floating texts and particles
  const score = { perfect: 0, moves: 0, combo: 0 };

  // ---- geometry -------------------------------------------------------------------

  const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });
  const at = ([x, y]) => {
    const { width, height } = size();
    return { x: x * width, y: y * height };
  };
  const orbRadius = () => size().height * orbSize;
  // Camera-canvas pixels → stage pixels (the camera canvas is letterboxed to fit).
  function toStage(point) {
    const { width, height } = size();
    const scale = Math.min(width / camera.width, height / camera.height);
    return {
      x: point.x * scale + (width - camera.width * scale) / 2,
      y: point.y * scale + (height - camera.height * scale) / 2,
    };
  }

  // ---- feedback -------------------------------------------------------------------

  function burst(point, color, text) {
    const now = performance.now();
    if (text) effects.push({ kind: "text", text, x: point.x, y: point.y - orbRadius() * 1.4, born: now, color });
    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2;
      const speed = 0.12 + Math.random() * 0.18;
      effects.push({ kind: "spark", x: point.x, y: point.y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, born: now, color });
    }
  }
  function rate(now, cue, point, color) {
    const off = Math.abs(now - cue) / plan.beatMs;
    score.moves += 1;
    if (off <= perfectBeats) {
      score.perfect += 1;
      score.combo += 1;
      burst(point, color, "PERFECT");
    } else if (off <= goodBeats) {
      score.combo += 1;
      burst(point, color, "GOOD");
    } else {
      burst(point, color, "OK");
    }
  }
  function aiCovers(message, point) {
    score.moves += 1;
    score.combo = 0;
    burst(point ?? at([0.5, 0.45]), palette.orange, message);
  }

  // ---- the plan: what's next and when ---------------------------------------------

  function refreshPlan(now) {
    if (now - plannedAt < planEveryMs) return;
    plannedAt = now;
    const next = queue.getUpNext();
    if (!next || next.mixing || next.secondsToOut === null || !next.style || !next.beatSeconds) {
      plan = null;
      return;
    }
    const beatMs = next.beatSeconds * 1000;
    const barMs = beatMs * 4;
    // Cues sit on downbeats of the beat grid the mix itself uses.
    const downbeat = now + next.secondsToDownbeat * 1000;
    const onDownbeat = (time) => downbeat + Math.round((time - downbeat) / barMs) * barMs;
    const gap = (next.short ? gapBars.short : gapBars.full) * barMs;
    const cue1 =
      next.style === "blend"
        ? onDownbeat(now + next.secondsToOut * 1000 - gap - finishBars * barMs)
        : onDownbeat(now + next.secondsToMix * 1000);
    plan = { item: next.item, style: next.style, cue1, cue2: cue1 + gap, beatMs, barMs };
  }

  // ---- hands ----------------------------------------------------------------------

  function readHands(input) {
    for (const side of ["left", "right"]) {
      const hand = input[side];
      const before = hands[side];
      if (!hand) {
        hands[side] = null;
        continue;
      }
      hands[side] = {
        cursor: toStage(hand.mid),
        palm: toStage(hand.pts[9]),
        pinch: hand.pinch,
        pinched: hand.pinched,
        grabbed: hand.pinched && !before?.pinched, // pinched this frame
        fist: Boolean(hand.pose?.includes("fist")),
        fingers: hand.ext ? hand.ext.slice(1).filter(Boolean).length : 0,
      };
    }
  }
  // The hand that just grabbed within reach of a point, if any.
  function grabbing(point) {
    for (const side of ["right", "left"]) {
      const hand = hands[side];
      if (hand?.grabbed && distance(hand.cursor, point) <= orbRadius() * grabReach) return side;
    }
    return null;
  }
  const near = (point) =>
    ["left", "right"].some((side) => hands[side] && distance(hands[side].cursor, point) <= orbRadius() * grabReach * 1.3);

  // ---- choosing -------------------------------------------------------------------

  function choose(index) {
    const choice = choices[index];
    if (!choice) return;
    queue.chooseNext(choice.item.id);
    choseFor = queue.getState().currentId;
    burst(at(layout.choices[index]), palette.green, index === 0 ? "⭐ AI's pick" : "Your pick");
    plan = null;
    plannedAt = 0;
    phase = "drop";
    counting.fistSince = 0;
  }

  function updateChoose(now) {
    for (const [index] of choices.entries()) {
      if (grabbing(at(layout.choices[index]))) return choose(index);
    }
    // Left fist held → count the right hand's fingers (1–3); hold the count to pick.
    const left = hands.left;
    const right = hands.right;
    if (left?.fist) counting.fistSince ||= now;
    else counting.fistSince = 0;
    const countingOn = counting.fistSince && now - counting.fistSince >= fistHoldMs;
    const fingers = countingOn && right ? right.fingers : 0;
    if (fingers !== counting.fingers) {
      counting.fingers = fingers;
      counting.fingersSince = now;
    } else if (fingers >= 1 && fingers <= choices.length && now - counting.fingersSince >= countHoldMs) {
      choose(fingers - 1);
    }
  }

  // ---- the mix --------------------------------------------------------------------

  function startHandMix(now, side) {
    const cued = now >= plan.cue1 - goodBeats * plan.beatMs;
    if (cued) rate(now, plan.cue1, at(layout.dropFrom), palette.green);
    else burst(at(layout.dropFrom), palette.green, "YOUR CALL");
    grab = { orb: "drop", side };
    progress = { drop: 0, plug: 0 };
    phase = "starting";
    const gap = plan.cue2 - plan.cue1;
    queue.startHandMix().then((started) => {
      if (!started) {
        phase = "idle"; // it couldn't be a hand mix after all (the AI mixed it instead)
        grab = null;
        return;
      }
      controls = started;
      plan = { ...plan, cue2: performance.now() + started.startsIn * 1000 + gap };
      controls.setIncoming(progress.drop);
      phase = "bringIn";
    });
  }

  function aiFinish(message) {
    controls.finish((finishBars * plan.barMs) / 1000);
    phase = "closing";
    grab = null;
    if (message) aiCovers(message);
  }

  // Moves a held orb along its rail and returns its progress.
  function drag(orb, from, to) {
    const hand = grab?.orb === orb ? hands[grab.side] : null;
    if (hand?.pinched) progress[orb] = along(hand.cursor, from, to);
    else if (grab?.orb === orb && hand && !hand.pinched) grab = null; // let go: it stays where it is
    return progress[orb];
  }

  function update(input, now) {
    queue.coachPing();
    lastUpdate = now;
    readHands(input);

    if (phase === "idle" || phase === "choose" || phase === "drop") {
      refreshPlan(now);
      if (!plan) {
        if (phase !== "drop") phase = "idle";
        return;
      }
      const currentId = queue.getState().currentId;
      if (choseFor !== currentId) {
        choices = queue.getChoices();
        if (choices.length >= 2 && plan.cue1 - now > chooseCloseBars * plan.barMs) {
          phase = "choose";
          return updateChoose(now);
        }
        choseFor = currentId; // time's up (or nothing to choose from): the DJ's pick stands
      }
      phase = "drop";
      const { cue1, barMs } = plan;
      if (plan.style === "blend") {
        const side = now >= cue1 - earlyBars * barMs ? grabbing(at(layout.dropFrom)) : null;
        if (side) return startHandMix(now, side);
      } else if (now >= cue1 && queue.mixNow()) {
        burst(at(layout.dropFrom), palette.orange, "🌊 Echo out");
        phase = "idle";
        plan = null;
        return;
      }
      if (now > cue1 + missBars * barMs && queue.mixNow()) {
        aiCovers("AI covered it 🤖", at(layout.dropFrom));
        phase = "idle";
        plan = null;
      }
      return;
    }

    if (phase === "starting") {
      drag("drop", at(layout.dropFrom), at(layout.dropTo));
      return;
    }
    if (!controls || controls.done) {
      // Finished, or cut short by a skip or pause.
      phase = "idle";
      controls = null;
      plan = null;
      grab = null;
      return;
    }
    if (phase === "closing") return;

    controls.setIncoming(drag("drop", at(layout.dropFrom), at(layout.dropTo)));
    const { cue2, beatMs, barMs } = plan;
    if (phase === "bringIn") {
      const side = now >= cue2 - goodBeats * beatMs ? grabbing(at(layout.plugFrom)) : null;
      if (side) {
        rate(now, cue2, at(layout.plugFrom), palette.blue);
        controls.swapBass();
        grab = { orb: "plug", side };
        letGoAt = now;
        phase = "letGo";
      } else if (now > cue2 + missBars * barMs) {
        aiFinish("AI finished it 🤖");
      }
      return;
    }
    // letGo: dragging the old song off to the left fades it out.
    const pulled = drag("plug", at(layout.plugFrom), at(layout.plugTo));
    controls.setOutgoing(1 - pulled);
    if (pulled >= releaseAt) {
      controls.finish(plan.barMs / 1000);
      phase = "closing";
      grab = null;
      score.combo += 1;
      burst(at(layout.plugTo), palette.blue, "Clean mix 🔥");
    } else if (now > letGoAt + stallBars * barMs) {
      aiFinish("AI finished it 🤖");
    }
  }

  // ---- drawing --------------------------------------------------------------------

  function orb(point, colors, { radius = orbRadius(), hot = false, alpha = 1 } = {}) {
    const [light, base, dark] = colors;
    const { x, y } = point;
    context.save();
    context.globalAlpha = alpha;
    context.shadowColor = hot ? "rgba(255, 201, 60, .95)" : "rgba(10, 60, 110, .35)";
    context.shadowBlur = radius * (hot ? 0.9 : 0.35);
    context.shadowOffsetY = hot ? 0 : radius * 0.12;
    const body = context.createRadialGradient(x - radius * 0.35, y - radius * 0.45, radius * 0.1, x, y, radius);
    body.addColorStop(0, "#ffffff");
    body.addColorStop(0.3, light);
    body.addColorStop(0.85, base);
    body.addColorStop(1, dark);
    context.fillStyle = body;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowColor = "transparent";
    const shine = context.createLinearGradient(x, y - radius, x, y - radius * 0.1);
    shine.addColorStop(0, "rgba(255, 255, 255, .95)");
    shine.addColorStop(1, "rgba(255, 255, 255, 0)");
    context.fillStyle = shine;
    context.beginPath();
    context.ellipse(x, y - radius * 0.45, radius * 0.62, radius * 0.4, 0, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = Math.max(2, radius * 0.07);
    context.strokeStyle = hot ? palette.gold[1] : "rgba(255, 255, 255, .95)";
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  function text(value, x, y, { size = 16, weight = 800, align = "center", color = "#3a2412", alpha = 1 } = {}) {
    context.save();
    context.globalAlpha = alpha;
    context.font = `${weight} ${size}px Nunito, system-ui, sans-serif`;
    context.textAlign = align;
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.lineWidth = Math.max(3, size * 0.28);
    context.strokeStyle = "rgba(255, 255, 255, .92)";
    context.strokeText(value, x, y);
    context.fillStyle = color;
    context.fillText(value, x, y);
    context.restore();
  }

  function rail(from, to, filled, colors) {
    const width = orbRadius() * 0.55;
    context.save();
    context.lineCap = "round";
    context.lineWidth = width;
    context.strokeStyle = "rgba(255, 255, 255, .45)";
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
    if (filled > 0.01) {
      const end = lerp(from, to, filled);
      context.lineWidth = width * 0.55;
      context.strokeStyle = colors[1];
      context.globalAlpha = 0.75;
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(end.x, end.y);
      context.stroke();
    }
    context.restore();
  }

  // A ring that closes onto an orb exactly on its cue, with the last beats counted down.
  function approach(point, cue, colors, now) {
    const beats = (cue - now) / plan.beatMs;
    if (beats > 4 || beats < -1) return;
    const radius = orbRadius() * (1 + Math.max(0, beats) * 0.55);
    context.save();
    context.globalAlpha = clamp01(1 - Math.abs(beats) / 4) * 0.9 + 0.1;
    context.lineWidth = orbRadius() * 0.12;
    context.strokeStyle = colors[1];
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
    if (beats > 0) text(String(Math.ceil(beats)), point.x, point.y, { size: orbRadius() * 0.8, weight: 900, color: colors[2] });
  }

  function header(message, sub) {
    const { width } = size();
    const radius = orbRadius();
    const y = radius * 0.9;
    const height = radius * (sub ? 1.15 : 0.8);
    context.save();
    context.font = `900 ${radius * 0.45}px Nunito, system-ui, sans-serif`;
    let pillWidth = context.measureText(message).width;
    if (sub) {
      context.font = `700 ${radius * 0.26}px Nunito, system-ui, sans-serif`;
      pillWidth = Math.max(pillWidth, context.measureText(sub).width);
    }
    pillWidth += radius * 0.9;
    const pill = context.createLinearGradient(0, y - height / 2, 0, y + height / 2);
    pill.addColorStop(0, "rgba(255, 255, 255, .96)");
    pill.addColorStop(1, "rgba(255, 240, 222, .9)");
    context.fillStyle = pill;
    context.shadowColor = "rgba(150, 70, 20, .25)";
    context.shadowBlur = 14;
    context.beginPath();
    context.roundRect(width / 2 - pillWidth / 2, y - height / 2, pillWidth, height, height / 2);
    context.fill();
    context.restore();
    text(message, width / 2, sub ? y - height * 0.17 : y, { size: radius * 0.45, weight: 900 });
    if (sub) text(sub, width / 2, y + height * 0.24, { size: radius * 0.26, weight: 700, color: "#7a4a26" });
  }

  // Each hand's pinch point: a ring that shrinks as the pinch closes, filled when grabbing.
  function cursors() {
    for (const [side, colors] of [["left", palette.blue], ["right", palette.green]]) {
      const hand = hands[side];
      if (!hand) continue;
      const radius = orbRadius() * (0.22 + 0.3 * clamp01(hand.pinch));
      context.save();
      context.lineWidth = 3;
      context.strokeStyle = colors[1];
      context.fillStyle = hand.pinched ? colors[1] : "rgba(255, 255, 255, .55)";
      context.beginPath();
      context.arc(hand.cursor.x, hand.cursor.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.restore();
    }
  }

  function drawEffects(now) {
    for (let i = effects.length - 1; i >= 0; i -= 1) {
      const effect = effects[i];
      const age = now - effect.born;
      const life = effect.kind === "text" ? 1100 : 650;
      if (age > life) {
        effects.splice(i, 1);
        continue;
      }
      const fade = 1 - age / life;
      if (effect.kind === "text") {
        text(effect.text, effect.x, effect.y - age * 0.05, { size: orbRadius() * 0.6, weight: 900, color: effect.color[2], alpha: fade });
      } else {
        context.save();
        context.globalAlpha = fade;
        context.fillStyle = effect.color[0];
        context.beginPath();
        context.arc(effect.x + effect.vx * age, effect.y + effect.vy * age, orbRadius() * 0.12 * fade + 1, 0, Math.PI * 2);
        context.fill();
        context.restore();
      }
    }
  }

  const shortTitle = (item) => item.title.split(" - ").slice(1).join(" - ") || item.title;
  const artistOf = (item) => item.title.split(" - ")[0];
  const clock = (ms) => {
    const whole = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  };

  function drawChoose(now) {
    const radius = orbRadius();
    choices.forEach((choice, index) => {
      const point = at(layout.choices[index]);
      const counted = counting.fingers === index + 1;
      const colors = choice.blends === false ? palette.orange : palette.green;
      orb(point, colors, { hot: near(point) || counted });
      text(String(index + 1), point.x, point.y + radius * 0.05, { size: radius * 0.75, weight: 900, color: colors[2] });
      const left = point.x - radius * 1.35;
      text(`${index === 0 ? "⭐ " : ""}${shortTitle(choice.item)}`, left, point.y - radius * 0.45, { size: radius * 0.42, weight: 900, align: "right" });
      const facts = [artistOf(choice.item), choice.item.genre, choice.blends === false ? "🌊 echo" : "✋ blends"].filter(Boolean);
      text(facts.join(" · "), left, point.y + radius * 0.02, { size: radius * 0.3, weight: 800, align: "right", color: "#7a4a26" });
      if (choice.reason) text(`“${choice.reason}”`, left, point.y + radius * 0.44, { size: radius * 0.27, weight: 700, align: "right", color: "#7a4a26" });
    });
    const closes = plan.cue1 - chooseCloseBars * plan.barMs;
    header("🎵 Choose the next song", `grab one, or left fist + 1–3 fingers · DJ's pick in ${clock(closes - now)}`);
    if (counting.fistSince && now - counting.fistSince >= fistHoldMs && hands.left) {
      const filled = counting.fingers ? clamp01((now - counting.fingersSince) / countHoldMs) : 0;
      context.save();
      context.lineWidth = radius * 0.14;
      context.strokeStyle = palette.gold[1];
      context.beginPath();
      context.arc(hands.left.palm.x, hands.left.palm.y, radius * 0.8, -Math.PI / 2, -Math.PI / 2 + filled * Math.PI * 2);
      context.stroke();
      context.restore();
      text(counting.fingers ? String(counting.fingers) : "1–3?", hands.left.palm.x, hands.left.palm.y, { size: radius * 0.5, weight: 900 });
    }
  }

  function drawMix(now) {
    const dropFrom = at(layout.dropFrom);
    const dropTo = at(layout.dropTo);
    const plugFrom = at(layout.plugFrom);
    const plugTo = at(layout.plugTo);
    const name = shortTitle(plan.item);
    if (phase === "drop" && plan.style === "echo") {
      orb(dropFrom, palette.orange, { alpha: 0.9 });
      text("🌊", dropFrom.x, dropFrom.y, { size: orbRadius() * 0.8 });
      text(name, dropFrom.x, dropFrom.y + orbRadius() * 1.45, { size: orbRadius() * 0.4, weight: 900 });
      header("🌊 These two don't blend", `the AI echoes it out in ${clock(plan.cue1 - now)}`);
      return;
    }
    rail(dropFrom, dropTo, progress.drop, palette.green);
    const dropAt = lerp(dropFrom, dropTo, progress.drop);
    orb(dropAt, palette.green, { hot: grab?.orb === "drop" || (phase === "drop" && near(dropFrom)) });
    text(name, dropAt.x, dropAt.y + orbRadius() * 1.45, { size: orbRadius() * 0.4, weight: 900 });
    if (phase === "drop") {
      approach(dropFrom, plan.cue1, palette.green, now);
      header("✋ Grab the drop", now < plan.cue1 - 4 * plan.beatMs ? `on the beat in ${clock(plan.cue1 - now)}` : "pinch it as the ring closes");
      return;
    }
    // The old song's orb: it shows up for its cue, then gets dragged off to the left.
    const showing = phase !== "starting" && (phase !== "bringIn" || now >= plan.cue2 - 4 * plan.beatMs);
    if (showing) {
      rail(plugFrom, plugTo, progress.plug, palette.blue);
      const plugAt = lerp(plugFrom, plugTo, progress.plug);
      orb(plugAt, palette.blue, { hot: grab?.orb === "plug" || (phase === "bringIn" && near(plugFrom)), alpha: 1 - progress.plug * 0.5 });
      text("🔌", plugAt.x, plugAt.y, { size: orbRadius() * 0.6 });
      if (phase === "bringIn") approach(plugFrom, plan.cue2, palette.blue, now);
    }
    const pulledIn = progress.drop < 0.5 ? "pull it toward the middle to turn it up" : "nice, now wait for the 🔌";
    if (phase === "starting" || phase === "bringIn") {
      header("🎚 Bring it in", now >= plan.cue2 - 4 * plan.beatMs ? "🔌 grab the old song on the beat" : pulledIn);
    } else if (phase === "letGo") header("🔌 Pull the plug", "drag the old song off to the left");
    else header("🎚 Landing the mix…");
  }

  function status(now) {
    if (phase === "choose") return "🎵 Choose the next song";
    if (phase === "drop") return plan.style === "echo" ? `🌊 Echo out in ${clock(plan.cue1 - now)}` : `✋ Grab the drop in ${clock(plan.cue1 - now)}`;
    if (phase === "letGo") return "🔌 Pull the plug";
    return "🎚 You're mixing";
  }

  function draw() {
    requestAnimationFrame(draw);
    const now = performance.now();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * scale)) canvas.width = Math.round(width * scale);
    if (canvas.height !== Math.round(height * scale)) canvas.height = Math.round(height * scale);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    // No camera frames for a second (camera off): nothing to coach.
    const live = now - lastUpdate < 1000;
    const active = live && phase !== "idle" && plan;
    upNext.setStatus(active ? status(now) : null);
    if (!live) return;
    if (active) {
      if (phase === "choose") drawChoose(now);
      else drawMix(now);
    }
    if (score.moves) {
      const combo = score.combo > 1 ? ` · combo ×${score.combo}` : "";
      text(`Perfect ${score.perfect}/${score.moves}${combo}`, width - 14, orbRadius() * 0.7, { size: orbRadius() * 0.3, weight: 900, align: "right" });
    }
    drawEffects(now);
    cursors();
  }

  // Speed, filter and volume hold still while a hand is at an orb, and for the whole mix.
  function holdControls() {
    const atOrb =
      grab ||
      (phase === "choose" && (choices.some((_, index) => near(at(layout.choices[index]))) || counting.fistSince)) ||
      (phase === "drop" && plan?.style === "blend" && near(at(layout.dropFrom)));
    const want = Boolean(atOrb) || ["starting", "bringIn", "letGo", "closing"].includes(phase);
    if (want !== held) {
      held = want;
      queue.holdControls(want);
    }
  }

  requestAnimationFrame(draw);
  return {
    update(input, now) {
      update(input, now);
      holdControls();
    },
    // For debugging and tests: where the coach is.
    state: () => ({ phase, style: plan?.style ?? null, cue1: plan?.cue1 ?? null, cue2: plan?.cue2 ?? null, progress: { ...progress }, score: { ...score } }),
  };
}

function addStyles() {
  if (document.getElementById("djCoach-styles")) return;
  const style = document.createElement("style");
  style.id = "djCoach-styles";
  style.textContent = ".maestro { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }";
  document.head.append(style);
}
