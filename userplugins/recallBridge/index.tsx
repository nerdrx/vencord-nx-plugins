/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * RecallBridge — ground truth for NX Recall, and (on Vesktop) its audio.
 *
 * Recall records the *mixed* Discord stream off your speakers, so it hears one
 * conversation and has to guess who each voice belongs to. Discord's own client
 * already knows: it renders a speaking ring per user. This plugin hands Recall
 * that ring — who started talking, who stopped, and when — so Recall can score
 * its own speaker guesses against Discord's word.
 *
 * That half sends *no audio*. What goes over the wire is timestamps, user ids,
 * nicknames and channel ids, to 127.0.0.1 and nowhere else. A failed flush
 * never throws into Discord's dispatcher.
 *
 * The second half, added later and **off by default**, does send audio: on
 * Vesktop and the web client every remote user arrives as their own
 * `MediaStream`, so their voice can be tapped separately and posted to Recall
 * as mono 16 kHz PCM. That deletes the problem the first half only measures —
 * there is no mixture to un-mix and no voice to identify, because each stream
 * is one person by construction. It is a bigger claim than speaking edges and
 * it has its own switch. See `audio.ts`.
 *
 * On the Discord desktop client the audio half cannot work at all: voice is
 * decoded and mixed inside a native module whose JS surface has no way to
 * receive it. The toolbox says so rather than looking switched on.
 *
 * ## Two clients, one daemon
 *
 * Both of those clients can now carry this plugin at once — the official
 * Discord in one call, Vesktop in another — and both POST at the same recalld.
 * Every line therefore names its sender: `client: { kind, account_id, instance }`.
 * `kind` is which client this is, which is how the daemon maps a bridge to the
 * PipeWire node its client plays through; `account_id` is the account this
 * plugin is signed in as, which is the bridge's identity when two clients are
 * two copies of one binary; `instance` is random per plugin start, so a
 * reloaded plugin can be told from a second one.
 *
 * Without it the daemon reads every span that overlaps a turn, from both calls,
 * and cannot tell that it is doing so. An older daemon ignores the field.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildMemberStore, Menu, SelectedChannelStore, showToast, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

import { audioBlocked, audioStats, creditAudio, drainAudio, requeueAudio, startAudio, stopAudio, sweepTaps, tapStream } from "./audio";

const QUEUE_CAP = 5000; // lines held in memory; oldest dropped past this
const POST_CAP = 800; // lines per POST, to stay well under recalld's 1 MB
const BACKOFF_MIN = 2_000;
const BACKOFF_MAX = 60_000;
const SWEEP_MS = 5_000;

type Endpoint = "speaking" | "voice";
type Link = "off" | "connected" | "refused";

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Send who-spoke-when to NX Recall"
    },
    port: {
        type: OptionType.NUMBER,
        default: 7797,
        description: "recalld loopback truth port ([truth] port in recalld's config)"
    },
    token: {
        type: OptionType.STRING,
        default: "",
        description: "Truth token — run `recalld truth token` and paste it here"
    },
    scope: {
        type: OptionType.SELECT,
        description: "Which channels to report",
        options: [
            { label: "Only while I'm in a voice channel (recommended)", value: "voice", default: true },
            { label: "Every voice channel my client can see", value: "all" }
        ]
    },
    batchMs: {
        type: OptionType.NUMBER,
        default: 500,
        description: "How often to POST a batch, in milliseconds (min 100)"
    },
    audio: {
        type: OptionType.BOOLEAN,
        default: false,
        description:
            "Send each person's AUDIO as well (Vesktop/web only). This takes everyone's voice out of the client and hands it to recalld over 127.0.0.1 — a much bigger claim than the speaking edges above, which is why it is off. Recall then transcribes each person separately and never has to guess who was talking."
    },
    audioFrameMs: {
        type: OptionType.NUMBER,
        default: 500,
        description: "Audio frame length in milliseconds (min 100). 500 ms is 16 kB per person per frame."
    }
});

// ---- state ------------------------------------------------------------------
interface Line { ep: Endpoint; body: string; }

const queue: Line[] = [];
/** userId -> last speaking state we reported, so we only send transitions */
const speakingState = new Map<string, boolean>();
/** userId -> last channel we saw them in, so mute/unmute isn't a "join" */
const lastChannel = new Map<string, string | null>();

let flushTimer: ReturnType<typeof setInterval> | undefined;
let sweepTimer: ReturnType<typeof setInterval> | undefined;
let inFlight = false;
let link: Link = "off";
let backoffUntil = 0;
let backoff = BACKOFF_MIN;
let dropped = 0;

function setLink(next: Link, why?: string) {
    if (link === next) return;
    link = next;
    // one log line per state change — never per failed flush
    console.log(`[RecallBridge] link: ${next}${why ? ` (${why})` : ""}`);
}

/**
 * This plugin run's id: random, generated once, never persisted.
 *
 * It is not an identity — the account is — it is a *lifetime*. A plugin that
 * was reloaded and a second plugin on the same account look identical to a
 * daemon counting spans; this is how it tells them apart, and it is why the id
 * must change on every start and must not be derived from anything stable.
 */
const INSTANCE = (() => {
    try {
        return crypto.randomUUID().slice(0, 8);
    } catch {
        // No `crypto` is not a reason to send nothing: a weaker id still
        // separates two runs, and the field is a hint, not a key.
        return Math.random().toString(36).slice(2, 10);
    }
})();

// ---- reads ------------------------------------------------------------------
function myId(): string | undefined {
    try { return UserStore.getCurrentUser()?.id; } catch { return undefined; }
}

/**
 * Which client this plugin is running in.
 *
 * Vencord's own build-time globals, and the same ones the audio patch's
 * predicate reads — so "the audio half is impossible here" and "this is the
 * official client" can never disagree. `undefined` rather than a guess when
 * none of them is set: an unnamed bridge is scoped to nothing in particular,
 * which is honest, and a wrong name would point the daemon at the wrong
 * PipeWire node.
 */
function myKind(): "vesktop" | "discord" | "web" | undefined {
    try {
        if (typeof IS_VESKTOP !== "undefined" && IS_VESKTOP) return "vesktop";
        if (typeof IS_DISCORD_DESKTOP !== "undefined" && IS_DISCORD_DESKTOP) return "discord";
        if (typeof IS_WEB !== "undefined" && IS_WEB) return "web";
    } catch { /* a build without the globals — say nothing */ }
    return undefined;
}

/**
 * The `client` object every POST carries (0.12.3). `undefined` when we cannot
 * say who we are at all, which is exactly what an older plugin sent and is
 * what the daemon reads as "the only bridge there was".
 */
function clientRef(): Record<string, unknown> | undefined {
    const account_id = myId();
    const kind = myKind();
    if (!account_id && !kind) return undefined;
    return { kind, account_id, instance: INSTANCE };
}

function myVoiceChannel(): string | null {
    try { return SelectedChannelStore.getVoiceChannelId() ?? null; } catch { return null; }
}

function channelOf(userId: string): string | null {
    try {
        const st: any = (VoiceStateStore as any).getVoiceStateForUser?.(userId);
        if (st?.channelId) return st.channelId;
    } catch { /* store shape drift — fall through */ }
    return myVoiceChannel();
}

/** guild nick → global name → username. Nicknames are per-guild, hence the guild lookup. */
function nameOf(userId: string, channelId: string | null): string {
    let nick: string | null = null;
    try {
        const gid = channelId ? (ChannelStore.getChannel(channelId) as any)?.guild_id ?? null : null;
        if (gid) nick = (GuildMemberStore as any).getNick?.(gid, userId) ?? null;
    } catch { /* DM call, or store shape drift */ }
    if (nick) return nick;
    try {
        const u: any = UserStore.getUser(userId);
        return u?.globalName || u?.username || userId;
    } catch { return userId; }
}

/** Are we allowed to report this channel under the current scope setting? */
function inScope(channelId: string | null): boolean {
    if (!settings.store.enabled) return false;
    if (settings.store.scope === "all") return true;
    const mine = myVoiceChannel();
    return !!mine && channelId === mine;
}

/** The audio half runs only when both switches are on and the client can do it. */
function audioOn(): boolean {
    return !!settings.store.enabled && !!settings.store.audio && audioBlocked() == null;
}

// ---- queue ------------------------------------------------------------------
function push(ep: Endpoint, obj: Record<string, unknown>) {
    let body: string;
    // Stamped here rather than at each call site: there is exactly one way out
    // of this plugin, so there is exactly one place a line can leave unsigned.
    try { body = JSON.stringify({ ...obj, client: clientRef() }); } catch { return; }
    queue.push({ ep, body });
    while (queue.length > QUEUE_CAP) { queue.shift(); dropped++; }
}

function emitSpeaking(userId: string, speaking: boolean, channelId: string | null) {
    push("speaking", {
        t_ms: Date.now(),
        user_id: userId,
        speaking,
        name: nameOf(userId, channelId),
        channel_id: channelId
    });
}

function emitVoice(ev: "join" | "leave" | "self", userId: string, channelId: string | null, extra?: Record<string, unknown>) {
    push("voice", {
        t_ms: Date.now(),
        ev,
        user_id: userId,
        name: nameOf(userId, channelId),
        channel_id: channelId,
        ...extra
    });
}

/** Everyone currently sitting in `channelId`, as join lines. Sent on RTC_CONNECTED. */
function emitRoster(channelId: string | null) {
    if (!channelId) return;
    let states: Record<string, any> = {};
    try { states = (VoiceStateStore as any).getVoiceStatesForChannel?.(channelId) ?? {}; } catch { return; }
    for (const uid of Object.keys(states)) {
        lastChannel.set(uid, channelId);
        emitVoice("join", uid, channelId);
    }
}

/** Our own mute/deafen state — Recall needs to know when the local mic is off. */
function emitSelf() {
    const me = myId();
    if (!me) return;
    const ch = myVoiceChannel();
    let st: any = {};
    try { st = (VoiceStateStore as any).getVoiceStateForUser?.(me) ?? {}; } catch { /* keep defaults */ }
    emitVoice("self", me, ch, {
        self_mute: !!(st.selfMute ?? st.mute),
        self_deaf: !!(st.selfDeaf ?? st.deaf)
    });
}

// ---- flush ------------------------------------------------------------------
function port(): number {
    return Math.max(1, Math.min(65535, settings.store.port || 7797));
}

type Verdict = "ok" | "drop" | "retry";

async function postTo(path: string, body: string, token: string): Promise<Verdict> {
    let res: Response;
    try {
        res = await fetch(`http://127.0.0.1:${port()}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-ndjson",
                Authorization: `Bearer ${token}`
            },
            body
        });
    } catch {
        // recalld isn't listening (truth ingest off, or daemon down)
        return "retry";
    }
    if (res.ok || res.status === 204) return "ok";
    if (res.status === 401) { setLink("refused", "token rejected — run `recalld truth token`"); return "retry"; }
    if (res.status === 413) { setLink("refused", "batch too large — dropping it"); return "drop"; }
    setLink("refused", `recalld said ${res.status}`);
    return "retry";
}

function post(ep: Endpoint, lines: string[], token: string): Promise<Verdict> {
    return postTo(`/v1/discord/${ep}`, lines.join("\n") + "\n", token);
}

/**
 * The audio half's own POST. Separate from the edge queue because the bodies
 * are four orders of magnitude bigger: a batch is budgeted in BYTES, and a
 * refused batch goes back to the front of its own queue rather than blocking
 * the speaking edges, which are small, cheap and the thing Recall needs most.
 */
async function flushAudio(token: string): Promise<void> {
    if (!audioOn()) return;
    const lines = drainAudio();
    if (!lines.length) return;
    const body = lines.map(l => l.body).join("\n") + "\n";
    const verdict = await postTo("/v1/discord/audio", body, token);
    if (verdict === "retry") {
        requeueAudio(lines);
        backoffUntil = Date.now() + backoff;
        backoff = Math.min(BACKOFF_MAX, backoff * 2);
        return;
    }
    if (verdict === "ok") {
        creditAudio(body.length);
        setLink("connected");
        backoff = BACKOFF_MIN;
        backoffUntil = 0;
    }
    // "drop": recalld refused the size. Requeueing would loop forever on it.
}

async function flush() {
    if (inFlight) return;
    if (!settings.store.enabled) { setLink("off"); return; }
    if (Date.now() < backoffUntil) return;

    const token = settings.store.token?.trim();
    if (!token) { setLink("off", "no truth token set — paste it in plugin settings"); return; }
    if (!queue.length && !audioOn()) return;

    inFlight = true;
    try {
        // one POST per endpoint per tick, oldest lines first
        for (const ep of ["speaking", "voice"] as Endpoint[]) {
            const mine = queue.filter(l => l.ep === ep).slice(0, POST_CAP);
            if (!mine.length) continue;

            const verdict = await post(ep, mine.map(l => l.body), token);
            if (verdict === "retry") {
                backoffUntil = Date.now() + backoff;
                backoff = Math.min(BACKOFF_MAX, backoff * 2);
                return; // keep the queue; try again after the backoff
            }
            // ok or drop: those lines are done with either way
            let n = mine.length;
            for (let i = 0; i < queue.length && n > 0;) {
                if (queue[i].ep === ep) { queue.splice(i, 1); n--; } else i++;
            }
            if (verdict === "ok") {
                setLink("connected");
                backoff = BACKOFF_MIN;
                backoffUntil = 0;
            }
        }
        await flushAudio(token);
    } finally {
        inFlight = false;
    }
}

// ---- flux -------------------------------------------------------------------
function onSpeaking(e: any) {
    const uid: string | undefined = e?.userId;
    if (!uid) return;
    const now = !!e?.speakingFlags;
    if (speakingState.get(uid) === now) return; // dedupe: transitions only
    const ch = channelOf(uid);
    if (!inScope(ch)) { speakingState.set(uid, now); return; }
    speakingState.set(uid, now);
    emitSpeaking(uid, now, ch);
}

function onVoiceStates({ voiceStates }: { voiceStates: Array<any>; }) {
    if (!settings.store.enabled) return;
    const me = myId();
    for (const s of voiceStates) {
        const uid: string | undefined = s?.userId;
        if (!uid) continue;
        const now: string | null = s.channelId ?? null;
        const prev = lastChannel.get(uid) ?? null;
        lastChannel.set(uid, now);

        if (uid === me) {
            // our own mute/deafen/move — always worth a self line
            if (inScope(now) || inScope(prev)) emitSelf();
        }

        if (now === prev) continue; // mute/unmute/video, not a move
        if (prev && inScope(prev)) emitVoice("leave", uid, prev);
        if (now && inScope(now)) emitVoice("join", uid, now);

        // someone who left is no longer speaking, whatever the last SPEAKING said
        if (!now) speakingState.delete(uid);
    }
}

function onRtcState(e: any) {
    if (e?.state !== "RTC_CONNECTED") return;
    // Discord gives us the channel a beat after the state flips
    setTimeout(() => {
        if (!settings.store.enabled) return;
        emitSelf();
        emitRoster(myVoiceChannel());
    }, 500);
}

export default definePlugin({
    name: "RecallBridge",
    description: "Hands NX Recall the one thing it can't hear: which Discord user was talking, and exactly when. Speaking edges, voice-channel membership and nicknames, POSTed to 127.0.0.1 and nowhere else — no messages, and no audio unless you switch on the separate, default-OFF per-user audio option (Vesktop/web only), which sends everyone's voice to recalld so it never has to guess whose it was.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    patches: [
        // Vesktop and the web client only — see audio.ts for why the desktop
        // client cannot do this at all. The anchor is the same volume
        // assignment upstream's VolumeBooster hooks, and the alternation is
        // deliberate: VolumeBooster rewrites it to `.volume=0.00;`, so matching
        // BOTH spellings makes the two plugins compose whichever order the
        // patcher happens to run them in.
        {
            find: "streamSourceNode",
            predicate: () => !IS_DISCORD_DESKTOP,
            replacement: {
                match: /\.volume=(?:this\._volume\/100|0\.00);/,
                replace: "$&$self.tapStream(this);"
            }
        }
    ],

    /** Called by the patch above, per remote user, whenever their sink updates. */
    tapStream(data: any) {
        // Never throws into Discord's own code: the whole call is best-effort
        // and a failure here must cost a recording, not a voice channel.
        try {
            void tapStream(data);
        } catch (e) {
            console.error("[RecallBridge] could not tap a stream", e);
        }
    },

    toolboxActions() {
        const label = link === "connected"
            ? "🎙 Recall bridge: connected"
            : link === "refused"
                ? "🎙 Recall bridge: refused"
                : "🎙 Recall bridge: off";

        const a = audioStats();
        const blocked = audioBlocked();
        const audioLabel = blocked
            ? `🔇 Per-user audio: unavailable — ${blocked}`
            : !settings.store.audio
                ? "🔇 Per-user audio: off (enable it in plugin settings)"
                : a.streams === 0
                    ? "🔊 Per-user audio: on · no streams yet"
                    : `🔊 Per-user audio: ${a.streams} stream${a.streams === 1 ? "" : "s"} · ${a.kbps.toFixed(1)} kB/s${a.via === "script" ? " · fallback" : ""}${a.droppedFrames ? ` · ${a.droppedFrames} dropped` : ""}${a.gaps ? ` · ${a.gaps} gaps` : ""}`;

        return [
            <Menu.MenuItem
                id="recall-bridge-status"
                key="recall-bridge-status"
                label={`${label}${myKind() ? ` (${myKind()})` : ""}${queue.length ? ` · ${queue.length} queued` : ""}${dropped ? ` · ${dropped} dropped` : ""}`}
                action={() => {
                    backoffUntil = 0;
                    backoff = BACKOFF_MIN;
                    void flush();
                    showToast(
                        link === "connected"
                            ? "RecallBridge: recalld is taking lines ✓"
                            : link === "refused"
                                ? "RecallBridge: recalld refused the last batch — check the token"
                                : "RecallBridge: idle (nothing queued, or no token set)",
                        link === "connected" ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE
                    );
                }}
            />,
            <Menu.MenuItem
                id="recall-bridge-audio"
                key="recall-bridge-audio"
                label={audioLabel}
                action={() => {
                    const s = audioStats();
                    showToast(
                        blocked
                            ? `RecallBridge: ${blocked}`
                            : s.workletError && s.via === "script"
                                ? `RecallBridge: the audio worklet would not load (${s.workletError}); using the ScriptProcessor fallback.`
                                : `RecallBridge: ${s.streams} stream(s), ${(s.sentBytes / 1024).toFixed(0)} kB sent, ${(s.queuedBytes / 1024).toFixed(0)} kB queued.`,
                        blocked ? Toasts.Type.FAILURE : Toasts.Type.MESSAGE
                    );
                }}
            />
        ];
    },

    flux: {
        SPEAKING: onSpeaking,
        VOICE_STATE_UPDATES: onVoiceStates,
        RTC_CONNECTION_STATE: onRtcState
    },

    start() {
        // seed positions so we don't invent joins for people already sitting in VC
        const here = myVoiceChannel();
        if (here) {
            emitSelf();
            emitRoster(here);
        }
        startAudio({
            enabled: audioOn,
            frameMs: () => settings.store.audioFrameMs || 500,
            describe: uid => ({ name: nameOf(uid, channelOf(uid)), channelId: channelOf(uid) }),
            selfId: myId,
            client: clientRef
        });
        flushTimer = setInterval(flush, Math.max(100, settings.store.batchMs || 500));
        // A voice connection torn down all at once does not always fire
        // `ended` on its tracks, so dead taps are swept rather than trusted.
        sweepTimer = setInterval(sweepTaps, SWEEP_MS);
    },

    stop() {
        clearInterval(flushTimer);
        flushTimer = undefined;
        clearInterval(sweepTimer);
        sweepTimer = undefined;
        stopAudio();
        queue.length = 0;
        speakingState.clear();
        lastChannel.clear();
        inFlight = false;
        backoffUntil = 0;
        backoff = BACKOFF_MIN;
        dropped = 0;
        link = "off";
    }
});
