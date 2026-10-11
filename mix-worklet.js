// AirDeck mix engine (runs on the audio thread, sample by sample).
// Two decks, one stereo output each. Handles what needs sample accuracy:
//  - variable-rate playback, including backwards (scratching)
//  - beat sync: every deck follows one master beat clock, phase-locked to the bar
//  - slip mode: while you scratch, the track keeps running silently underneath,
//    and on release it jumps back to where it would have been, so it stays in sync
//  - looping on whole bars, so the beat grid never breaks at the loop point

const SMOOTH_START = 0.002;    // per-sample approach to target rate: ~10 ms spin-up
const SMOOTH_BRAKE = 0.00012;  // ~0.2 s turntable-style stop
const SMOOTH_SCRATCH = 0.006;  // ~4 ms: follows the hand closely without zipper noise
const SYNC_GAIN = 0.2;         // rate correction per beat of phase error
const SYNC_MAX = 0.03;         // never bend the rate by more than 3% to correct
const SYNC_JUMP = 0.1;         // phase error (beats) beyond which we just jump
const FADE = 1 / 256;          // declick ramp after a jump
const REPORT_EVERY = 1024;     // samples between position reports to the main thread

class Deck {
  constructor() {
    this.L = this.R = null;
    this.len = 0;
    this.bpm = 120;
    this.first = 0;            // first downbeat, in samples
    this.loopStart = 0;
    this.loopLen = 0;
    this.pos = 0;              // play head, in samples (fractional)
    this.shadow = 0;           // where the play head would be without scratching
    this.rate = 0;             // current playback rate (smoothed)
    this.playing = false;
    this.scratching = false;
    this.scratchRate = 0;
    this.fade = 1;
  }
}

class MixEngine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.decks = [new Deck(), new Deck()];
    this.masterBpm = 0;
    this.beat = 0;             // master beat clock (beats since start, fractional)
    this.sinceReport = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  spb(d) { return (sampleRate * 60) / d.bpm; }                // samples per beat
  deckBeat(d, pos = d.pos) { return (pos - d.first) / this.spb(d); }
  baseRate(d) { return this.masterBpm ? this.masterBpm / d.bpm : 1; }
  // Phase error in beats, wrapped to [-2, 2): bar-aligned, so downbeats line up.
  phaseError(d) {
    const e = (this.beat - this.deckBeat(d)) % 4;
    return ((e + 6) % 4) - 2;
  }

  jump(d, delta) {
    d.pos += delta;
    d.shadow += delta;
    d.fade = 0;
  }

  onMessage(m) {
    const d = this.decks[m.deck];
    switch (m.type) {
      case "load": {
        Object.assign(d, { L: m.L, R: m.R, len: m.L.length, bpm: m.bpm, playing: false, scratching: false, rate: 0 });
        d.first = m.first * sampleRate;
        // Loop the longest stretch of whole bars after the first downbeat
        const bar = this.spb(d) * 4;
        const bars = Math.max(1, Math.floor((d.len - d.first) / bar));
        d.loopStart = d.first;
        d.loopLen = bars * bar;
        d.pos = d.shadow = d.first;
        break;
      }
      case "master":
        this.masterBpm = m.bpm;
        break;
      case "play": {
        if (!d.len || d.playing) break;
        const other = this.decks[1 - m.deck];
        if (other.playing && this.masterBpm) this.jump(d, this.phaseError(d) * this.spb(d));
        else this.beat = this.deckBeat(d); // first deck playing leads the clock
        d.shadow = d.pos;
        d.playing = true;
        break;
      }
      case "pause":
        d.playing = false;
        break;
      case "scratch":
        if (m.active && !d.scratching) d.shadow = d.pos;
        if (!m.active && d.scratching && d.playing) {
          // Slip: return to where the track would be, then carry on at normal speed
          d.pos = d.shadow;
          d.rate = this.baseRate(d);
          d.fade = 0;
        }
        d.scratching = m.active;
        d.scratchRate = m.rate || 0;
        break;
    }
  }

  wrap(d, p) {
    const end = d.loopStart + d.loopLen;
    if (p >= end) return p - d.loopLen;
    if (p < 0) return p + d.loopLen;
    return p;
  }

  process(_inputs, outputs) {
    const n = outputs[0][0].length;
    for (let k = 0; k < 2; k++) {
      const d = this.decks[k];
      if (!d.len) continue; // outputs are pre-filled with silence
      const oL = outputs[k][0], oR = outputs[k][1] || oL;
      const base = this.baseRate(d);

      let corr = 0;
      if (d.playing && !d.scratching && this.masterBpm) {
        const err = this.phaseError(d);
        if (Math.abs(err) > SYNC_JUMP) this.jump(d, err * this.spb(d));
        else corr = Math.max(-SYNC_MAX, Math.min(SYNC_MAX, err * SYNC_GAIN));
      }
      const target = d.scratching ? d.scratchRate : d.playing ? base * (1 + corr) : 0;
      const a = d.scratching ? SMOOTH_SCRATCH : d.playing ? SMOOTH_START : SMOOTH_BRAKE;
      const L = d.L, R = d.R, last = d.len - 1;

      for (let i = 0; i < n; i++) {
        d.rate += (target - d.rate) * a;
        const p = Math.min(Math.max(d.pos, 0), last);
        const i0 = p | 0, f = p - i0, i1 = Math.min(i0 + 1, last);
        let g = 1;
        if (d.fade < 1) { d.fade = Math.min(1, d.fade + FADE); g = d.fade; }
        oL[i] = (L[i0] + (L[i1] - L[i0]) * f) * g;
        oR[i] = (R[i0] + (R[i1] - R[i0]) * f) * g;
        d.pos = this.wrap(d, d.pos + d.rate);
        if (d.playing) d.shadow = this.wrap(d, d.shadow + base);
      }
    }
    if (this.masterBpm) this.beat += (this.masterBpm / 60 / sampleRate) * n;

    this.sinceReport += n;
    if (this.sinceReport >= REPORT_EVERY) {
      this.sinceReport = 0;
      this.port.postMessage({
        beat: this.beat,
        time: currentTime + n / sampleRate, // the clock value above is for the end of this block
        decks: this.decks.map((d) => ({ pos: d.pos / sampleRate, rate: d.rate })),
      });
    }
    return true;
  }
}

registerProcessor("mix-engine", MixEngine);
