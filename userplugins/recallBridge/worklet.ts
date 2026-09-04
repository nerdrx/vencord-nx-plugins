/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * The AudioWorklet that runs over one remote user's audio.
 *
 * It is a *string* rather than a module because an AudioWorklet is loaded by
 * URL into a separate global scope: `audioWorklet.addModule(url)`. Vencord's
 * own bundle cannot be that URL, so the source is handed to a Blob and the
 * Blob's object URL is what gets loaded. Keeping it here — one exported
 * string, next to the code that uses it — is the only way it stays readable.
 *
 * What it does, in order:
 *
 *   1. downmix every input channel to mono (WebRTC hands us mono, but a stereo
 *      track would otherwise be read as double-rate);
 *   2. resample the AudioContext's rate (48 kHz in practice, read at runtime)
 *      down to 16 kHz through a 32-tap windowed-sinc filter, table-driven so a
 *      busy call does not pay for half a million `Math.sin` calls a second per
 *      person;
 *   3. accumulate whole frames, convert to little-endian PCM16, and post them
 *      with a sequence number and the AudioContext time of the frame's FIRST
 *      sample.
 *
 * Point 3 is why this is a worklet and not a `ScriptProcessorNode`: inside
 * `process()` the render quantum's own clock is available, so a frame's start
 * time is *known* rather than inferred from when the main thread woke up. The
 * fallback path infers it, and says so.
 *
 * Decimating without the filter would be cheaper and wrong. 48 kHz speech
 * carries real energy above 8 kHz, and folding it back over the 0–8 kHz band
 * is exactly the damage a speaker embedder notices and a listener does not.
 */

/** Taps either side of the centre; 32 in total. */
const HALF_TAPS = 16;
/** Sub-sample phases the kernel is precomputed at. */
const PHASES = 128;

export const WORKLET_SOURCE = String.raw`
const HALF_TAPS = ${HALF_TAPS};
const PHASES = ${PHASES};

/** Blackman window over [-1, 1], zero at the ends. */
function nxWindow(t) {
    const x = (t + 1) / 2;
    return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

function nxSinc(x) {
    if (Math.abs(x) < 1e-9) return 1;
    const p = Math.PI * x;
    return Math.sin(p) / p;
}

/**
 * kernel[phase * taps + (i + HALF_TAPS - 1)] weights input sample
 * floor(pos) + i at the sub-sample offset phase / PHASES.
 *
 * The cutoff is in cycles per INPUT sample: 1/ratio when decimating, so the
 * passband ends at the output Nyquist; 1 when the rates already match.
 */
function nxKernel(ratio) {
    const cutoff = ratio > 1 ? 1 / ratio : 1;
    const taps = 2 * HALF_TAPS;
    const k = new Float32Array(PHASES * taps);
    for (let p = 0; p < PHASES; p++) {
        const frac = p / PHASES;
        let sum = 0;
        for (let i = -HALF_TAPS + 1; i <= HALF_TAPS; i++) {
            const t = i - frac;
            const v = cutoff * nxSinc(cutoff * t) * nxWindow(t / HALF_TAPS);
            k[p * taps + (i + HALF_TAPS - 1)] = v;
            sum += v;
        }
        // Normalise each phase to unit DC gain. Without it the level wobbles
        // at the phase period, which at 48->16 kHz is an audible buzz and a
        // measurable insult to a speaker embedding.
        if (sum !== 0) for (let i = 0; i < taps; i++) k[p * taps + i] /= sum;
    }
    return k;
}

class RecallTap extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const opts = (options && options.processorOptions) || {};
        this.outRate = opts.outRate || 16000;
        this.frameSamples = opts.frameSamples || 8000;

        this.ratio = sampleRate / this.outRate;
        this.kernel = nxKernel(this.ratio);
        this.taps = 2 * HALF_TAPS;

        // Input samples not yet fully consumed, and the fractional index into
        // them of the next output sample.
        this.hist = new Float32Array(0);
        this.pos = HALF_TAPS;

        this.frame = new Float32Array(this.frameSamples);
        this.filled = 0;
        this.seq = 0;
        this.frameStart = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const n = input[0].length;
        if (n === 0) return true;

        // 1. downmix
        const mono = new Float32Array(n);
        for (let c = 0; c < input.length; c++) {
            const src = input[c];
            for (let i = 0; i < n; i++) mono[i] += src[i];
        }
        if (input.length > 1) {
            const scale = 1 / input.length;
            for (let i = 0; i < n; i++) mono[i] *= scale;
        }

        // 2. resample everything the filter can now reach
        const carried = this.hist.length;
        const ext = new Float32Array(carried + n);
        ext.set(this.hist, 0);
        ext.set(mono, carried);

        const kernel = this.kernel;
        const taps = this.taps;
        const limit = ext.length - HALF_TAPS;
        let pos = this.pos;

        while (pos < limit) {
            const base = Math.floor(pos);
            const off = ((pos - base) * PHASES | 0) * taps;
            let acc = 0;
            for (let i = 0; i < taps; i++) {
                acc += kernel[off + i] * ext[base - HALF_TAPS + 1 + i];
            }

            if (this.filled === 0) {
                // currentTime is the start of THIS render quantum. The sample
                // being written sits (pos - carried) input samples into it —
                // negative while the carried tail is still draining, which is
                // correct and worth the arithmetic: a frame stamped a quantum
                // late is a frame that disagrees with the speaking edge.
                this.frameStart = currentTime + (pos - carried) / sampleRate;
            }
            this.frame[this.filled++] = acc;
            pos += this.ratio;

            if (this.filled === this.frameSamples) this.emit();
        }

        // 3. drop what no future output can reach
        const keepFrom = Math.max(0, Math.floor(pos) - HALF_TAPS + 1);
        this.hist = ext.slice(keepFrom);
        this.pos = pos - keepFrom;
        return true;
    }

    emit() {
        const pcm = new Int16Array(this.filled);
        for (let i = 0; i < this.filled; i++) {
            let s = this.frame[i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            // 32767 and not 32768: the range is -32768..32767, and scaling by
            // 32768 wraps +1.0 round to the most negative sample there is.
            pcm[i] = Math.round(s * 32767);
        }
        this.port.postMessage(
            { pcm: pcm.buffer, samples: this.filled, seq: this.seq++, t: this.frameStart },
            [pcm.buffer]
        );
        this.filled = 0;
    }
}

registerProcessor("nx-recall-tap", RecallTap);
`;
