/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Per-user audio: the half of RecallBridge that sends sound.
 *
 * ## Why this can exist at all
 *
 * On the Discord *desktop* client remote voice is decoded and mixed inside
 * `discord_voice.node`, and its entire JS surface offers per-user volume, mute
 * and pan — parameters passed *into* the native mixer — and no way whatsoever
 * to receive a user's audio. There is an `addVideoOutputSink(id, stream, cb)`
 * taking decoded video frames, and no audio counterpart. So on Discord desktop
 * this file does nothing and the toolbox says why.
 *
 * Vesktop and the web client use `MediaEngineWebRTC`, where every remote user
 * arrives as their own `MediaStream`. Upstream Vencord's `VolumeBooster`
 * already taps exactly that, in a patch it applies only off the desktop client
 * (`predicate: () => !IS_DISCORD_DESKTOP`), by doing
 * `data.audioContext.createMediaStreamSource(data.stream)`. Hanging our own
 * node off the same source node gets raw per-user PCM in JS.
 *
 * ## Why that matters to Recall
 *
 * Recall records the mixed call off the speakers and has to work out whose
 * voice is whose. When two people talk at once it mostly cannot, and the
 * separation models that were supposed to fix that cost more accuracy than
 * they recover. Per-user streams delete the problem instead of solving it:
 * there was never a mixture, and the speaker's identity arrives with the
 * audio rather than being guessed from it.
 *
 * ## What it sends, and why it is off by default
 *
 * Mono 16 kHz PCM16, in frames, to `127.0.0.1` and nowhere else. That is a
 * bigger claim than the speaking edges the rest of this plugin sends: those
 * are timestamps, this is *what people said*, taken out of the client and
 * handed to another program. It is a separate switch, it is off until somebody
 * turns it on, and the plugin's description says so in the first sentence.
 */

import { WORKLET_SOURCE } from "./worklet";

/** What recalld's pipeline wants. Not negotiable at either end. */
export const OUT_RATE = 16_000;
/** Bytes of queued PCM held before the oldest frames are dropped. ~8 s x 4 people. */
const QUEUE_CAP_BYTES = 4 * 1024 * 1024;
/**
 * Bytes of NDJSON per POST. recalld's `MAX_BODY` is 1 MiB and answers `413`
 * over it, so the budget is the limit minus room for the JSON around the
 * base64 — a frame is measured, not estimated, before it is added.
 */
export const POST_BUDGET_BYTES = 700_000;
/** ScriptProcessor fallback block size. 4096 at 48 kHz is ~85 ms. */
const SCRIPT_BLOCK = 4096;

export type Via = "worklet" | "script";

export interface AudioLine {
    body: string;
    bytes: number;
}

export interface TapDescription {
    name: string;
    channelId: string | null;
}

export interface AudioHooks {
    /** Is the audio half switched on right now? Read live, never cached. */
    enabled(): boolean;
    /**
     * Which bridge this is: `{ kind, account_id, instance }` (0.12.3).
     *
     * Recall can now be fed by TWO plugins at once — one in Vesktop, one in the
     * official client, in two different calls — and a frame that does not say
     * whose it is gets attributed to whichever call the daemon guesses. Read
     * per frame rather than captured, because the account can change under a
     * running client (a logout, an account switch) and a stale one would file
     * somebody's voice under the wrong conversation.
     */
    client(): Record<string, unknown> | undefined;
    /** Frame length in milliseconds, from settings. */
    frameMs(): number;
    /** Nickname and channel for a user id, at the moment a frame is queued. */
    describe(userId: string): TapDescription;
    /** The local user's id, so we never ship the user their own microphone. */
    selfId(): string | undefined;
}

interface Tap {
    userId: string;
    ctx: AudioContext;
    source: MediaStreamAudioSourceNode;
    node: AudioNode;
    sink: GainNode;
    track: MediaStreamTrack;
    via: Via;
    /** `Date.now()` minus `ctx.currentTime * 1000`, fixed when the tap opens. */
    offsetMs: number;
    lastSeq: number;
    frames: number;
}

const taps = new Map<string, Tap>();
const queue: AudioLine[] = [];
let queuedBytes = 0;
let hooks: AudioHooks | null = null;
let running = false;

/** Counters the toolbox line reads. */
let sentBytes = 0;
let droppedFrames = 0;
let gaps = 0;
let via: Via | null = null;
let workletError: string | null = null;
/** Rolling kB/s: bytes queued in the current second, and the last full one. */
let windowStart = 0;
let windowBytes = 0;
let lastKbps = 0;

// ---- module loading ---------------------------------------------------------
//
// One `addModule` per AudioContext, and the promise is what is cached: two
// streams arriving in the same tick must not race two loads of the same name.

const modules = new WeakMap<AudioContext, Promise<boolean>>();

function ensureWorklet(ctx: AudioContext): Promise<boolean> {
    let p = modules.get(ctx);
    if (p) return p;
    p = (async () => {
        if (!("audioWorklet" in ctx)) return false;
        let url: string | undefined;
        try {
            url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
            await ctx.audioWorklet.addModule(url);
            return true;
        } catch (e) {
            // The usual cause is a content-security-policy that will not load a
            // blob: as a script. Recorded once, shown in the toolbox, and then
            // the ScriptProcessor path carries the feature.
            workletError = String((e as Error)?.message ?? e).slice(0, 120);
            return false;
        } finally {
            if (url) URL.revokeObjectURL(url);
        }
    })();
    modules.set(ctx, p);
    return p;
}

// ---- the fallback's resampler ----------------------------------------------
//
// The same 32-tap windowed sinc the worklet runs, written twice because an
// AudioWorklet global scope cannot import a module — see worklet.ts, and keep
// the two in step if either changes. The fallback exists for the CSP case
// above and is not the path that should normally run.

const HALF_TAPS = 16;
const PHASES = 128;

function buildKernel(ratio: number): Float32Array {
    const cutoff = ratio > 1 ? 1 / ratio : 1;
    const taps = 2 * HALF_TAPS;
    const k = new Float32Array(PHASES * taps);
    const sinc = (x: number) => (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const win = (t: number) => {
        const x = (t + 1) / 2;
        return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
    };
    for (let p = 0; p < PHASES; p++) {
        const frac = p / PHASES;
        let sum = 0;
        for (let i = -HALF_TAPS + 1; i <= HALF_TAPS; i++) {
            const t = i - frac;
            const v = cutoff * sinc(cutoff * t) * win(t / HALF_TAPS);
            k[p * taps + (i + HALF_TAPS - 1)] = v;
            sum += v;
        }
        if (sum !== 0) for (let i = 0; i < taps; i++) k[p * taps + i] /= sum;
    }
    return k;
}

class SincResampler {
    private kernel: Float32Array;
    private taps = 2 * HALF_TAPS;
    private hist = new Float32Array(0);
    private pos = HALF_TAPS;
    constructor(private ratio: number) {
        this.kernel = buildKernel(ratio);
    }
    process(mono: Float32Array): Float32Array {
        const ext = new Float32Array(this.hist.length + mono.length);
        ext.set(this.hist, 0);
        ext.set(mono, this.hist.length);
        const out: number[] = [];
        const limit = ext.length - HALF_TAPS;
        let pos = this.pos;
        while (pos < limit) {
            const base = Math.floor(pos);
            const off = (((pos - base) * PHASES) | 0) * this.taps;
            let acc = 0;
            for (let i = 0; i < this.taps; i++) acc += this.kernel[off + i] * ext[base - HALF_TAPS + 1 + i];
            out.push(acc);
            pos += this.ratio;
        }
        const keepFrom = Math.max(0, Math.floor(pos) - HALF_TAPS + 1);
        this.hist = ext.slice(keepFrom);
        this.pos = pos - keepFrom;
        return Float32Array.from(out);
    }
}

// ---- queueing ---------------------------------------------------------------

function base64(bytes: Uint8Array): string {
    // btoa over a binary string, chunked so a 16 kB frame does not blow the
    // argument limit of String.fromCharCode.
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) {
        s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)) as unknown as number[]);
    }
    return btoa(s);
}

function pushFrame(tap: Tap, pcm: Int16Array, seq: number, tMs: number) {
    if (!hooks?.enabled()) return;
    if (tap.lastSeq >= 0 && seq !== tap.lastSeq + 1) gaps++;
    tap.lastSeq = seq;
    tap.frames++;

    const d = hooks.describe(tap.userId);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let body: string;
    try {
        body = JSON.stringify({
            t_ms: tMs,
            user_id: tap.userId,
            name: d.name,
            channel_id: d.channelId,
            rate: OUT_RATE,
            seq,
            samples: pcm.length,
            pcm: base64(bytes),
            client: hooks.client()
        });
    } catch {
        return;
    }
    const size = body.length + 1; // the newline the NDJSON body joins with
    queue.push({ body, bytes: size });
    queuedBytes += size;
    while (queuedBytes > QUEUE_CAP_BYTES && queue.length > 1) {
        const gone = queue.shift()!;
        queuedBytes -= gone.bytes;
        droppedFrames++;
    }

    const now = Date.now();
    if (now - windowStart >= 1000) {
        lastKbps = windowBytes / 1024;
        windowBytes = 0;
        windowStart = now;
    }
    windowBytes += size;
}

/** Take up to `POST_BUDGET_BYTES` of frames, oldest first. */
export function drainAudio(): AudioLine[] {
    const out: AudioLine[] = [];
    let total = 0;
    while (queue.length) {
        const next = queue[0];
        if (out.length && total + next.bytes > POST_BUDGET_BYTES) break;
        queue.shift();
        queuedBytes -= next.bytes;
        total += next.bytes;
        out.push(next);
        // A single frame over the budget still goes on its own: recalld caps
        // at a megabyte and one 500 ms frame is sixteen kilobytes, so this is
        // unreachable in practice and a dropped frame if it ever is not.
        if (total >= POST_BUDGET_BYTES) break;
    }
    return out;
}

/** Put a refused batch back at the FRONT, so a retry keeps the order. */
export function requeueAudio(lines: AudioLine[]) {
    for (let i = lines.length - 1; i >= 0; i--) {
        queue.unshift(lines[i]);
        queuedBytes += lines[i].bytes;
    }
    while (queuedBytes > QUEUE_CAP_BYTES && queue.length > 1) {
        const gone = queue.pop()!;
        queuedBytes -= gone.bytes;
        droppedFrames++;
    }
}

export function creditAudio(bytes: number) {
    sentBytes += bytes;
}

// ---- taps -------------------------------------------------------------------

/**
 * Attach to one remote user's stream. Called from the patched sink, which runs
 * whenever Discord updates a user's audio element — so it is called repeatedly
 * for the same stream and must be idempotent.
 */
export async function tapStream(data: {
    id: string;
    stream: MediaStream;
    audioContext: AudioContext;
    streamSourceNode?: MediaStreamAudioSourceNode;
}) {
    if (!running || !hooks?.enabled()) return;
    if (typeof IS_DISCORD_DESKTOP !== "undefined" && IS_DISCORD_DESKTOP) return;
    const userId = data?.id;
    if (!userId || typeof userId !== "string") return;
    if (userId === hooks.selfId()) return; // the mic tap already has this one
    if (taps.has(userId)) return;
    const tracks = data.stream?.getAudioTracks?.() ?? [];
    if (!tracks.length) return;

    const ctx = data.audioContext;
    if (!ctx) return;
    // Shared with VolumeBooster on purpose: `??=` means whichever plugin gets
    // there first creates the one source node and the other reuses it. Two
    // MediaStreamAudioSourceNodes over one stream is legal and wasteful.
    const source = (data.streamSourceNode ??= ctx.createMediaStreamSource(data.stream));

    const frameSamples = Math.max(1600, Math.round((OUT_RATE * Math.max(100, hooks.frameMs())) / 1000));
    const useWorklet = await ensureWorklet(ctx);
    if (!running || taps.has(userId)) return;

    // The tap must not be heard. Everything we add hangs off a muted gain node
    // that only exists because a node with no route to a destination is not
    // guaranteed to be pulled at all.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    const offsetMs = Date.now() - ctx.currentTime * 1000;
    let node: AudioNode;

    if (useWorklet) {
        const w = new AudioWorkletNode(ctx, "nx-recall-tap", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { outRate: OUT_RATE, frameSamples }
        });
        w.port.onmessage = ev => {
            const tap = taps.get(userId);
            if (!tap) return;
            const { pcm, seq, t } = ev.data ?? {};
            if (!pcm) return;
            pushFrame(tap, new Int16Array(pcm), seq, Math.round(tap.offsetMs + t * 1000));
        };
        node = w;
        via = "worklet";
    } else {
        const sp = ctx.createScriptProcessor(SCRIPT_BLOCK, 1, 1);
        const res = new SincResampler(ctx.sampleRate / OUT_RATE);
        let pending = new Float32Array(0);
        let seq = 0;
        sp.onaudioprocess = e => {
            const tap = taps.get(userId);
            if (!tap) return;
            const inBuf = e.inputBuffer;
            const mono = new Float32Array(inBuf.length);
            for (let c = 0; c < inBuf.numberOfChannels; c++) {
                const d = inBuf.getChannelData(c);
                for (let i = 0; i < inBuf.length; i++) mono[i] += d[i];
            }
            if (inBuf.numberOfChannels > 1) {
                const s = 1 / inBuf.numberOfChannels;
                for (let i = 0; i < mono.length; i++) mono[i] *= s;
            }
            const got = res.process(mono);
            const merged = new Float32Array(pending.length + got.length);
            merged.set(pending, 0);
            merged.set(got, pending.length);
            // The last sample in `merged` is the end of THIS block, so a frame
            // starting at `off` began `(merged.length - off)` output samples
            // before that. An estimate, unlike the worklet's — the fallback
            // trades timing precision for working at all under a strict CSP,
            // and `playbackTime` is a scheduling time rather than a capture
            // one. Expect it to be about a block (~85 ms) less exact.
            const blockEndCtx = e.playbackTime ?? ctx.currentTime;
            let off = 0;
            while (merged.length - off >= frameSamples) {
                const pcm = new Int16Array(frameSamples);
                for (let i = 0; i < frameSamples; i++) {
                    let v = merged[off + i];
                    if (v > 1) v = 1;
                    else if (v < -1) v = -1;
                    pcm[i] = Math.round(v * 32767);
                }
                const tSec = blockEndCtx - (merged.length - off) / OUT_RATE;
                pushFrame(tap, pcm, seq++, Math.round(tap.offsetMs + tSec * 1000));
                off += frameSamples;
            }
            pending = merged.slice(off);
        };
        node = sp;
        via = "script";
    }

    source.connect(node);
    node.connect(sink);

    const track = tracks[0];
    const tap: Tap = { userId, ctx, source, node, sink, track, via: via!, offsetMs, lastSeq: -1, frames: 0 };
    taps.set(userId, tap);
    track.addEventListener("ended", () => untap(userId));
}

function untap(userId: string) {
    const tap = taps.get(userId);
    if (!tap) return;
    taps.delete(userId);
    try {
        tap.source.disconnect(tap.node);
    } catch { /* already torn down with the context */ }
    try {
        tap.node.disconnect();
        if ("port" in tap.node) (tap.node as AudioWorkletNode).port.onmessage = null;
        else (tap.node as ScriptProcessorNode).onaudioprocess = null;
    } catch { /* as above */ }
    try {
        tap.sink.disconnect();
    } catch { /* as above */ }
}

/**
 * Drop taps whose track has died without firing `ended`, which happens when a
 * whole voice connection is torn down at once.
 */
export function sweepTaps() {
    for (const [id, tap] of [...taps]) {
        if (tap.track.readyState !== "live") untap(id);
    }
}

export function startAudio(h: AudioHooks) {
    hooks = h;
    running = true;
    windowStart = Date.now();
}

export function stopAudio() {
    running = false;
    for (const id of [...taps.keys()]) untap(id);
    queue.length = 0;
    queuedBytes = 0;
    sentBytes = 0;
    droppedFrames = 0;
    gaps = 0;
    windowBytes = 0;
    lastKbps = 0;
    via = null;
    hooks = null;
}

export function audioStats() {
    // The window is only rolled over when a frame arrives, so a tap that has
    // gone silent would otherwise read at its last rate forever.
    const stale = Date.now() - windowStart >= 2000;
    return {
        streams: taps.size,
        kbps: stale ? 0 : lastKbps,
        queuedBytes,
        sentBytes,
        droppedFrames,
        gaps,
        via,
        workletError
    };
}

/** Why the audio half is not running, in one clause, or null when it is. */
export function audioBlocked(): string | null {
    if (typeof IS_DISCORD_DESKTOP !== "undefined" && IS_DISCORD_DESKTOP) {
        return "Discord desktop decodes voice in a native module — per-user audio never reaches a plugin. Use Vesktop.";
    }
    return null;
}
