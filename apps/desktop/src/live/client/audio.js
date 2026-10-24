// Browser audio engine for the aura: mic -> worklet -> PCM16 16 kHz base64,
// and gapless 24 kHz playback scheduled back-to-back on one AudioContext.
// Server VAD only: the web client's ONNX VAD is too heavy to ship here, so no
// activity_start/activity_end frames are sent.

import { OUTPUT_SAMPLE_RATE, base64ToInt16, int16ToBase64, int16ToFloat32 } from "./pcm.js";

const MIC_CONSTRAINTS = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

// `onLevel` fires when there is sound to show, so the orb can sleep in silence.
export function createAudioEngine({ onLevel = () => {} } = {}) {
  let stream = null;
  let captureContext = null;
  let worklet = null;
  let muted = false;
  let inputLevel = 0;
  // Bumped by stop() so a start() still awaiting permission or the worklet
  // module releases what it acquired instead of resurrecting the mic.
  let generation = 0;

  let playbackContext = null;
  let analyser = null;
  let analyserData = null;
  let nextPlayTime = 0;
  let sources = [];

  async function start({ onChunk }) {
    stop();
    const startedAt = generation;
    const acquired = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    if (startedAt !== generation) {
      for (const track of acquired.getTracks()) track.stop();
      return;
    }
    stream = acquired;
    applyMute();
    const ctx = new AudioContext();
    captureContext = ctx;
    await ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
    if (startedAt !== generation) return;
    const source = captureContext.createMediaStreamSource(stream);
    worklet = new AudioWorkletNode(captureContext, "ditto-pcm-capture");
    worklet.port.onmessage = ({ data }) => {
      if (muted) {
        inputLevel = 0;
        return;
      }
      inputLevel = Math.min(1, data.level * 3);
      // Matches the orb's QUIET_LEVEL, so room noise does not keep it awake.
      if (inputLevel >= 0.03) onLevel();
      onChunk(int16ToBase64(new Int16Array(data.pcm)));
    };
    // The worklet writes silence; connecting it to the destination keeps the
    // graph pulling it on every render quantum.
    source.connect(worklet);
    worklet.connect(captureContext.destination);
  }

  function applyMute() {
    if (!stream) return;
    for (const track of stream.getAudioTracks()) track.enabled = !muted;
  }

  function ensurePlayback() {
    if (!playbackContext || playbackContext.state === "closed") {
      playbackContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
      analyser = playbackContext.createAnalyser();
      analyser.fftSize = 256;
      analyserData = new Uint8Array(analyser.fftSize);
      analyser.connect(playbackContext.destination);
      nextPlayTime = 0;
    }
    return playbackContext;
  }

  function play(base64) {
    const ctx = ensurePlayback();
    const samples = int16ToFloat32(base64ToInt16(base64));
    if (samples.length === 0) return;
    const buffer = ctx.createBuffer(1, samples.length, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(analyser);
    nextPlayTime = Math.max(nextPlayTime, ctx.currentTime);
    node.start(nextPlayTime);
    nextPlayTime += buffer.duration;
    sources.push(node);
    onLevel();
    node.onended = () => {
      const index = sources.indexOf(node);
      if (index !== -1) sources.splice(index, 1);
    };
  }

  function flush() {
    for (const node of sources) {
      try {
        node.stop();
      } catch {
        // never started or already ended
      }
    }
    sources = [];
    nextPlayTime = 0;
  }

  function stop() {
    generation++;
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.disconnect();
      worklet = null;
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (captureContext) {
      void captureContext.close();
      captureContext = null;
    }
    inputLevel = 0;
    flush();
    if (playbackContext) {
      void playbackContext.close();
      playbackContext = null;
      analyser = null;
    }
  }

  return {
    start,
    stop,
    play,
    flush,
    setMuted(value) {
      muted = value;
      if (muted) inputLevel = 0;
      applyMute();
    },
    playbackRemainingMs() {
      if (!playbackContext || sources.length === 0) return 0;
      return Math.max(0, (nextPlayTime - playbackContext.currentTime) * 1000);
    },
    inputLevel: () => inputLevel,
    outputLevel() {
      if (!analyser || sources.length === 0) return 0;
      analyser.getByteTimeDomainData(analyserData);
      let sum = 0;
      for (let i = 0; i < analyserData.length; i++) {
        const v = (analyserData[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / analyserData.length) * 4);
    },
  };
}
