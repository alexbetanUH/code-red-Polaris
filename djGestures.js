// Hand gestures that steer the AI DJ (queue.js), on top of the page's own controls:
//
//   ✋ swipe   an open hand sweeps sideways across the frame → mix into the next song now
//   🤘 horns   held for a moment → more energy (the DJ re-picks and says so)
//   ✌️ peace   held for a moment → less energy
//
// The page calls update() every frame with the hands it tracks (index.html's hand
// objects: wristX 0–1 across the mirrored frame, open 0–1, pinched, pose). The right
// hand is best for these: an open right hand just means "filter open", while the left
// one also sets the speed.

const swipeDistance = 0.25; // share of the frame width an open hand must sweep…
const swipeMs = 450; // …within this long
const swipeOpen = 0.6; // how open the hand must stay while sweeping (0 = fist, 1 = flat)
const poseHoldMs = 700; // a pose must be held this long
const swipeCooldownMs = 1500;
const energyCooldownMs = 5000;

export function createDjGestures(queue, { onGesture = () => {} } = {}) {
  const sides = {
    left: { trail: [], pose: null, poseSince: 0 },
    right: { trail: [], pose: null, poseSince: 0 },
  };
  let nextSwipe = 0;
  let nextEnergy = 0;

  function swiped(side, hand, now) {
    const { trail } = side;
    if (!hand || hand.pinched || hand.open < swipeOpen) {
      trail.length = 0; // the sweep has to be one open-handed motion
      return false;
    }
    trail.push({ x: hand.wristX, now });
    while (trail.length && now - trail[0].now > swipeMs) trail.shift();
    const moved = hand.wristX - trail[0].x;
    if (Math.abs(moved) < swipeDistance) return false;
    trail.length = 0;
    return true;
  }

  // The pose a hand has held for poseHoldMs, or null.
  function heldPose(side, hand, now) {
    const pose = hand?.pose ?? null;
    if (pose !== side.pose) {
      side.pose = pose;
      side.poseSince = now;
      return null;
    }
    return pose && now - side.poseSince >= poseHoldMs ? pose : null;
  }

  return {
    update(hands, now) {
      for (const name of ["left", "right"]) {
        const side = sides[name];
        const hand = hands[name] ?? null;
        if (swiped(side, hand, now) && now >= nextSwipe) {
          nextSwipe = now + swipeCooldownMs;
          onGesture(queue.mixNow() ? "swipe" : "swipe-nothing");
        }
        const pose = heldPose(side, hand, now);
        if (pose && now >= nextEnergy && (pose.includes("horns") || pose.includes("peace"))) {
          nextEnergy = now + energyCooldownMs;
          const up = pose.includes("horns");
          queue.shiftEnergy(up ? "up" : "down");
          onGesture(up ? "hype" : "chill");
        }
      }
    },
  };
}
