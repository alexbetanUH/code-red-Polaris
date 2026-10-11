// The AI DJ's start screen, over the camera view: what to do (four small pictures),
// then the camera and a check that both hands show up, then the first song loads,
// then 3, 2, 1 and the set starts on "Go".
//
//   createStartScreen(stage, {
//     startCamera: async () => true,          // false if the camera didn't start
//     handSeen: (side) => bool,               // "left" / "right" in view right now
//     prepare: async () => {},                // get the first song ready (no sound yet)
//     begin: () => {},                        // start the set, on "Go"
//   });

const handCheckMs = 800; // both hands in view this long counts as checked

// Tiny pictures for the four moves, in the page's colors.
const pictures = {
  hit: `<svg viewBox="0 0 64 48" aria-hidden="true">
    <circle cx="32" cy="24" r="17" fill="none" stroke="#5cb82c" stroke-width="2" stroke-dasharray="4 3"/>
    <circle cx="32" cy="24" r="11" fill="rgba(255,255,255,.7)" stroke="#5cb82c" stroke-width="3"/>
    <path d="M27 31v-9m3 9V18m3 13V19m3 12v-8m-12 6c-2-1-3 1-2 3l3 4h10l2-5" fill="none" stroke="#3a2412" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`,
  slide: `<svg viewBox="0 0 64 48" aria-hidden="true">
    <path d="M12 34 52 14" stroke="rgba(92,184,44,.35)" stroke-width="12" stroke-linecap="round"/>
    <path d="M12 34 52 14" stroke="#5cb82c" stroke-width="2" stroke-dasharray="4 3"/>
    <circle cx="32" cy="24" r="7" fill="#fff" stroke="#5cb82c" stroke-width="3"/>
    <path d="M42 30l6-3m-2 6 4-6" stroke="#3a2412" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`,
  pick: `<svg viewBox="0 0 64 48" aria-hidden="true">
    <rect x="4" y="8" width="34" height="13" rx="3" fill="#ffffe1" stroke="#1b1b1b"/>
    <rect x="4" y="27" width="34" height="13" rx="3" fill="#ffffe1" stroke="#1b1b1b"/>
    <path d="M8 14h20M8 33h16" stroke="#1b1b1b" stroke-width="1.6"/>
    <circle cx="50" cy="14" r="7" fill="rgba(255,255,255,.7)" stroke="#f5861f" stroke-width="3"/>
    <circle cx="50" cy="33" r="7" fill="rgba(255,255,255,.7)" stroke="#f5861f" stroke-width="3"/>
  </svg>`,
  pause: `<svg viewBox="0 0 64 48" aria-hidden="true">
    <rect x="8" y="16" width="18" height="18" rx="6" fill="#1e95e3"/>
    <rect x="38" y="16" width="18" height="18" rx="6" fill="#5cb82c"/>
    <path d="M12 22h10m-10 5h10M42 22h10m-10 5h10" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`,
};

export function createStartScreen(stage, { startCamera, handSeen, prepare, begin }) {
  addStyles();
  const root = document.createElement("div");
  root.className = "djStart";
  stage.append(root);

  const show = (html) => {
    root.innerHTML = html;
    return root;
  };

  function intro() {
    show(`
      <div class="djStart-panel">
        <h1>AI DJ</h1>
        <p>Play a DJ set with your hands. The AI picks the songs, you do the mixes.</p>
        <ol class="djStart-moves">
          <li>${pictures.hit}<span>Palm in the circle as the ring closes</span></li>
          <li>${pictures.slide}<span>Follow the slider to mix songs</span></li>
          <li>${pictures.pick}<span>Touch a song to play it next</span></li>
          <li>${pictures.pause}<span>Both fists for a second: pause</span></li>
        </ol>
        <button class="lime" type="button">Start</button>
      </div>`);
    root.querySelector("button").addEventListener("click", cameraStep, { once: true });
  }

  async function cameraStep() {
    show(`<div class="djStart-panel"><p class="djStart-status">Starting the camera…</p></div>`);
    if (!(await startCamera())) {
      show(`
        <div class="djStart-panel">
          <p class="djStart-status">The camera didn't start. Allow camera access for this page, then try again.</p>
          <button class="lime" type="button">Try again</button>
        </div>`);
      root.querySelector("button").addEventListener("click", cameraStep, { once: true });
      return;
    }
    handCheck();
  }

  // Both hands in view for a moment, each lighting up as it's seen.
  function handCheck() {
    show(`
      <div class="djStart-panel">
        <p class="djStart-status">Hold both hands up so the camera can see them</p>
        <div class="djStart-hands"><span data-side="left">Left</span><span data-side="right">Right</span></div>
        <button class="secondary djStart-skip" type="button">Skip</button>
      </div>`);
    let bothSince = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      loading();
    };
    root.querySelector(".djStart-skip").addEventListener("click", finish, { once: true });
    const check = () => {
      if (done) return;
      const now = performance.now();
      let both = true;
      for (const side of ["left", "right"]) {
        const seen = handSeen(side);
        both &&= seen;
        root.querySelector(`[data-side="${side}"]`)?.classList.toggle("seen", seen);
      }
      bothSince = both ? bothSince || now : 0;
      if (bothSince && now - bothSince >= handCheckMs) finish();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  async function loading() {
    show(`<div class="djStart-panel"><p class="djStart-status">Getting the music ready…</p></div>`);
    await prepare();
    countdown();
  }

  function countdown() {
    let count = 3;
    const tick = () => {
      show(`<div class="djStart-count">${count > 0 ? count : "Go!"}</div>`);
      if (count === 0) {
        begin();
        setTimeout(() => root.remove(), 700);
        return;
      }
      count -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

  intro();
}

function addStyles() {
  if (document.getElementById("djStart-styles")) return;
  const style = document.createElement("style");
  style.id = "djStart-styles";
  style.textContent = `
.djStart {
  position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 16px;
  background: rgba(255, 246, 236, 0.55); backdrop-filter: blur(3px);
}
.djStart-panel {
  width: min(560px, 100%); padding: 22px 26px 24px; border-radius: 18px; text-align: center;
  background: rgba(255, 255, 255, 0.93); border: 2px solid #fff;
  box-shadow: 0 14px 40px rgba(150, 70, 20, 0.22);
}
.djStart h1 {
  margin: 0 0 4px; font: italic bold 46px/1 "Trebuchet MS", "Segoe UI", sans-serif; color: #2b6fb8;
  text-shadow: 0 2px 0 #fff, 0 3px 6px rgba(30, 80, 140, 0.25);
}
.djStart p { margin: 0 auto 14px; max-width: 46ch; font-size: 15px; line-height: 1.45; color: var(--text); }
.djStart-moves { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 0 0 18px; padding: 0; list-style: none; }
.djStart-moves li { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: 12.5px; line-height: 1.3; color: var(--muted); }
.djStart-moves svg { width: 92px; height: 69px; padding: 4px; border-radius: 10px; background: #f3f8fd; border: 1px solid #c9dbee; }
.djStart button { min-width: 150px; font-size: 17px; }
.djStart-status { font-weight: 700; }
.djStart-hands { display: flex; justify-content: center; gap: 14px; margin: 0 0 16px; }
.djStart-hands span {
  width: 92px; padding: 14px 0; border-radius: 12px; font: bold 15px Tahoma, "Segoe UI", sans-serif;
  color: #8a96a3; background: #f1f3f5; border: 2px dashed #c3ccd5; transition: background 0.15s, color 0.15s;
}
.djStart-hands span.seen[data-side="left"] { color: #fff; background: #1e95e3; border: 2px solid #1e95e3; }
.djStart-hands span.seen[data-side="right"] { color: #fff; background: #5cb82c; border: 2px solid #5cb82c; }
.djStart-skip { min-width: 0; font-size: 13px; }
.djStart-count {
  font: italic bold min(30vh, 220px)/1 "Trebuchet MS", "Segoe UI", sans-serif; color: #fff;
  -webkit-text-stroke: 6px rgba(20, 30, 45, 0.85); paint-order: stroke fill;
  animation: djStart-pop 1s ease-out both;
}
@keyframes djStart-pop { from { transform: scale(1.35); opacity: 0; } 25% { transform: scale(1); opacity: 1; } to { opacity: 0.85; } }
@media (prefers-reduced-motion: reduce) { .djStart-count { animation: none; } }
@media (max-width: 560px) { .djStart-moves { grid-template-columns: repeat(2, 1fr); } }`;
  document.head.append(style);
}
