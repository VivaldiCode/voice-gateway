/**
 * Renderer-side microphone capture pipeline.
 *
 * Pulls raw mono PCM frames from the system mic, downsamples to 16 kHz, and
 * emits Int16 chunks. No external deps — uses `AudioContext` + an inline
 * `AudioWorklet` for sample-accurate processing.
 *
 * Lifecycle:
 *   const cap = new AudioCapture();
 *   await cap.start({ deviceId: settings.audio.inputDeviceId });
 *   cap.onFrame((int16: Int16Array) => ...);
 *   await cap.stop();
 *
 * The actual frame size is `AUDIO_FRAME_SAMPLES` (~20 ms at 16 kHz).
 */

import {
  AUDIO_CHANNELS,
  AUDIO_FRAME_SAMPLES,
  AUDIO_SAMPLE_RATE,
} from '../../shared/constants';

const WORKLET_NAME = 'vg-pcm16-emitter';

const WORKLET_SOURCE = `
class Pcm16Emitter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions.targetSampleRate;
    this.frameSamples = options.processorOptions.frameSamples;
    this.ratio = sampleRate / this.targetSampleRate;
    this.buffer = new Float32Array(this.frameSamples);
    this.cursor = 0;
    this.sourcePos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    // Linear-interp downsampler. Adequate for 48k → 16k speech.
    for (let i = 0; i < ch.length; i++) {
      this.sourcePos += 1;
      while (this.sourcePos >= this.ratio) {
        this.sourcePos -= this.ratio;
        const idx = Math.max(0, i - 1);
        const a = ch[idx] ?? 0;
        const b = ch[i] ?? a;
        const frac = 1 - (this.sourcePos / this.ratio);
        this.buffer[this.cursor++] = a + (b - a) * frac;
        if (this.cursor >= this.frameSamples) {
          const pcm = new Int16Array(this.frameSamples);
          for (let j = 0; j < this.frameSamples; j++) {
            const s = Math.max(-1, Math.min(1, this.buffer[j]));
            pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.port.postMessage(pcm.buffer, [pcm.buffer]);
          this.cursor = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, Pcm16Emitter);
`;

export interface AudioCaptureOptions {
  /** From `navigator.mediaDevices.enumerateDevices()`. Omit for default input. */
  deviceId?: string | null;
}

export type FrameListener = (frame: Int16Array) => void;

export class AudioCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private listeners = new Set<FrameListener>();
  private muted = false;

  async start(opts: AudioCaptureOptions = {}): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
        channelCount: AUDIO_CHANNELS,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
      video: false,
    });
    const ctx = new AudioContext();
    this.ctx = ctx;

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: {
        targetSampleRate: AUDIO_SAMPLE_RATE,
        frameSamples: AUDIO_FRAME_SAMPLES,
      },
    });
    node.port.onmessage = (event) => {
      if (this.muted) return;
      const buf = event.data as ArrayBuffer;
      const frame = new Int16Array(buf);
      for (const l of this.listeners) l(frame);
    };
    this.node = node;

    const source = ctx.createMediaStreamSource(this.stream);
    this.source = source;
    source.connect(node);
  }

  async stop(): Promise<void> {
    this.muted = false;
    this.source?.disconnect();
    this.node?.disconnect();
    this.node?.port.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  onFrame(cb: FrameListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

/**
 * Enumerate available audio I/O devices. Requires prior `getUserMedia` call
 * (the browser hides device labels until microphone permission is granted).
 */
export async function listAudioDevices(): Promise<MediaDeviceInfo[]> {
  return await navigator.mediaDevices.enumerateDevices();
}
