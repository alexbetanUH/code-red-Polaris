// AirDeck Club: the 3D disco behind the app (Three.js + bloom).
//
//   const club = createClub(container, {
//     audio: () => ({ wave, playing, speed, freq, volume }),  // read every frame
//     camera: canvas,          // drawn on the LED wall while cameraOn() is true
//     cameraOn: () => bool,
//   });
//   club.bloom = 0.85;         // glow strength; club.setLights(false) hides lasers/beams
//
// Purely visual: it never changes the audio or the hand tracking.

import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/addons/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';

export function createClub(container, { audio = () => null, camera: cam = null, cameraOn = () => false } = {}) {
  // Palette and tempo. SECTIONS = color pairs that rotate every 16 beats.
  const CYAN = '#19e6ff', PINK = '#ff2e9a', VIOLET = '#9b5cff', GOLD = '#ffd23f';
  const BPM = 124;
  const SECTIONS = [[CYAN, PINK], [VIOLET, GOLD], [PINK, CYAN], [GOLD, VIOLET]].map(p => p.map(c => new THREE.Color(c)));

  // Renderer, scene, fog and bloom. Pixel ratio and bloom size are kept low
  // so hand tracking keeps most of the GPU.
  const renderer = new THREE.WebGLRenderer({antialias: true});
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#05050c');
  scene.fog = new THREE.FogExp2('#08061c', 0.05);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.2;

  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 60);
  camera.position.set(0, 1.85, 4);
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.85, 0.45, 0.85);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // Helpers: canvas textures, neon materials and a seeded random so the room
  // looks the same on every load.
  function canvasTex(w, h, draw, flipY = true) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    draw(g, w, h);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = flipY;
    return {c, g, tex};
  }
  const neon = (color, k = 2.2) => new THREE.MeshBasicMaterial({color: new THREE.Color(color).multiplyScalar(k)});
  function tube(len, color, k) {
    return new THREE.Mesh(new THREE.CapsuleGeometry(0.018, len, 4, 8).rotateZ(Math.PI / 2), neon(color, k));
  }
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const hash = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

  // Animated / static textures: deck equalizer, vinyl records, MIDI keys,
  // the LED wall behind the booth and the scrolling booth sign.
  const eq = canvasTex(512, 128, () => {});
  function drawEq(beat, kick) {
    const g = eq.g;
    g.fillStyle = '#000'; g.fillRect(0, 0, 512, 128);
    for (let i = 0; i < 32; i++) {
      const v = (0.25 + 0.75 * Math.abs(Math.sin(i * 0.55 + beat * 0.8))) * (0.6 + kick * 0.4);
      for (let k = 0; k < Math.round(v * 10); k++) {
        g.fillStyle = k > 7 ? '#ffffff' : `rgba(255,255,255,${0.35 + k * 0.06})`;
        g.fillRect(i * 16 + 3, 120 - k * 12, 10, 8);
      }
    }
    eq.tex.needsUpdate = true;
  }

  function vinylTex(color) {
    return canvasTex(512, 512, (g, w) => {
      const c = w / 2;
      g.fillStyle = '#000'; g.fillRect(0, 0, w, w);
      g.fillStyle = '#0b0b10'; g.beginPath(); g.arc(c, c, c, 0, 6.28); g.fill();
      for (let r = 100; r < c - 6; r += 5) {
        g.strokeStyle = `rgba(255,255,255,${0.03 + (r % 15 === 0 ? 0.04 : 0)})`;
        g.lineWidth = 1.5; g.beginPath(); g.arc(c, c, r, 0, 6.28); g.stroke();
      }
      const sh = g.createLinearGradient(0, 0, w, w);
      sh.addColorStop(0.35, 'rgba(255,255,255,0)'); sh.addColorStop(0.5, 'rgba(255,255,255,.12)'); sh.addColorStop(0.65, 'rgba(255,255,255,0)');
      g.fillStyle = sh; g.beginPath(); g.arc(c, c, c - 4, 0, 6.28); g.fill();
      g.fillStyle = color; g.beginPath(); g.arc(c, c, 86, 0, 6.28); g.fill();
      g.fillStyle = '#05050c'; g.beginPath(); g.arc(c, c, 8, 0, 6.28); g.fill();
      g.fillStyle = '#05050c'; g.textAlign = 'center';
      g.font = '900 30px "Arial Black",sans-serif'; g.fillText('AIRDECK', c, c - 26);
      g.font = '700 18px "Consolas",monospace'; g.fillText('SIDE A · 124', c, c + 44);
    });
  }
  const VINYLS = [vinylTex(CYAN), vinylTex(PINK), vinylTex(GOLD), vinylTex(VIOLET)];

  const keys = canvasTex(512, 128, (g, w, h) => {
    g.fillStyle = '#e9e9f2'; g.fillRect(0, 0, w, h);
    for (let i = 0; i <= 21; i++) { g.fillStyle = '#5a5a70'; g.fillRect(i * w / 21, 0, 2, h); }
    for (let i = 0; i < 21; i++) {
      if ([0, 1, 3, 4, 5].includes(i % 7)) { g.fillStyle = '#101018'; g.fillRect((i + 0.65) * w / 21, 0, w / 21 * 0.7, h * 0.6); }
    }
  });

  const led = canvasTex(1024, 512, () => {});
  const ledDots = canvasTex(1024, 512, (g, w, h) => {
    g.fillStyle = 'rgba(0,0,0,.45)';
    for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 3);
    for (let x = 0; x < w; x += 8) g.fillRect(x, 0, 3, h);
  });
  function drawLed(beat, kick, cols) {
    const g = led.g, W = 1024, H = 512;
    const a = '#' + cols[0].getHexString(), b = '#' + cols[1].getHexString();
    g.fillStyle = '#05030f'; g.fillRect(0, 0, W, H);
    if (cam && cameraOn()) { drawLedCamera(g, W, H, kick, a, b); return; }
    g.save(); g.translate(W / 2, H / 2);
    for (let i = 0; i < 9; i++) {
      const s = ((i + (beat * 0.5) % 1) / 9) ** 2 * 900;
      g.strokeStyle = i % 2 ? a : b;
      g.globalAlpha = Math.min(1, s / 300) * 0.8;
      g.lineWidth = 6 + s * 0.02;
      g.save(); g.rotate(Math.PI / 4 + beat * 0.05); g.strokeRect(-s / 2, -s / 2, s, s); g.restore();
    }
    g.globalAlpha = 1;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const sc = 1 + kick * 0.08;
    g.scale(sc, sc);
    g.font = '900 120px "Arial Black",sans-serif';
    g.shadowBlur = 30;
    g.shadowColor = CYAN; g.fillStyle = CYAN; g.fillText('AIR', -170, -10);
    g.shadowColor = PINK; g.fillStyle = PINK; g.fillText('DECK', 150, -10);
    g.font = '800 30px "Consolas",monospace';
    g.shadowColor = GOLD; g.fillStyle = GOLD;
    g.fillText('★  HANDS UP  ★  124 BPM  ★', 0, 80);
    g.restore();
    g.shadowBlur = 0;
    for (let i = 0; i < 48; i++) {
      const v = (0.35 + 0.65 * Math.abs(Math.sin(i * 0.7 + beat * 1.3))) * (0.5 + kick * 0.5) * (1 - Math.abs(i - 23.5) / 30);
      g.fillStyle = i % 2 ? a : b;
      g.fillRect(i * (W / 48) + 3, H - v * 140, W / 48 - 6, v * 140);
    }
    g.drawImage(ledDots.c, 0, 0);
    led.tex.needsUpdate = true;
  }

  function drawLedCamera(g, W, H, kick, a, b) {
    const s = Math.max(W / cam.width, H / cam.height);
    const w = cam.width * s, h = cam.height * s;
    g.drawImage(cam, (W - w) / 2, (H - h) / 2, w, h);
    const grad = g.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0, a); grad.addColorStop(1, b);
    g.globalAlpha = 0.12 + kick * 0.08;
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.globalAlpha = 1;
    g.fillStyle = '#ff2e4d'; g.beginPath(); g.arc(34, 34, 9, 0, 6.28); g.fill();
    g.font = '800 24px "Consolas",monospace'; g.fillStyle = '#fff'; g.fillText('LIVE', 52, 43);
    g.drawImage(ledDots.c, 0, 0);
    led.tex.needsUpdate = true;
  }

  const booth = canvasTex(1024, 128, () => {});
  function drawBooth(t, kick, cols) {
    const g = booth.g;
    g.fillStyle = '#05030f'; g.fillRect(0, 0, 1024, 128);
    g.font = '900 64px "Arial Black",sans-serif'; g.textBaseline = 'middle';
    const msg = 'AIRDECK CLUB  ✦  MOVE YOUR HANDS  ✦  ';
    const mw = g.measureText(msg).width, x0 = -((t * 160) % mw);
    g.shadowBlur = 16;
    for (let x = x0, i = 0; x < 1024; x += mw, i++) {
      const c = '#' + cols[i % 2].getHexString();
      g.shadowColor = g.fillStyle = c;
      g.fillText(msg, x, 66);
    }
    g.shadowBlur = 0;
    g.fillStyle = `rgba(255,255,255,${kick * 0.15})`; g.fillRect(0, 0, 1024, 128);
    g.drawImage(ledDots.c, 0, 0, 1024, 128, 0, 0, 1024, 128);
    booth.tex.needsUpdate = true;
  }

  // Blacklight carpet and wall posters
  const carpet = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#0a0820'; g.fillRect(0, 0, w, h);
    const cols = [CYAN, PINK, VIOLET, GOLD];
    g.lineWidth = 5; g.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const x = rnd() * w, y = rnd() * h, c = cols[i % 4], k = rnd();
      g.strokeStyle = g.fillStyle = c;
      g.globalAlpha = 0.55;
      g.save(); g.translate(x, y); g.rotate(rnd() * 6.28);
      if (k < 0.3) { g.beginPath(); g.arc(0, 0, 10 + rnd() * 10, 0, 6.28); g.stroke(); }
      else if (k < 0.55) { g.beginPath(); g.moveTo(0, -14); g.lineTo(13, 10); g.lineTo(-13, 10); g.closePath(); g.stroke(); }
      else if (k < 0.85) { g.beginPath(); g.moveTo(-24, 0); for (let s = 1; s <= 4; s++) g.quadraticCurveTo(-24 + s * 12 - 6, s % 2 ? -12 : 12, -24 + s * 12, 0); g.stroke(); }
      else { g.beginPath(); g.arc(0, 0, 4, 0, 6.28); g.fill(); }
      g.restore();
    }
    g.globalAlpha = 1;
  });
  carpet.tex.wrapS = carpet.tex.wrapT = THREE.RepeatWrapping;
  carpet.tex.anisotropy = 8;

  function poster(text, sub, color) {
    return canvasTex(512, 720, (g, w, h) => {
      g.fillStyle = '#0c0a22'; g.fillRect(0, 0, w, h);
      g.strokeStyle = color; g.lineWidth = 10; g.strokeRect(24, 24, w - 48, h - 48);
      g.textAlign = 'center'; g.fillStyle = color;
      g.shadowColor = color; g.shadowBlur = 20;
      g.font = '900 92px "Arial Black",sans-serif'; g.fillText(text, w / 2, 330);
      g.font = '700 38px "Consolas",monospace'; g.fillText(sub, w / 2, 420);
      for (let i = 0; i < 5; i++) { g.globalAlpha = 0.3; g.fillRect(80 + i * 75, 520, 40, 40 + i * 25); }
    });
  }

  // Moving-head light beam: additive cone that fades with distance
  const beamGeo = new THREE.ConeGeometry(0.55, 8, 24, 1, true).translate(0, -4, 0);
  function beamMat() {
    return new THREE.ShaderMaterial({
      uniforms: {uColor: {value: new THREE.Color(CYAN)}, uI: {value: 1}},
      vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uI; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main(){ float f = pow(abs(dot(vN, vV)), 2.);
          float a = pow(vUv.y, 2.2) * f * 0.3 * uI; gl_FragColor = vec4(uColor * a, 1.); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  // The club: walls, LED dance floor, stage, LED wall, DJ booth, speakers,
  // light truss, lasers, disco ball, posters and haze.
  const room = new THREE.Group();
  scene.add(room);
  const FX = {beams: [], lasers: [], speakers: [], colorLights: [], fxGroup: new THREE.Group()};
  room.add(FX.fxGroup);

  function buildClub(cab) {
    const {w, d} = cab;
    const N = 5, STEP = w + 0.4;
    const ROW_X = 2.5 + d / 2;
    const WALL_X = ROW_X + d / 2 + 0.25;
    const Z0 = 1.2, ZN = Z0 - (N - 1) * STEP;
    const STAGE_Z = ZN - 1.1;
    const BACK_Z = STAGE_Z - 2.9, FRONT_Z = 6.5, H = 4.2, STAGE_Y = 0.45;
    const LEN = FRONT_Z - BACK_Z, MIDZ = (FRONT_Z + BACK_Z) / 2;

    carpet.tex.repeat.set(WALL_X * 2 / 1.6, LEN / 1.6);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(WALL_X * 2, LEN),
      new THREE.MeshStandardMaterial({color: '#ffffff', map: carpet.tex, emissive: '#ffffff', emissiveMap: carpet.tex, emissiveIntensity: 0.3, roughness: 0.95}));
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = MIDZ;
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(WALL_X * 2, LEN), new THREE.MeshStandardMaterial({color: '#07060e', roughness: 1}));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, H, MIDZ);
    room.add(floor, ceil);
    const wallMat = new THREE.MeshStandardMaterial({color: '#0d0c1c', roughness: 0.85});
    for (const s of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(LEN, H), wallMat);
      wall.rotation.y = -s * Math.PI / 2;
      wall.position.set(s * WALL_X, H / 2, MIDZ);
      room.add(wall);
      for (const y of [0.04, 2.7]) {
        const t = tube(LEN - 0.2, s < 0 ? CYAN : PINK, y < 1 ? 1.6 : 2.4);
        t.rotation.y = Math.PI / 2;
        t.position.set(s * (WALL_X - 0.03), y, MIDZ);
        room.add(t);
      }
    }
    const back = new THREE.Mesh(new THREE.PlaneGeometry(WALL_X * 2, H), wallMat);
    back.position.set(0, H / 2, BACK_Z);
    const front = back.clone();
    front.rotation.y = Math.PI;
    front.position.z = FRONT_Z;
    room.add(back, front);

    const TILE = 0.5, TX = 9, TZ = Math.floor((Z0 + 2.2 - STAGE_Z) / TILE);
    const tiles = new THREE.InstancedMesh(new THREE.BoxGeometry(TILE - 0.03, 0.04, TILE - 0.03), new THREE.MeshBasicMaterial({color: '#ffffff'}), TX * TZ);
    const m4 = new THREE.Matrix4();
    for (let ix = 0; ix < TX; ix++) for (let iz = 0; iz < TZ; iz++) {
      m4.makeTranslation((ix - (TX - 1) / 2) * TILE, 0.02, STAGE_Z + TILE / 2 + iz * TILE + 0.05);
      tiles.setMatrixAt(ix * TZ + iz, m4);
      tiles.setColorAt(ix * TZ + iz, new THREE.Color(0));
    }
    room.add(tiles);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(TX * TILE + 0.12, 0.03, TZ * TILE + 0.12), new THREE.MeshStandardMaterial({color: '#1a1830', metalness: 0.8, roughness: 0.3}));
    frame.position.set(0, 0.012, STAGE_Z + TZ * TILE / 2 + 0.05);
    room.add(frame);

    const stageMat = new THREE.MeshStandardMaterial({color: '#0e0c1d', roughness: 0.5, metalness: 0.4});
    const stage = new THREE.Mesh(new THREE.BoxGeometry(WALL_X * 2, STAGE_Y, STAGE_Z - BACK_Z), stageMat);
    stage.position.set(0, STAGE_Y / 2, (STAGE_Z + BACK_Z) / 2);
    const lip = tube(WALL_X * 2 - 0.1, CYAN, 2.4);
    lip.position.set(0, STAGE_Y, STAGE_Z + 0.01);
    room.add(stage, lip);

    const ledMat = new THREE.MeshBasicMaterial({map: led.tex, color: new THREE.Color(1.5, 1.5, 1.5)});
    const ledMesh = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 3.2), ledMat);
    ledMesh.position.set(0, STAGE_Y + 0.25 + 1.6, BACK_Z + 0.04);
    room.add(ledMesh);

    const BOOTH_Z = STAGE_Z - 0.8;
    const desk = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.0, 0.8), stageMat);
    desk.position.set(0, STAGE_Y + 0.5, BOOTH_Z);
    const deskFront = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 0.34), new THREE.MeshBasicMaterial({map: booth.tex, color: new THREE.Color(1.6, 1.6, 1.6)}));
    deskFront.position.set(0, STAGE_Y + 0.55, BOOTH_Z + 0.405);
    const deskTop = tube(2.8, PINK, 2.2);
    deskTop.position.set(0, STAGE_Y + 1.0, BOOTH_Z + 0.4);
    room.add(desk, deskFront, deskTop);
    const gearMat = new THREE.MeshStandardMaterial({color: '#1b1a2c', metalness: 0.6, roughness: 0.35});
    const platters = [];
    for (const s of [-1, 1]) {
      const deck = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.55), gearMat);
      deck.position.set(s * 0.82, STAGE_Y + 1.04, BOOTH_Z);
      const plat = new THREE.Group();
      plat.position.set(s * 0.82, STAGE_Y + 1.09, BOOTH_Z);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.015, 40), new THREE.MeshStandardMaterial({color: '#0a0a10', roughness: 0.25, metalness: 0.3}));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.008, 6, 48).rotateX(Math.PI / 2), neon(s < 0 ? CYAN : PINK, 2.4));
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.18), neon(GOLD, 2));
      mark.position.set(0, 0.012, 0.09);
      plat.add(disc, ring, mark);
      room.add(deck, plat);
      platters.push(plat);
    }
    const mixer = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 0.5), gearMat);
    mixer.position.set(0, STAGE_Y + 1.05, BOOTH_Z);
    room.add(mixer);
    const knobs = [];
    for (let i = 0; i < 8; i++) {
      const k = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), neon(i % 2 ? CYAN : PINK, 1.5));
      k.position.set((i % 4 - 1.5) * 0.08, STAGE_Y + 1.11, BOOTH_Z - 0.12 + Math.floor(i / 4) * 0.12);
      room.add(k);
      knobs.push(k);
    }
    const laptop = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.22), neon('#c9d4ff', 0.9));
    laptop.position.set(0.3, STAGE_Y + 1.2, BOOTH_Z - 0.3);
    laptop.rotation.set(-0.2, Math.PI, 0);
    room.add(laptop);

    for (const s of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.85, 0.7), stageMat);
        box.position.set(s * 2.45, STAGE_Y + 0.43 + k * 0.87, STAGE_Z - 0.55);
        room.add(box);
        const cone = new THREE.Group();
        cone.position.set(s * 2.45, STAGE_Y + 0.43 + k * 0.87, STAGE_Z - 0.19);
        const woofer = new THREE.Mesh(new THREE.CircleGeometry(0.3, 32), new THREE.MeshStandardMaterial({color: '#141322', roughness: 0.7}));
        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), gearMat);
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.012, 6, 40), neon(s < 0 ? CYAN : PINK, 2.2));
        cone.add(woofer, dome, halo);
        room.add(cone);
        FX.speakers.push(cone);
      }
    }

    const trussMat = new THREE.MeshStandardMaterial({color: '#2a2840', metalness: 0.9, roughness: 0.3});
    for (const tz of [STAGE_Z - 1.3, STAGE_Z + 2.2]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(WALL_X * 2, 0.12, 0.12), trussMat);
      bar.position.set(0, H - 0.35, tz);
      room.add(bar);
      for (let i = 0; i < 4; i++) {
        const head = new THREE.Group();
        head.position.set((i - 1.5) * 1.25, H - 0.5, tz);
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.2, 12), trussMat);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.1, 16).rotateX(Math.PI / 2), neon('#ffffff', 2));
        lens.position.y = -0.101;
        const mat = beamMat();
        const beam = new THREE.Mesh(beamGeo, mat);
        head.add(body, lens, beam);
        FX.fxGroup.add(head);
        FX.beams.push({head, mat, lens, i, row: tz});
      }
    }

    const laserGeo = new THREE.BoxGeometry(0.005, 0.005, 10).translate(0, 0, 5);
    for (const s of [-1, 1]) {
      const em = new THREE.Group();
      em.position.set(s * 2.45, STAGE_Y + 1.95, STAGE_Z - 0.4);
      for (let i = 0; i < 6; i++) {
        const mat = new THREE.MeshBasicMaterial({color: '#ffffff', transparent: true, blending: THREE.AdditiveBlending, depthWrite: false});
        const l = new THREE.Mesh(laserGeo, mat);
        em.add(l);
        FX.lasers.push({l, mat, i, s});
      }
      FX.fxGroup.add(em);
    }

    const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 3),
      new THREE.MeshStandardMaterial({color: '#ffffff', metalness: 1, roughness: 0.12, flatShading: true, envMapIntensity: 6, emissive: '#3a3a55'}));
    ball.position.set(0, H - 0.95, STAGE_Z + 1.0);
    const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.6), trussMat);
    wire.position.set(0, H - 0.33, STAGE_Z + 1.0);
    room.add(ball, wire);
    const SP = 260, sp = new Float32Array(SP * 3);
    for (let i = 0; i < SP; i++) {
      const v = new THREE.Vector3(rnd() - 0.5, rnd() - 0.7, rnd() - 0.5).normalize().multiplyScalar(2.5 + rnd() * 4);
      sp.set([v.x, v.y, v.z], i * 3);
    }
    const dot = canvasTex(32, 32, (g) => {
      const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, 32, 32);
    });
    const sparkGeo = new THREE.BufferGeometry();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const sparkles = new THREE.Points(sparkGeo, new THREE.PointsMaterial({size: 0.06, map: dot.tex, color: '#e8e6ff', transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending}));
    sparkles.position.copy(ball.position);
    FX.fxGroup.add(sparkles);

    const posters = [poster('HANDS', 'UP!', CYAN), poster('124', 'BPM', PINK), poster('DROP', 'THE BASS', GOLD), poster('MIX', 'LIVE', VIOLET)];
    posters.forEach((p, i) => {
      const s = i % 2 ? 1 : -1;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.87), new THREE.MeshBasicMaterial({map: p.tex, color: new THREE.Color(1.1, 1.1, 1.1)}));
      m.rotation.y = -s * Math.PI / 2;
      m.position.set(s * (WALL_X - 0.02), 2.0, Z0 - STEP * (1 + Math.floor(i / 2) * 2));
      room.add(m);
    });

    for (let i = 0; i < 3; i++) {
      for (const s of [-1, 1]) {
        const l = new THREE.PointLight(s < 0 ? CYAN : PINK, 3, 6, 1.4);
        l.position.set(s * 1.4, 2.8, STAGE_Z - 0.5 + i * 2.6);
        FX.colorLights.push(l);
        room.add(l);
      }
    }

    const P = 500, pos = new Float32Array(P * 3);
    for (let i = 0; i < P; i++) pos.set([(rnd() - 0.5) * WALL_X * 2, rnd() * H, BACK_Z + rnd() * LEN], i * 3);
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({size: 0.03, map: dot.tex, color: '#b9b4ff', transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending}));
    room.add(dust);

    return {STEP, ROW_X, WALL_X, Z0, N, STAGE_Z, BACK_Z, FRONT_Z, STAGE_Y, BOOTH_Z, H, tiles, TX, TZ, platters, knobs, ball, sparkles, dust};
  }

  // Music decks along both walls: "deck" (2 CDJs + mixer) and "pads"
  // (8×8 pad grid + keyboard). Pads of every deck share one InstancedMesh.
  const deckMat = new THREE.MeshStandardMaterial({color: '#0e0c1d', roughness: 0.5, metalness: 0.4});
  const gear = new THREE.MeshStandardMaterial({color: '#1b1a2c', metalness: 0.6, roughness: 0.35});
  const ST = {jogs: [], faders: [], padStations: []};

  function makeStation(type, a, b) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 0.7), deckMat);
    body.position.y = 0.5;
    const front = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 0.3),
      new THREE.MeshBasicMaterial({map: eq.tex, color: new THREE.Color(a).multiplyScalar(1.5)}));
    front.position.set(0, 0.62, 0.351);
    const top = tube(1.2, a, 2.4);
    top.position.set(0, 1.0, 0.35);
    g.add(body, front, top);
    for (const x of [-0.6, 0.6]) {
      const post = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.95, 4, 8), neon(b, 2));
      post.position.set(x, 0.5, 0.35);
      g.add(post);
    }

    if (type === 'deck') {
      for (const s of [-1, 1]) {
        const cdj = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.44), gear);
        cdj.position.set(s * 0.37, 1.03, 0);
        const jog = new THREE.Group();
        jog.position.set(s * 0.37, 1.07, 0.06);
        const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.02, 36), new THREE.MeshStandardMaterial({color: '#0a0a10', roughness: 0.25, metalness: 0.5}));
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.007, 6, 40).rotateX(Math.PI / 2), neon(s < 0 ? a : b, 2.4));
        const mark = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.1), neon(GOLD, 2));
        mark.position.set(0, 0.012, 0.05);
        jog.add(plate, ring, mark);
        const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.07), neon(s < 0 ? a : b, 1.1));
        screen.position.set(s * 0.37, 1.075, -0.15);
        screen.rotation.x = -Math.PI / 2;
        g.add(cdj, jog, screen);
        ST.jogs.push({jog, dir: s});
      }
      const mixer = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.07, 0.44), gear);
      mixer.position.set(0, 1.035, 0);
      g.add(mixer);
      for (let i = 0; i < 3; i++) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.025, 0.04), neon(i === 1 ? GOLD : a, 1.8));
        f.position.set((i - 1) * 0.07, 1.08, 0.08);
        g.add(f);
        ST.faders.push({f, i});
      }
      for (let i = 0; i < 6; i++) {
        const k = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.02, 10), neon(i % 2 ? a : b, 1.3));
        k.position.set((i % 3 - 1) * 0.07, 1.08, -0.15 + Math.floor(i / 3) * 0.08);
        g.add(k);
      }
    } else {
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 0.46), gear);
      pad.position.set(-0.3, 1.02, 0);
      const kb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.3), gear);
      kb.position.set(0.3, 1.025, 0.02);
      const kbKeys = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.14), new THREE.MeshStandardMaterial({map: keys.tex, roughness: 0.4, emissive: '#ffffff', emissiveMap: keys.tex, emissiveIntensity: 0.15}));
      kbKeys.rotation.x = -Math.PI / 2;
      kbKeys.position.set(0.3, 1.052, 0.08);
      g.add(pad, kb, kbKeys);
      for (let i = 0; i < 8; i++) {
        const k = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.02, 10), neon(i % 2 ? a : b, 1.3));
        k.position.set(0.3 + (i - 3.5) * 0.055, 1.06, -0.08);
        g.add(k);
      }
      ST.padStations.push(g);
    }
    return g;
  }

  let pads = null;
  function buildPads() {
    const n = ST.padStations.length * 64;
    pads = new THREE.InstancedMesh(new THREE.BoxGeometry(0.044, 0.014, 0.044), new THREE.MeshBasicMaterial({color: '#ffffff'}), n);
    const m = new THREE.Matrix4(), local = new THREE.Matrix4();
    ST.padStations.forEach((st, si) => {
      st.updateMatrixWorld(true);
      for (let i = 0; i < 64; i++) {
        local.makeTranslation(-0.3 + (i % 8 - 3.5) * 0.052, 1.045, (Math.floor(i / 8) - 3.5) * 0.052);
        m.multiplyMatrices(st.matrixWorld, local);
        pads.setMatrixAt(si * 64 + i, m);
        pads.setColorAt(si * 64 + i, new THREE.Color(0));
      }
    });
    room.add(pads);
  }

  function makeVinyl(tex) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.48, 64),
      new THREE.MeshStandardMaterial({map: tex.tex, emissive: '#ffffff', emissiveMap: tex.tex, emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.3}));
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.01, 6, 64), neon('#ffffff', 1.2));
    g.add(disc, halo);
    g.disc = disc;
    return g;
  }

  let L = null;
  const vinyls = [];
  {
    L = buildClub({w: 1.2, d: 0.7});
    const PAL = [[CYAN, PINK], [PINK, CYAN], [VIOLET, GOLD], [GOLD, VIOLET]];
    let k = 0;
    for (let i = 0; i < L.N; i++) {
      const z = L.Z0 - i * L.STEP;
      for (const s of [-1, 1]) {
        const [a, b] = PAL[k % PAL.length];
        const st = makeStation((i + (s > 0 ? 1 : 0)) % 2 ? 'pads' : 'deck', a, b);
        st.position.set(s * L.ROW_X, 0, z);
        st.rotation.y = -s * Math.PI / 2;
        room.add(st);
        if (i % 2 === 0) {
          const v = makeVinyl(VINYLS[k % VINYLS.length]);
          v.position.set(s * (L.WALL_X - 0.02), 2.0, z);
          v.rotation.y = -s * Math.PI / 2;
          room.add(v);
          vinyls.push(v);
        }
        k++;
      }
    }
    buildPads();
  }

  const api = {
    bloom: 0.85,
    setLights(on) {
      FX.fxGroup.visible = on;
      FX.colorLights.forEach(l => l.visible = on);
    },
  };

  // ---- Loop: audio + hands drive the lights -------------------------------
  // Without music the club idles at 124 BPM. With music, the kick comes from
  // onsets in the real waveform, the left-hand speed scales the light tempo,
  // and the right-hand low-pass filter dims the room (muffled = dark).
  const tmpC = new THREE.Color(), dark = new THREE.Color('#06050f');
  const camGoal = new THREE.Vector3(), lookGoal = new THREE.Vector3(), look = new THREE.Vector3(0, 1.6, -6);
  const mouse = new THREE.Vector2();
  addEventListener('pointermove', e => mouse.set(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5));
  const clock = new THREE.Clock();
  let beat = 0, hit = 0, avg = 0, lastHit = 0;

  function readAudio(t, dt) {
    const a = audio() || {};
    const wave = a.playing ? a.wave : null;
    let level = 0;
    if (wave) {
      let sum = 0;
      for (let i = 0; i < wave.length; i += 4) sum += wave[i] * wave[i];
      level = Math.sqrt(sum / (wave.length / 4));
      avg += (level - avg) * Math.min(1, dt * 2);
      if (level > avg * 1.3 && level > 0.02 && t - lastHit > 0.22) { hit = 1; lastHit = t; }
      hit *= Math.exp(-dt * 6);
    }
    const speed = a.speed ?? 1;
    beat += dt * BPM / 60 * speed;
    const kick = wave ? hit : Math.exp(-(beat % 1) * 5) * 0.6;
    const open = a.freq ? Math.min(1, Math.log(a.freq / 150) / Math.log(10000 / 150)) : 1;
    return {kick, open: Math.max(0, open), volume: a.volume ?? 0.8};
  }

  function animateFloor(beat, kick, cols, open) {
    const {tiles, TX, TZ} = L;
    const mode = Math.floor(beat / 16) % 4, b = Math.floor(beat / 2);
    for (let ix = 0; ix < TX; ix++) for (let iz = 0; iz < TZ; iz++) {
      let v = 0, c = cols[(ix + iz) % 2];
      if (mode === 0) {
        const dist = Math.hypot(ix - (TX - 1) / 2, iz * 0.9);
        v = Math.max(0, 1 - Math.abs(dist - (beat % 4) * 2.5) * 0.9);
        c = cols[Math.floor(beat / 4) % 2];
      } else if (mode === 1) {
        v = (ix + iz + b) % 2 ? 0.15 : 0.6 + kick * 0.4;
      } else if (mode === 2) {
        v = (iz + b) % 4 === 0 ? 1 : 0.05;
        c = cols[ix % 2];
      } else {
        v = hash(ix * 31 + iz, Math.floor(beat / 2)) > 0.72 ? 1 : 0.05;
      }
      v *= 0.3 + 0.7 * open;
      tmpC.copy(dark).lerp(c, Math.min(1, v)).multiplyScalar(0.6 + v * 1.6);
      tiles.setColorAt(ix * TZ + iz, tmpC);
    }
    tiles.instanceColor.needsUpdate = true;
  }

  function animateLights(t, beat, kick, cols, open) {
    const drop = Math.floor(beat / 16) % 2 === 1 && open > 0.6;
    for (const b of FX.beams) {
      const ph = b.i * 0.8 + (b.row < L.STAGE_Z ? 0 : 2);
      b.head.rotation.x = Math.sin(t * 0.3 + ph) * 0.5 + 0.25;
      b.head.rotation.z = Math.sin(t * 0.2 + ph * 1.3) * 0.65;
      b.mat.uniforms.uColor.value.copy(cols[b.i % 2]);
      b.mat.uniforms.uI.value = (0.8 + kick * 0.4) * (0.25 + 0.75 * open);
      b.lens.material.color.copy(cols[b.i % 2]).multiplyScalar(2.5);
    }
    for (const z of FX.lasers) {
      z.l.visible = drop;
      const fan = (z.i - 2.5) * 0.12 + Math.sin(t * 0.35) * 0.25;
      z.l.rotation.set(-0.1 + Math.sin(t * 0.5 + z.i * 0.4) * 0.05, -z.s * 0.25 + fan * 0.7, 0);
      z.mat.color.copy(cols[(z.i + (z.s > 0 ? 1 : 0)) % 2]).multiplyScalar(1.8);
    }
    for (const s of FX.speakers) s.scale.setScalar(1 + kick * 0.08);
    FX.colorLights.forEach((l, i) => {
      l.color.copy(cols[i % 2]);
      l.intensity = (2.5 + kick * 1.5) * (0.3 + 0.7 * open);
    });
  }

  function animateDecks(t, beat, kick, cols, dt, speed) {
    ST.jogs.forEach(j => j.jog.rotation.y -= dt * 3.3 * j.dir * speed);
    ST.faders.forEach(({f, i}) => f.position.z = 0.08 + Math.sin(t * 0.4 + i * 1.7) * 0.07);
    vinyls.forEach((v, i) => v.disc.rotation.z -= dt * (0.5 + (i % 2) * 0.15) * speed);
    const col = Math.floor(beat * 2) % 8, step = Math.floor(beat);
    for (let si = 0; si < ST.padStations.length; si++) {
      for (let i = 0; i < 64; i++) {
        const x = i % 8, y = Math.floor(i / 8);
        let v = 0.06, c = cols[(x + y + si) % 2];
        if (x === (col + si * 3) % 8) v = 0.9;
        else if (hash(si * 64 + i, step) > 0.82) { v = 0.7; c = cols[(si + 1) % 2]; }
        tmpC.copy(dark).lerp(c, v).multiplyScalar(0.5 + v * 1.8);
        pads.setColorAt(si * 64 + i, tmpC);
      }
    }
    pads.instanceColor.needsUpdate = true;
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
  });

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
    const {kick, open, volume} = readAudio(t, dt);
    const speed = (audio() || {}).speed ?? 1;
    const cols = SECTIONS[Math.floor(beat / 16) % SECTIONS.length];
    bloom.strength = api.bloom * (0.7 + 0.4 * volume);
    drawEq(beat, kick);
    drawLed(beat, kick, cols);
    drawBooth(t, kick, cols);
    animateFloor(beat, kick, cols, open);
    animateLights(t, beat, kick, cols, open);
    animateDecks(t, beat, kick, cols, dt, speed);
    L.platters.forEach(pl => pl.rotation.y -= dt * 3.5 * speed);
    L.knobs.forEach((k, i) => k.visible = hash(i, Math.floor(beat * 2)) > 0.3);
    L.ball.rotation.y += dt * 0.2;
    L.sparkles.rotation.y += dt * 0.2;
    L.dust.position.y = Math.sin(t * 0.2) * 0.08;

    // Slow walk from the entrance to the edge of the dance floor, facing the booth.
    const u = 0.5 - 0.5 * Math.cos(t * 0.05);
    const z = THREE.MathUtils.lerp(L.FRONT_Z - 1.4, L.STAGE_Z + 2.6, u);
    camGoal.set(Math.sin(t * 0.13) * 0.9 + mouse.x * 0.6, 2.15 + Math.sin(t * 0.17) * 0.08 - mouse.y * 0.25, z);
    lookGoal.set(Math.sin(t * 0.09) * 0.6 + mouse.x * 0.8, L.STAGE_Y + 1.35 - mouse.y * 0.3, L.BOOTH_Z);
    camera.position.lerp(camGoal, 1 - Math.exp(-dt * 2));
    look.lerp(lookGoal, 1 - Math.exp(-dt * 2));
    camera.lookAt(look);
    composer.render();
  });

  return api;
}
