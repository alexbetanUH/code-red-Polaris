// AirDeck audio engine: looping track(s) with speed, filter frequency, volume,
// an effects chain, and five song slots with a beat-aware crossfade.
// Graph: source(s) → low-pass filter → fx (dry + wet effects) → gain → analyser → speakers
// The analyser sits after the gain so the waveform reflects what you hear.
// The old single-track API (loadUrl/play/...) uses `source`; slot songs use two
// internal "voices" (each: source → highpass → lowpass → fade gain → shared filter).

const RAMP = 0.05; // seconds; smooths parameter changes so they never click

export class Deck {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.rate = 1;
    this.offset = 0;        // position in the track (seconds) when paused
    this.anchorTime = 0;    // ctx.currentTime when offset was last updated
    this.playing = false;
    // effects: settings live here so they can be set before the context exists
    this.fx = {
      reverb:   { on: false, amount: 0.5 },
      echo:     { on: false, amount: 0.5 },
      bitcrush: { on: false, amount: 0.5 },
      flanger:  { on: false, amount: 0.5 },
    };
    this.slots = [null, null, null, null, null]; // {buffer, title, bpm, phase}
    this.voices = [];
    this.cur = null;    // voice index currently playing a slot song
    this.trans = null;  // running transition
    this._bass = 0;
  }

  // AudioContext must be created after a user click (browser autoplay rules).
  ensureContext() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 20000;
    this.filter.Q.value = 1;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 0.8;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buildFx();
    this.gain.connect(this.analyser).connect(this.ctx.destination);
    this.waveData = new Float32Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.buildVoices();
  }

  // ---------- effects ----------
  // Every effect is a parallel wet branch; the dry path is always open.
  // Switching an effect only changes its wet gain, so nothing is rebuilt.
  buildFx() {
    const c = this.ctx;
    const fxIn = c.createGain();
    const fxOut = c.createGain();
    this.filter.connect(fxIn);
    fxIn.connect(fxOut); // dry
    fxOut.connect(this.gain);
    this.wet = {};
    const addWet = (name, node) => {
      const w = c.createGain();
      w.gain.value = 0;
      node.connect(w).connect(fxOut);
      this.wet[name] = w;
    };

    // reverb: noise that fades out over ~2.5 s
    const verb = c.createConvolver();
    const len = Math.floor(c.sampleRate * 2.5);
    const imp = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = imp.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    }
    verb.buffer = imp;
    fxIn.connect(verb);
    addWet("reverb", verb);

    // echo: 3/8 s delay with feedback
    const delay = c.createDelay(1);
    delay.delayTime.value = 0.375;
    const fb = c.createGain();
    fb.gain.value = 0.45;
    fxIn.connect(delay);
    delay.connect(fb).connect(delay);
    addWet("echo", delay);

    // bitcrush: stepped waveshaper curve (amount = fewer steps)
    this.crusher = c.createWaveShaper();
    this.crusher.oversample = "none";
    fxIn.connect(this.crusher);
    addWet("bitcrush", this.crusher);
    this.updateCrush();

    // flanger: ~5 ms delay swept by a slow LFO, with feedback
    const fl = c.createDelay(0.05);
    fl.delayTime.value = 0.005;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.3;
    const depth = c.createGain();
    depth.gain.value = 0.003;
    lfo.connect(depth).connect(fl.delayTime);
    lfo.start();
    const flfb = c.createGain();
    flfb.gain.value = 0.5;
    fxIn.connect(fl);
    fl.connect(flfb).connect(fl);
    addWet("flanger", fl);

    for (const name in this.fx) this.applyEffect(name);
  }

  updateCrush() {
    if (!this.crusher) return;
    const steps = Math.max(3, Math.round(64 - this.fx.bitcrush.amount * 58));
    if (steps === this.crushSteps) return;   // the curve only changes when the step count does
    this.crushSteps = steps;
    const n = 4096;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.round(x * steps) / steps;
    }
    this.crusher.curve = curve;
  }

  applyEffect(name) {
    const f = this.fx[name];
    if (!f || !this.ctx) return;
    this.wet[name].gain.setTargetAtTime(f.on ? f.amount : 0, this.ctx.currentTime, RAMP);
  }

  setEffect(name, on) {
    if (!this.fx[name]) return;
    this.fx[name].on = !!on;
    this.applyEffect(name);
  }

  toggleEffect(name) {
    if (!this.fx[name]) return false;
    this.setEffect(name, !this.fx[name].on);
    return this.fx[name].on;
  }

  // Wet level 0..1.
  setEffectAmount(name, v) {
    const f = this.fx[name];
    if (!f) return;
    if (!Number.isFinite(v)) return;
    f.amount = Math.min(1, Math.max(0, v));
    if (name === "bitcrush") this.updateCrush();
    this.applyEffect(name);
  }

  effectState() {
    const out = {};
    for (const k in this.fx) out[k] = { on: this.fx[k].on, amount: this.fx[k].amount };
    return out;
  }

  clearEffects() {
    for (const k in this.fx) this.setEffect(k, false);
  }

  // ---------- slot songs and transitions ----------
  buildVoices() {
    const c = this.ctx;
    // shared echo tail used while a song fades out
    const tail = c.createDelay(1);
    tail.delayTime.value = 0.375;
    const tfb = c.createGain();
    tfb.gain.value = 0.55;
    tail.connect(tfb).connect(tail);
    tail.connect(this.filter);
    this.voices = [0, 1].map(() => {
      const hp = c.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 20;
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 20000;
      const g = c.createGain();
      g.gain.value = 0;
      const send = c.createGain();
      send.gain.value = 0;
      hp.connect(lp).connect(g).connect(this.filter);
      lp.connect(send).connect(tail);
      return { hp, lp, g, send, src: null, slot: null, offset: 0, anchor: 0 };
    });
  }

  async loadSlot(i, input) {
    if (!(i >= 0 && i < 5)) throw new Error("slot must be 0..4");
    this.ensureContext();
    let data, title = `Song ${i + 1}`;
    if (typeof input === "string") {
      const res = await fetch(input);
      if (!res.ok) throw new Error(`could not fetch audio (${res.status})`);
      data = await res.arrayBuffer();
      let last = input.split("?")[0].split("/").pop() || "";
      try { last = decodeURIComponent(last); } catch {}
      if (last) title = last.replace(/\.[a-z0-9]{2,4}$/i, "");
    } else if (input instanceof ArrayBuffer) {
      data = input;
    } else {
      data = await input.arrayBuffer();
      if (input.name) title = input.name.replace(/\.[a-z0-9]{2,4}$/i, "");
    }
    const buffer = await this.ctx.decodeAudioData(data);
    if (this.voices.some((v) => v.src && v.slot === i)) this.stopSlots();   // don't leave a voice playing a replaced song
    const est = estimateBpm(buffer);
    this.slots[i] = { buffer, title, bpm: est ? est.bpm : null, phase: est ? est.phase : 0 };
    return this.slotInfo(i);
  }

  slotInfo(i) {
    const s = this.slots[i];
    return s ? { loaded: true, title: s.title, bpm: s.bpm } : { loaded: false, title: "", bpm: null };
  }

  get currentSlot() {
    this.tick();
    const t = this.trans;
    if (t) return t.mashup || this.progress(t) >= 0.5 ? this.voices[t.to].slot : this.voices[t.from].slot;
    return this.cur === null ? null : this.voices[this.cur].slot;
  }

  voicePos(v) {
    const dur = this.slots[v.slot].buffer.duration;
    const el = Math.max(0, this.ctx.currentTime - v.anchor);
    return (v.offset + el * this.rate) % dur;
  }

  startVoice(v, slot, when, offset) {
    this.killVoice(v);
    const src = this.ctx.createBufferSource();
    src.buffer = this.slots[slot].buffer;
    src.loop = true;
    src.playbackRate.value = this.rate;
    src.connect(v.hp);
    src.start(when, offset % src.buffer.duration);
    v.src = src;
    v.slot = slot;
    v.offset = offset;
    v.anchor = when;
  }

  // Stop a voice's source after a short fade (the voice can be reused straight away).
  killVoice(v, fade = 0.05) {
    if (!v.src) { v.slot = null; return; }
    const now = this.ctx.currentTime;
    v.g.gain.cancelScheduledValues(now);
    v.g.gain.setValueAtTime(v.g.gain.value, now);
    v.g.gain.linearRampToValueAtTime(0, now + fade);
    v.src.stop(now + fade + 0.01);
    v.src = null;
    v.slot = null;
  }

  // Put a voice's filters and echo send back to neutral.
  neutral(v, secs = 0.3) {
    const now = this.ctx.currentTime;
    for (const [p, val] of [[v.hp.frequency, 20], [v.lp.frequency, 20000], [v.send.gain, 0]]) {
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(val, now + secs);
    }
  }

  progress(t) {
    if (t.manual) return t.p;
    if (t.mashup) return t.frozen;
    return Math.min(1, Math.max(0, (this.ctx.currentTime - t.t0) / t.dur));
  }

  // Finish a transition once it is over (called lazily and by a timer).
  tick() {
    const t = this.trans;
    if (t && t.manual && this.ctx) return this.tickManual(t);
    if (!t || t.mashup || !this.ctx) return;
    if (this.ctx.currentTime < t.t0 + t.dur) return;
    this.killVoice(this.voices[t.from], 0.02);
    this.neutral(this.voices[t.to], 0.05);
    this.cur = t.to;
    this.trans = null;
  }

  // ---- Hand-driven (manual) transitions ----------------------------------------------
  // pickSlot(i, { manual: true }) queues the new song (starts on the next beat, silent).
  // The caller then moves `setBlend(0..1)` (crossfade) and `setSweep(0..1)` (the old song's
  // high-pass sweep + echo). `autoBlend(secs)` finishes the blend on its own.
  setBlend(p) {
    const t = this.trans;
    if (!t || !t.manual || !Number.isFinite(p)) return;
    t.p = Math.min(1, Math.max(0, p));
    t.auto = null;
    this.applyBlend(t);
  }

  setSweep(v) {
    const t = this.trans;
    if (!t || !t.manual || !Number.isFinite(v)) return;
    t.sweep = Math.min(1, Math.max(0, v));
    this.applyBlend(t);
  }

  autoBlend(secs = 5) {
    const t = this.trans;
    if (!t || !t.manual || t.auto) return;
    // the clock starts at the beat if the new song is still queued, and never runs shorter than 0.1 s
    t.auto = { from: t.p, t0: Math.max(this.ctx.currentTime, t.t0), dur: Math.max(0.1, secs || 5) };
  }

  // Equal-power crossfade; outgoing gets a rising high-pass + echo, incoming a lowpass that opens.
  applyBlend(t) {
    const now = this.ctx.currentTime, tc = 0.04;
    const vo = this.voices[t.from], vi = this.voices[t.to];
    const p = now < t.t0 ? 0 : t.p;   // the new song hasn't started yet: keep the old one at full volume
    vo.g.gain.setTargetAtTime(Math.cos(p * Math.PI / 2), now, tc);
    vi.g.gain.setTargetAtTime(Math.sin(p * Math.PI / 2), now, tc);
    vo.hp.frequency.setTargetAtTime(20 * Math.pow(200, t.sweep), now, tc);
    vo.send.gain.setTargetAtTime(0.7 * t.sweep, now, tc);
    vi.lp.frequency.setTargetAtTime(400 * Math.pow(50, t.p), now, tc);
  }

  tickManual(t) {
    if (this.ctx.currentTime < t.t0) { this.applyBlend(t); return; }   // waiting for the beat
    if (t.auto) {
      const el = (this.ctx.currentTime - t.auto.t0) / t.auto.dur;
      t.p = Math.min(1, t.auto.from + (1 - t.auto.from) * el);
      t.sweep = Math.sin(Math.PI * t.p) * 0.8;   // a little build in the middle
      this.applyBlend(t);
    }
    if (t.p >= 0.985) this.finishManual(t, 0.3);
  }

  finishManual(t, fade = 0.3) {
    const now = this.ctx.currentTime;
    const vi = this.voices[t.to];
    this.killVoice(this.voices[t.from], fade);
    this.neutral(vi, 0.3);
    vi.g.gain.cancelScheduledValues(now);
    vi.g.gain.setValueAtTime(vi.g.gain.value, now);
    vi.g.gain.linearRampToValueAtTime(1, now + 0.3);
    this.cur = t.to;
    this.trans = null;
  }

  cancelManual(t) {
    const now = this.ctx.currentTime;
    const vo = this.voices[t.from];
    this.killVoice(this.voices[t.to], 0.1);
    this.neutral(vo, 0.3);
    vo.g.gain.cancelScheduledValues(now);
    vo.g.gain.setValueAtTime(vo.g.gain.value, now);
    vo.g.gain.linearRampToValueAtTime(1, now + 0.3);
    this.cur = t.from;
    this.trans = null;
  }

  transitionState() {
    if (!this.ctx) return null;
    this.tick();
    const t = this.trans;
    if (!t) return null;
    return {
      from: this.voices[t.from].slot,
      to: this.voices[t.to].slot,
      progress01: this.progress(t),
      mashup: t.mashup,
      manual: !!t.manual,
      sweep: t.sweep || 0,
      waiting: !!t.manual && this.ctx.currentTime < t.t0,   // queued, waiting for the next beat
      auto: !!(t.manual && t.auto),
    };
  }

  // Start song slot i. Fades from the current song if one is playing.
  // `mashup` = true lets a pick during a transition hold both songs at 50/50.
  // By default a new pick just moves on to the newest song (one song at a time).
  pickSlot(i, { mashup = false, manual = false } = {}) {
    if (!this.ctx || !this.slots[i]) return false;
    this.ctx.resume();
    this.tick();
    const c = this.ctx;
    const now = c.currentTime;
    const A = this.voices[0], B = this.voices[1];

    if (this.trans && this.trans.manual) {
      // a new pick while a hand-driven blend is open: commit it if past halfway, otherwise cancel it
      const t = this.trans;
      if (i === this.voices[t.to].slot) return true;
      if (t.p >= 0.5 && this.ctx.currentTime >= t.t0) this.finishManual(t, 0.15); else this.cancelManual(t);
    }

    if (this.trans) {
      const t = this.trans;
      const vf = this.voices[t.from], vt = this.voices[t.to];
      if (!t.mashup && i === vt.slot) return true;   // already heading there
      if (!t.mashup && mashup) {
        // second pick during a transition: hold both at 50/50
        t.frozen = this.progress(t);
        t.mashup = true;
        clearTimeout(t.timer);
        for (const v of [vf, vt]) {
          this.neutral(v, 0.5);
          v.g.gain.cancelScheduledValues(now);
          v.g.gain.setValueAtTime(v.g.gain.value, now);
          v.g.gain.linearRampToValueAtTime(0.5, now + 0.5);
        }
        return true;
      }
      // pick after a mashup: keep one song and leave the mashup
      if (t.mashup && (i === vf.slot || i === vt.slot)) {
        const keep = i === vt.slot ? t.to : t.from;
        const drop = this.voices[keep === t.to ? t.from : t.to];
        const keeper = this.voices[keep];
        keeper.g.gain.cancelScheduledValues(now);
        keeper.g.gain.setValueAtTime(keeper.g.gain.value, now);
        keeper.g.gain.linearRampToValueAtTime(1, now + 1.5);
        this.killVoice(drop, 1.5);
        this.cur = keep;
        this.trans = null;
        return true;
      }
      // a new pick interrupts the transition (one song at a time)
      clearTimeout(t.timer);
      if (now < t.t0) {
        // it hasn't started yet: cancel it and carry on from the song still playing
        this.killVoice(vt, 0.02);
        this.neutral(vf, 0.1);
        vf.g.gain.cancelScheduledValues(now);   // drop the scheduled fade-out
        vf.g.gain.setValueAtTime(vf.g.gain.value, now);
        vf.g.gain.linearRampToValueAtTime(1, now + 0.1);
        this.cur = t.from;
      } else {
        // already under way: drop the outgoing song, move on from the incoming one
        this.killVoice(vf, 0.05);
        this.cur = t.to;
      }
      this.trans = null;
    }

    if (this.cur === null || !this.voices[this.cur].src) {
      // nothing playing yet: just start it
      const v = this.voices[this.cur === null ? 0 : this.cur];
      this.startVoice(v, i, now + 0.02, 0);
      this.neutral(v, 0.02);
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setValueAtTime(0, now);
      v.g.gain.linearRampToValueAtTime(1, now + 0.1);
      this.cur = this.voices.indexOf(v);
      return true;
    }

    const out = this.cur, inc = 1 - out;
    const vo = this.voices[out], vi = this.voices[inc];
    if (vo.slot === i) return true;

    // when to start and how long: next beat of the outgoing song, ~8 beats
    const so = this.slots[vo.slot], si = this.slots[i];
    let t0 = now, dur = 4;
    if (so.bpm) {
      const period = 60 / so.bpm;
      const p = this.voicePos(vo);
      const n = Math.ceil((p - so.phase) / period);
      let wait = (so.phase + n * period - p) / this.rate;
      if (wait < 0.03) wait += period / this.rate;
      t0 = now + wait;
      dur = (8 * period) / this.rate;
    }
    // start the new song on its own first beat so the beats line up
    this.startVoice(vi, i, t0, si.bpm ? si.phase : 0);

    if (manual) {
      // queued silently; the caller drives the blend with setBlend / setSweep
      for (const p of [vo.hp.frequency, vo.send.gain, vo.g.gain, vi.lp.frequency, vi.hp.frequency, vi.send.gain, vi.g.gain]) {
        p.cancelScheduledValues(now);
      }
      vo.g.gain.setValueAtTime(vo.g.gain.value, now);
      vi.g.gain.setValueAtTime(0, now);
      vi.lp.frequency.setValueAtTime(400, now);
      vi.hp.frequency.setValueAtTime(20, now);
      vi.send.gain.setValueAtTime(0, now);
      this.trans = { from: out, to: inc, t0, dur: 0, manual: true, p: 0, sweep: 0, auto: null, mashup: false, frozen: 0 };
      return true;
    }

    // outgoing: highpass sweep up, echo tail rising, then fade
    for (const p of [vo.hp.frequency, vo.send.gain, vo.g.gain]) {
      p.cancelScheduledValues(now);
    }
    vo.hp.frequency.setValueAtTime(20, t0);
    vo.hp.frequency.exponentialRampToValueAtTime(4000, t0 + dur * 0.9);
    vo.send.gain.setValueAtTime(0, t0);
    vo.send.gain.linearRampToValueAtTime(0.7, t0 + dur * 0.6);
    vo.send.gain.linearRampToValueAtTime(0, t0 + dur);
    const g0 = vo.g.gain.value;   // may be mid-fade if this pick interrupted a transition
    vo.g.gain.setValueAtTime(g0, now);
    vo.g.gain.setValueAtTime(g0, t0 + dur * 0.4);
    vo.g.gain.linearRampToValueAtTime(0, t0 + dur);

    // incoming: fade in while the lowpass opens up
    for (const p of [vi.lp.frequency, vi.hp.frequency, vi.send.gain, vi.g.gain]) {
      p.cancelScheduledValues(now);
    }
    vi.hp.frequency.setValueAtTime(20, now);
    vi.send.gain.setValueAtTime(0, now);
    vi.lp.frequency.setValueAtTime(400, now);
    vi.lp.frequency.exponentialRampToValueAtTime(20000, t0 + dur * 0.8);
    vi.g.gain.setValueAtTime(0, now);
    vi.g.gain.setValueAtTime(0, t0);
    vi.g.gain.linearRampToValueAtTime(1, t0 + dur);

    const t = { from: out, to: inc, t0, dur, mashup: false, frozen: 0 };
    t.timer = setTimeout(() => this.tick(), (t0 + dur - now) * 1000 + 100);
    this.trans = t;
    return true;
  }

  // Stop every slot song (used when the single-song player takes over).
  stopSlots() {
    if (!this.ctx) return;
    clearTimeout(this.trans && this.trans.timer);
    for (const v of this.voices) { this.killVoice(v, 0.05); this.neutral(v, 0.05); }
    this.trans = null;
    this.cur = null;
  }

  // Smoothed low-frequency energy, 0..1 (for visuals).
  bass() {
    if (!this.ctx) return 0;
    this.analyser.getByteFrequencyData(this.freqData);
    const hi = Math.max(2, Math.round(150 / (this.ctx.sampleRate / this.analyser.fftSize)));
    let sum = 0;
    for (let i = 1; i <= hi; i++) sum += this.freqData[i];
    const v = Math.min(1, Math.pow(sum / hi / 255, 1.5) * 1.3);
    this._bass += (v - this._bass) * (v > this._bass ? 0.5 : 0.12);
    return this._bass;
  }

  async loadUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not fetch audio (${res.status})`);
    await this.loadArrayBuffer(await res.arrayBuffer());
  }

  async loadFile(file) {
    await this.loadArrayBuffer(await file.arrayBuffer());
  }

  async loadArrayBuffer(data) {
    this.ensureContext();
    const buffer = await this.ctx.decodeAudioData(data);
    const wasPlaying = this.playing;
    this.stopSource();
    this.buffer = buffer;
    this.offset = 0;
    if (wasPlaying) this.play();
  }

  // Current position in the track, accounting for speed changes.
  position() {
    if (!this.playing) return this.offset;
    return (this.offset + (this.ctx.currentTime - this.anchorTime) * this.rate) % this.buffer.duration;
  }

  play() {
    if (!this.buffer || this.playing) return;
    this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.playbackRate.value = this.rate;
    src.connect(this.filter);
    src.start(0, this.offset % this.buffer.duration);
    this.source = src;
    this.anchorTime = this.ctx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.position() % this.buffer.duration;
    this.stopSource();
  }

  stopSource() {
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
    this.playing = false;
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  // Playback speed (also shifts pitch, like a turntable). 1 = normal.
  setSpeed(rate) {
    if (!Number.isFinite(rate)) return;
    rate = Math.max(0.05, rate);
    if (this.playing) {
      this.offset = this.position();
      this.anchorTime = this.ctx.currentTime;
    }
    if (this.ctx) {
      // fold elapsed time into each slot voice before the speed changes
      const now = this.ctx.currentTime;
      for (const v of this.voices) {
        if (!v.src) continue;
        if (now > v.anchor) { v.offset = this.voicePos(v); v.anchor = now; }
        v.src.playbackRate.setTargetAtTime(rate, now, RAMP);
      }
    }
    this.rate = rate;
    if (this.source) this.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, RAMP);
  }

  // Low-pass cutoff in Hz: low = muffled, 20000 = full sound.
  setFrequency(hz) {
    if (this.ctx && Number.isFinite(hz)) this.filter.frequency.setTargetAtTime(hz, this.ctx.currentTime, RAMP);
  }

  // Volume 0–1.
  setVolume(v) {
    if (this.ctx && Number.isFinite(v)) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, RAMP);
  }

  // Latest audio samples (-1..1), or null before audio starts.
  waveform() {
    if (!this.ctx) return null;
    this.analyser.getFloatTimeDomainData(this.waveData);
    return this.waveData;
  }
}

// Guess the tempo (60-180 BPM) from onset energy autocorrelation.
// Returns {bpm, phase} (phase = time of a beat in seconds, within one beat) or null.
function estimateBpm(buffer) {
  const sr = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const hop = 256;
  const start = Math.floor(Math.min(15, buffer.duration * 0.15) * sr);
  const end = Math.min(buffer.length, start + Math.floor(90 * sr));
  const n = Math.floor((end - start) / hop);
  if (n < 400) return null;
  // energy per frame
  const env = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let e = 0;
    const o = start + k * hop;
    for (let j = 0; j < hop; j++) {
      const x = ch1 ? (ch0[o + j] + ch1[o + j]) * 0.5 : ch0[o + j];
      e += x * x;
    }
    env[k] = Math.sqrt(e / hop);
  }
  // onsets: rise in energy minus a local average
  const on = new Float32Array(n);
  for (let k = 1; k < n; k++) on[k] = Math.max(0, env[k] - env[k - 1]);
  const W = 43;
  let run = 0;
  const flat = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    run += on[k];
    if (k >= W) run -= on[k - W];
    flat[k] = Math.max(0, on[k] - run / Math.min(k + 1, W));
  }
  let e0 = 0;
  for (let k = 0; k < n; k++) e0 += flat[k] * flat[k];
  if (e0 < 1e-9) return null;
  const er = sr / hop;
  const lmin = Math.floor((er * 60) / 180), lmax = Math.ceil((er * 60) / 60);
  const r = new Float32Array(lmax + 2);
  let mean = 0;
  for (let lag = lmin - 1; lag <= lmax + 1; lag++) {
    let s = 0;
    for (let k = 0; k + lag < n; k++) s += flat[k] * flat[k + lag];
    r[lag] = n - lag > 0 ? s / (n - lag) : 0;
  }
  for (let lag = lmin; lag <= lmax; lag++) mean += r[lag];
  mean /= lmax - lmin + 1;
  // best lag, nudged toward 120 BPM so half/double tempos lose ties
  let best = -1, bestScore = 0;
  for (let lag = lmin; lag <= lmax; lag++) {
    if (!(r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1])) continue;
    const bpm = (60 * er) / lag;
    const score = r[lag] * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  if (best < 0 || r[best] < mean * 1.3) return null; // no clear pulse
  // sharpen the peak between frames
  const a = r[best - 1], b = r[best], c = r[best + 1];
  const den = a - 2 * b + c;
  const lagF = best + (den !== 0 ? (0.5 * (a - c)) / den : 0);
  const bpm = Math.round(((60 * er) / lagF) * 10) / 10;
  // beat phase: offset within one beat where onsets pile up
  const P = Math.round(lagF);
  let bestPh = 0, bestSum = -1;
  for (let ph = 0; ph < P; ph++) {
    let s = 0;
    for (let m = 0; ph + Math.round(m * lagF) < n; m++) s += flat[ph + Math.round(m * lagF)];
    if (s > bestSum) { bestSum = s; bestPh = ph; }
  }
  const period = 60 / bpm;
  const phase = (((start + bestPh * hop) / sr) % period + period) % period;
  return { bpm, phase };
}
