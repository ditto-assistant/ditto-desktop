// PCM helpers shared by the capture worklet (mic -> 16 kHz PCM16) and the
// playback path (24 kHz PCM16 -> Float32). No DOM, so they run in node tests
// and inside AudioWorkletGlobalScope.

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;

export function float32ToInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToFloat32(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] / 32768;
  return out;
}

// btoa over 32 KiB slices keeps String.fromCharCode's argument list bounded.
export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function int16ToBase64(samples) {
  return bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
}

export function base64ToInt16(base64) {
  const binary = atob(base64);
  // An odd trailing byte cannot form a sample; drop it rather than throw.
  const length = binary.length - (binary.length % 2);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function rms(samples) {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

// Streaming box-filter downsampler. Each output sample averages the input
// samples that fall in its window, which is enough anti-aliasing for speech
// at 48k/44.1k -> 16k, and the fractional position carries across chunks so
// 128-frame worklet quanta resample without seams or drift.
export function createDownsampler(inputRate, outputRate) {
  if (!(inputRate > 0) || !(outputRate > 0)) throw new RangeError("sample rates must be positive");
  const step = inputRate / outputRate;
  let position = 0;
  let sum = 0;
  let count = 0;
  return function downsample(input) {
    if (step <= 1) return Float32Array.from(input);
    const out = new Float32Array(Math.ceil((input.length + 1) / step) + 1);
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i];
      count++;
      position += 1;
      if (position >= step) {
        out[written++] = sum / count;
        position -= step;
        sum = 0;
        count = 0;
      }
    }
    return out.subarray(0, written);
  };
}
