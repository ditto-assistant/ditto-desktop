// Mic capture worklet: resamples the context rate to 16 kHz off the main
// thread and posts 40 ms PCM16 chunks (transferred, not copied) with their RMS.

import { INPUT_SAMPLE_RATE, createDownsampler, float32ToInt16, rms } from "./pcm.js";

const CHUNK_SAMPLES = INPUT_SAMPLE_RATE / 25;

class DittoPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.downsample = createDownsampler(sampleRate, INPUT_SAMPLE_RATE);
    this.buffer = new Float32Array(CHUNK_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    const samples = this.downsample(channel);
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(samples.length - offset, CHUNK_SAMPLES - this.filled);
      this.buffer.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === CHUNK_SAMPLES) {
        const pcm = float32ToInt16(this.buffer);
        this.port.postMessage({ pcm: pcm.buffer, level: rms(this.buffer) }, [pcm.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("ditto-pcm-capture", DittoPcmCapture);
