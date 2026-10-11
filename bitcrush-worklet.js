// Sample-and-hold reduction on the audio thread; bit-depth reduction lives in the waveshaper.
class AirDeckBitcrush extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "amount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }
  constructor() { super(); this.phase = 1; this.held = [0, 0]; }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!output?.length) return true;
    if (!input?.length) { for (const channel of output) channel.fill(0); this.phase = 1; this.held.fill(0); return true; }
    const amount = Math.max(0, Math.min(1, parameters.amount[0]));
    const step = Math.pow(0.025, amount); // full sample rate → ~1.2 kHz at 48 kHz
    for (let i = 0; i < output[0].length; i++) {
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        for (let ch = 0; ch < output.length; ch++) this.held[ch] = (input[ch] || input[0])[i] || 0;
      }
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = this.held[ch];
      this.phase += step;
    }
    return true;
  }
}
registerProcessor("airdeck-bitcrush", AirDeckBitcrush);
