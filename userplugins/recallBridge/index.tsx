/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * RecallBridge — ground truth for NX Recall.
 *
 * Recall records the *mixed* Discord stream off your speakers, so it hears one
 * conversation and has to guess who each voice belongs to. Discord's own client
 * already knows: it renders a speaking ring per user. This plugin hands Recall
 * that ring — who started talking, who stopped, and when — so Recall can score
 * its own speaker guesses against Discord's word.
 *
 * It sends *no audio* (Discord decodes remote voice in the native engine; a
 * plugin can't reach it, and doesn't need to). What goes over the wire is
 * timestamps, user ids, nicknames and channel ids, to 127.0.0.1 and nowhere
 * else. A failed flush never throws into Discord's dispatcher.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, GuildMemberStore, Menu, SelectedChannelStore, showToast, Toasts, UserStore, VoiceStateStore } from "@webpack/common";

const QUEUE_CAP = 5000; // lines held in memory; oldest dropped past this
const POST_CAP = 800; // lines per POST, to stay well under recalld's 1 MB
const BACKOFF_MIN = 2_000;
const BACKOFF_MAX = 60_000;

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

// ---- reads ------------------------------------------------------------------
function myId(): string | undefined {
    try { return UserStore.getCurrentUser()?.id; } catch { return undefined; }
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

// ---- queue ------------------------------------------------------------------
function push(ep: Endpoint, obj: Record<string, unknown>) {
    let body: string;
    try { body = JSON.stringify(obj); } catch { return; }
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

async function post(ep: Endpoint, lines: string[], token: string): Promise<"ok" | "drop" | "retry"> {
    let res: Response;
    try {
        res = await fetch(`http://127.0.0.1:${port()}/v1/discord/${ep}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-ndjson",
                Authorization: `Bearer ${token}`
            },
            body: lines.join("\n") + "\n"
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

async function flush() {
    if (inFlight) return;
    if (!settings.store.enabled) { setLink("off"); return; }
    if (!queue.length) return;
    if (Date.now() < backoffUntil) return;

    const token = settings.store.token?.trim();
    if (!token) { setLink("off", "no truth token set — paste it in plugin settings"); return; }

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
    description: "Hands NX Recall the one thing it can't hear: which Discord user was talking, and exactly when. Speaking edges, voice-channel membership and nicknames, POSTed to 127.0.0.1 and nowhere else. No audio, no messages.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions() {
        const label = link === "connected"
            ? "🎙 Recall bridge: connected"
            : link === "refused"
                ? "🎙 Recall bridge: refused"
                : "🎙 Recall bridge: off";
        return [
            <Menu.MenuItem
                id="recall-bridge-status"
                key="recall-bridge-status"
                label={`${label}${queue.length ? ` · ${queue.length} queued` : ""}${dropped ? ` · ${dropped} dropped` : ""}`}
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
        flushTimer = setInterval(flush, Math.max(100, settings.store.batchMs || 500));
    },

    stop() {
        clearInterval(flushTimer);
        flushTimer = undefined;
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
