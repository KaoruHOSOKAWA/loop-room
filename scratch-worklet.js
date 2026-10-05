'use strict';

// One persistent read head; direction changes never replace the audio source.
class TurntableScratch extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = []; this.position = 0; this.target = 0;
    this.velocity = 0; this.level = 0; this.active = false; this.remaining = 0;
    this.sourceRate = sampleRate;
    this.velocitySmoothing = 1 - Math.exp(-1 / (sampleRate * .001));
    this.levelSmoothing = 1 - Math.exp(-1 / (sampleRate * .002));
    this.port.onmessage = ({ data }) => {
      if (data.type === 'load') {
        this.channels = data.channels; this.sourceRate = data.sampleRate;
        this.active = false; this.level = 0; this.velocity = 0;
        this.port.postMessage({ type: 'loaded' });
      } else if (data.type === 'start') {
        this.position = this.target = data.position * this.sourceRate;
        this.velocity = 0; this.level = 0; this.active = true; this.remaining = 0;
      } else if (data.type === 'move' && this.active) {
        // Unwrapped target avoids a jump when the read head crosses a loop boundary.
        this.target = data.position * this.sourceRate;
        const seconds = Number.isFinite(data.seconds) ? data.seconds : .016;
        this.remaining = Math.round(Math.max(.008, Math.min(.04, seconds)) * sampleRate);
      } else if (data.type === 'stop') this.active = false;
    };
  }
  read(channel, position) {
    const length = channel.length;
    const wrapped = ((position % length) + length) % length;
    const index = Math.floor(wrapped), fraction = wrapped - index;
    const a = channel[(index + length - 1) % length], b = channel[index];
    const c = channel[(index + 1) % length], d = channel[(index + 2) % length];
    // Cubic interpolation retains a continuous waveform at fractional positions.
    return b + .5 * fraction * (c - a + fraction * (2 * a - 5 * b + 4 * c - d + fraction * (3 * (b - c) + d - a)));
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output.length || !this.channels.length || !this.channels[0].length) return true;
    for (let frame = 0; frame < output[0].length; frame++) {
      const error = this.target - this.position;
      const desired = this.active ? error / Math.max(this.remaining, sampleRate * .003) : 0;
      this.velocity += (desired - this.velocity) * this.velocitySmoothing;
      this.position += this.velocity;
      if (this.remaining > 0) this.remaining--;
      const moving = this.active && Math.abs(this.velocity) > .0001;
      this.level += ((moving ? 1 : 0) - this.level) * this.levelSmoothing;
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][frame] = this.read(this.channels[Math.min(channel, this.channels.length - 1)], this.position) * this.level;
      }
    }
    return true;
  }
}
registerProcessor('turntable-scratch', TurntableScratch);
