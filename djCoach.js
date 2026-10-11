// The AI DJ's coach: it lays out the moves for the next mix like a rhythm game, timed to
// the beat, and your hands perform the mix. The AI picks the song, keeps it beat-synced
// and decides where in the music the mix belongs; you bring it in and let the old one go.
//
// When the two songs' tempos match (a blend):
//   1. ✋↑ raise your right hand on the cue → the next song comes in on the downbeat, and
//      from then on your right hand's height is its volume (its bass stays cut for now).
//      Raising it earlier (up to 8 bars before the cue) starts the mix early.
//   2. ✋↓ lower your left hand on the cue → the bass lines swap on the downbeat, and
//      your left hand's height is the old song's volume. All the way down ends the mix.
// When they don't, the AI echoes the old song out by itself (no move).
//
// Raising means from low to high: a right hand still up from the last mix has to come
// down first. Miss a cue by more than a bar, or stall, and the AI does that part for you. Hitting
// moves within a beat of the cue counts as PERFECT, within two as GOOD.
//
// The page calls update() every camera frame with its hands (index.html's hand objects:
// height 0 at the bottom to 1 at the top, open 0 fist to 1 flat, pinched). Pinching hands never trigger moves, so the pinch controls
// (filter, and speed between mixes) keep working. While the hands perform a mix the master
// volume and the speed hold still (lowering an open left hand would otherwise speed it up).

const raiseAt = 0.6; // hand height that counts as "up"
const lowerAt = 0.4; // ...and "down"
const levelBottom = 0.2; // hand heights from here (silent)…
const levelTop = 0.8; // …to here (full) set a song's volume
const moveOpen = 0.5; // a hand must be at least this open to make a move
const perfectBeats = 1;
const goodBeats = 2;
const missBars = 1; // a move this late is done by the AI instead
const gapBars = { short: 2, full: 4 }; // between bringing the next song in and letting the old one go
const finishBars = 2; // the AI eases a mix home over this long
const stallBars = 6; // after "let go" starts, the hands get this long to finish
const earlyBars = 8; // the right hand can start a mix this early
const laneBeats = 16; // the move track shows this far ahead
const planEveryMs = 100;

const level = (height) => Math.max(0, Math.min(1, (height - levelBottom) / (levelTop - levelBottom)));

export function createDjCoach(queue, upNext) {
  let phase = "idle"; // idle → cued → starting → bringIn → letGo → closing → idle
  let plan = null; // { item, style, cue1, cue2, beatMs, barMs } (times in performance.now() ms)
  let plannedAt = 0;
  let controls = null; // transitions.js hand-mix controls while a hand mix runs
  let letGoAt = 0;
  let levels = { in: 0, out: 1 };
  let rightArmed = false; // the right hand was down since the last move (so raising it is deliberate)
  const score = { perfect: 0, moves: 0 };

  const canvas = document.createElement("canvas");
  canvas.className = "coach-track";
  const hint = document.createElement("div");
  hint.className = "coach-hint";
  const root = document.createElement("div");
  root.className = "coach";
  root.hidden = true;
  root.append(canvas, hint);
  upNext.slot.append(root);
  addStyles();

  function rate(now, cue, beatMs) {
    const off = Math.abs(now - cue) / beatMs;
    score.moves += 1;
    if (off <= perfectBeats) {
      score.perfect += 1;
      upNext.flash("PERFECT ✨");
    } else if (off <= goodBeats) {
      upNext.flash("GOOD 👍");
    } else {
      upNext.flash("OK");
    }
  }
  function aiCovers(message) {
    score.moves += 1;
    upNext.flash(message);
  }

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
    if (next.style === "blend") {
      const gap = next.short ? gapBars.short : gapBars.full;
      const cue1 = onDownbeat(now + next.secondsToOut * 1000 - (gap + finishBars) * barMs);
      plan = { item: next.item, style: "blend", cue1, cue2: cue1 + gap * barMs, beatMs, barMs };
    } else {
      plan = { item: next.item, style: "echo", cue1: onDownbeat(now + next.secondsToMix * 1000), cue2: null, beatMs, barMs };
    }
  }

  const canMove = (hand) => hand && !hand.pinched && hand.open >= moveOpen;

  function startHandMix(now, cued) {
    phase = "starting";
    const { barMs, beatMs } = plan;
    const gap = plan.cue2 - plan.cue1;
    if (cued) rate(now, plan.cue1, beatMs);
    else upNext.flash("YOUR CALL 🎛");
    queue.startHandMix().then((started) => {
      if (!started) {
        phase = "idle"; // it couldn't be a hand mix after all (the AI mixed it instead)
        return;
      }
      controls = started;
      levels = { in: 0, out: 1 };
      queue.holdControls(true);
      const comesIn = performance.now() + started.startsIn * 1000;
      plan = { ...plan, cue2: comesIn + gap, barMs, beatMs };
      phase = "bringIn";
    });
  }

  function aiFinish(message) {
    controls.finish((finishBars * plan.barMs) / 1000);
    phase = "closing";
    if (message) aiCovers(message);
  }

  function update(hands, now) {
    queue.coachPing();
    const { left, right } = hands;
    if (right && right.height < lowerAt) rightArmed = true;

    if (phase === "idle" || phase === "cued") {
      refreshPlan(now);
      phase = plan ? "cued" : "idle";
      if (!plan) return;
      const { cue1, beatMs, barMs } = plan;
      if (plan.style === "blend") {
        const inWindow = now >= cue1 - goodBeats * beatMs;
        const early = now >= cue1 - earlyBars * barMs;
        if (rightArmed && canMove(right) && right.height >= raiseAt && (inWindow || early)) {
          rightArmed = false;
          startHandMix(now, inWindow);
          return;
        }
      } else if (now >= cue1 && queue.mixNow()) {
        // Tempos too far apart to blend by hand: the AI echoes it out on the cue.
        upNext.flash("Echo out 🌊");
        phase = "idle";
        plan = null;
        return;
      }
      if (now > cue1 + missBars * barMs && queue.mixNow()) {
        aiCovers("AI covered it 🤖");
        phase = "idle";
        plan = null;
      }
      return;
    }

    if (phase === "starting") return;

    if (!controls || controls.done) {
      // Finished, or cut short by a skip or pause.
      phase = "idle";
      controls = null;
      plan = null;
      queue.holdControls(false);
      return;
    }
    if (phase === "closing") return;

    if (right) {
      levels.in = level(right.height);
      controls.setIncoming(levels.in);
    }
    const { cue2, beatMs, barMs } = plan;
    if (phase === "bringIn") {
      if (now >= cue2 - perfectBeats * beatMs && canMove(left) && left.height <= lowerAt) {
        rate(now, cue2, beatMs);
        controls.swapBass();
        letGoAt = now;
        phase = "letGo";
      } else if (now > cue2 + missBars * barMs) {
        aiFinish("AI finished it 🤖");
      }
      return;
    }
    // letGo: the left hand fades the old song out.
    if (left) {
      levels.out = level(left.height);
      controls.setOutgoing(levels.out);
    }
    if (levels.out <= 0.05) {
      controls.finish(plan.barMs / 1000);
      phase = "closing";
      upNext.flash("Clean mix 🔥");
    } else if (now > letGoAt + stallBars * barMs) {
      aiFinish("AI finished it 🤖");
    }
  }

  // ---- the move track -------------------------------------------------------------

  function cuePill(context, x, y, text, color, room) {
    context.font = "700 13px Nunito, system-ui, sans-serif";
    const width = Math.max(40, Math.min(context.measureText(text).width + 18, room));
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(x, y - 13, width, 26, 13);
    context.fill();
    context.fillStyle = "#fff";
    context.save();
    context.beginPath();
    context.rect(x + 6, y - 13, width - 12, 26);
    context.clip();
    context.fillText(text, x + 9, y + 4.5);
    context.restore();
  }

  function meter(context, x, y, width, value, color, label) {
    context.fillStyle = "rgba(0,0,0,.08)";
    context.beginPath();
    context.roundRect(x, y - 5, width, 10, 5);
    context.fill();
    context.fillStyle = color;
    context.beginPath();
    context.roundRect(x, y - 5, Math.max(10, width * value), 10, 5);
    context.fill();
    context.font = "700 11px Nunito, system-ui, sans-serif";
    context.fillStyle = color;
    context.fillText(label, x, y - 9);
  }

  // What the strip under the track says while the coach runs.
  function status(now) {
    if (phase === "cued") {
      const seconds = Math.max(0, (plan.cue1 - now) / 1000);
      const whole = Math.ceil(seconds);
      const clock = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
      if (plan.style === "echo") return `🌊 Echo out in ${clock}`;
      return seconds > 0.3 ? `✋↑ Right hand up in ${clock}` : "✋↑ Right hand up now!";
    }
    if (phase === "starting") return "🎚 Here it comes…";
    if (phase === "closing") return "🎚 Landing the mix…";
    return "🎚 You're mixing";
  }

  function draw() {
    requestAnimationFrame(draw);
    const now = performance.now();
    const active = phase !== "idle" && plan;
    root.hidden = !active;
    upNext.setStatus(active ? status(now) : null);
    if (!active) return;
    const style = getComputedStyle(root);
    const colors = {
      text: style.getPropertyValue("--text").trim() || "#333",
      muted: style.getPropertyValue("--muted").trim() || "#888",
      left: style.getPropertyValue("--left").trim() || "#1e95e3",
      right: style.getPropertyValue("--right").trim() || "#5cb82c",
      accent: style.getPropertyValue("--between").trim() || "#f5861f",
    };
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const scale = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * scale)) canvas.width = Math.round(width * scale);
    if (canvas.height !== Math.round(height * scale)) canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);

    const { cue1, cue2, beatMs } = plan;
    const mid = height / 2;
    const name = plan.item.title.split(" - ").slice(1).join(" - ") || plan.item.title;

    if (phase === "letGo" || phase === "closing") {
      // Both songs' levels: the left hand's (old song) and the right hand's (new song).
      meter(context, 12, mid + 6, width / 2 - 24, levels.out, colors.left, "◀ OLD SONG · left hand");
      meter(context, width / 2 + 12, mid + 6, width / 2 - 24, levels.in, colors.right, `${name} · right hand ▶`);
      hint.textContent = phase === "closing" ? "Landing the mix…" : "Lower your left hand all the way to let the old song go";
      return;
    }

    // Beat ticks scroll toward the hit line; cues sit on their beats.
    const hitX = width * 0.14;
    const span = laneBeats * beatMs;
    const xAt = (time) => hitX + ((time - now) / span) * (width - hitX);
    for (let k = Math.ceil((now - cue1) / beatMs - 1); ; k += 1) {
      const time = cue1 + k * beatMs;
      const x = xAt(time);
      if (x > width) break;
      if (x < 0) continue;
      const downbeat = ((k % 4) + 4) % 4 === 0;
      context.fillStyle = downbeat ? colors.muted : "rgba(0,0,0,.12)";
      context.fillRect(x, downbeat ? 6 : 14, downbeat ? 2 : 1, height - (downbeat ? 12 : 28));
    }
    context.fillStyle = colors.accent;
    context.fillRect(hitX - 1.5, 2, 3, height - 4);

    const cues = [];
    if (plan.style === "echo") cues.push([cue1, `🌊 AI echoes out · ${name}`, colors.accent]);
    else {
      if (phase === "cued") cues.push([cue1, `✋↑ Right hand up · ${name}`, colors.right]);
      cues.push([cue2, "✋↓ Left hand down", colors.left]);
    }
    cues.forEach(([time, text, color], index) => {
      const x = Math.max(hitX, xAt(time));
      const nextX = index + 1 < cues.length ? xAt(cues[index + 1][0]) : width;
      if (x < width) cuePill(context, x, mid, text, color, Math.min(nextX, width) - x - 6);
    });

    // Countdown on the last four beats before the next cue.
    const nextCue = cues.find(([time]) => time >= now - beatMs)?.[0];
    if (nextCue !== undefined) {
      const beats = Math.ceil((nextCue - now) / beatMs);
      if (beats >= 1 && beats <= 4) {
        context.font = "900 22px Nunito, system-ui, sans-serif";
        context.fillStyle = colors.accent;
        context.fillText(String(beats), 6, mid + 8);
      }
    }
    if (phase === "bringIn") {
      meter(context, width * 0.62, height - 8, width * 0.34, levels.in, colors.right, "");
      hint.textContent = `Your right hand is ${name}'s volume`;
    } else {
      hint.textContent =
        plan.style === "echo"
          ? "These two don't blend: the AI echoes this one out"
          : rightArmed
            ? `Raise your right hand on the cue (or a little early) · Perfect ${score.perfect}/${score.moves}`
            : "Lower your right hand to get ready";
    }
  }
  requestAnimationFrame(draw);

  return { update };
}

function addStyles() {
  if (document.getElementById("djCoach-styles")) return;
  const style = document.createElement("style");
  style.id = "djCoach-styles";
  style.textContent = `
.coach {
  width: 100%; margin-bottom: 8px; padding: 6px 8px 4px; border-radius: 14px;
  background: var(--bg); border: 1px solid var(--border); box-shadow: 0 6px 20px rgba(0, 0, 0, .18);
}
.coach[hidden] { display: none; }
.coach-track { display: block; width: 100%; height: 44px; }
.coach-hint { font-size: 11px; color: var(--muted); text-align: center; margin-top: 2px; }`;
  document.head.append(style);
}
