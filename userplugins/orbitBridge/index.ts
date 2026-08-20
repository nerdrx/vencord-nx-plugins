/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * OrbitBridge — an NX Orbit *source*.
 *
 * It emits ONLY what your own Discord client already shows you about your own
 * friends: their friend entry, the presence and custom status they broadcast,
 * and name/avatar changes. Never a message, never a non-friend, never a guess.
 * Batches are POSTed to Orbit's loopback ingest (127.0.0.1); nothing leaves the
 * box, and a failed flush never throws into Discord.
 *
 * See nx-orbit docs/WRITING_A_VENCORD_SOURCE.md for the why behind every rule.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { FluxDispatcher, PresenceStore, RelationshipStore, showToast, Toasts, UserStore } from "@webpack/common";

const SOURCE = "discord";
const PLUGIN = "vencord-orbit-bridge";
const VERSION = "1.0.0";
const FRIEND = 1;            // RelationshipType.FRIEND
const CUSTOM = 4;           // ActivityType.CUSTOM_STATUS
const OFFLINE = new Set(["offline", "invisible", "unknown"]);

const settings = definePluginSettings({
    enabled: { type: OptionType.BOOLEAN, default: true, description: "Send friend presence to NX Orbit" },
    ingestPort: { type: OptionType.NUMBER, default: 8477, description: "Orbit loopback ingest port" },
    ingestToken: { type: OptionType.STRING, default: "", description: "Token from NX Orbit → Sources" },
    flushIntervalSec: { type: OptionType.NUMBER, default: 30, description: "How often to POST a batch (min 5s)" }
});

// ---- consent guards ---------------------------------------------------------
function isFriend(id: string) {
    try { return RelationshipStore.getRelationshipType(id) === FRIEND; } catch { return false; }
}

// ---- surface reads (only these stores) --------------------------------------
function statusOf(id: string): string {
    try { return PresenceStore.getStatus(id) ?? "offline"; } catch { return "offline"; }
}
/** Discord ring → Orbit status. NEVER joinme/askme (those are VRChat-only). */
function ringOf(status: string): string | undefined {
    if (status === "dnd") return "busy";
    if (status === "idle") return "idle";
    return undefined; // online/offline are carried by the presence kind, not status
}
function customOf(id: string): string {
    try {
        const a: any = PresenceStore.getActivities(id)?.find((x: any) => x.type === CUSTOM);
        return a ? `${a.emoji?.name ? a.emoji.name + " " : ""}${a.state ?? ""}`.trim() : "";
    } catch { return ""; }
}

interface Snap { status: string; custom: string; name: string; avatar: string; seeded: boolean; }
const snaps = new Map<string, Snap>();

// ---- batch state ------------------------------------------------------------
const observations: any[] = [];
const persons = new Map<string, any>();
const dirtyPersons = new Set<string>();
let flushTimer: ReturnType<typeof setInterval> | undefined;
let warnedToken = false;

function touchPerson(id: string) {
    const u: any = (() => { try { return UserStore.getUser(id); } catch { return null; } })();
    if (!u) return false;
    persons.set(id, {
        source: SOURCE,
        sourceId: id,
        handle: u.username,
        displayName: u.globalName || u.username,
        avatarUrl: u.getAvatarURL?.(undefined, 128)
    });
    dirtyPersons.add(id);
    return true;
}

function emit(id: string, obs: any) {
    // any observation must carry its person along in the batch
    if (!touchPerson(id)) return;
    observations.push({ source: SOURCE, sourceId: id, ts: Date.now(), ...obs });
}

/**
 * Reconcile a friend's current surface state against our snapshot.
 * First sight seeds presence + custom (useful state) but NOT nick/avatar
 * (nothing to diff against — a baseline would invent a "changed" event).
 */
function sync(id: string) {
    if (!settings.store.enabled || !isFriend(id)) return;
    const u: any = (() => { try { return UserStore.getUser(id); } catch { return null; } })();
    if (!u) return;

    const status = statusOf(id);
    const custom = customOf(id);
    const name = u.globalName || u.username || "";
    const avatar = u.avatar ?? "";

    const prev = snaps.get(id);

    if (!prev || !prev.seeded) {
        // baseline: current presence + custom status only
        emit(id, { kind: "presence", status: OFFLINE.has(status) ? "offline" : "online" });
        const ring = ringOf(status);
        if (ring) emit(id, { kind: "status", status: ring });
        if (custom) emit(id, { kind: "status", text: custom });
    } else {
        if (status !== prev.status) {
            emit(id, { kind: "presence", status: OFFLINE.has(status) ? "offline" : "online" });
            const ring = ringOf(status);
            if (ring) emit(id, { kind: "status", status: ring });
        }
        if (custom !== prev.custom && custom) emit(id, { kind: "status", text: custom });
        if (name !== prev.name) emit(id, { kind: "nick", text: name, meta: { previous: prev.name } });
        if (avatar !== prev.avatar) emit(id, { kind: "avatar" });
    }

    snaps.set(id, { status, custom, name, avatar, seeded: true });
}

// ---- flush ------------------------------------------------------------------
async function flush() {
    if (!settings.store.enabled || !observations.length) return;
    const token = settings.store.ingestToken?.trim();
    if (!token) {
        if (!warnedToken) { warnedToken = true; console.warn("[OrbitBridge] no ingest token set — paste it in plugin settings"); }
        return;
    }
    const port = Math.max(1, Math.min(65535, settings.store.ingestPort || 8477));

    // snapshot the batch, but don't clear the queue until a 200
    const batch = {
        plugin: PLUGIN,
        version: VERSION,
        emittedAt: Date.now(),
        persons: [...persons.values()],
        observations: observations.slice()
    };

    let res: Response;
    try {
        res = await fetch(`http://127.0.0.1:${port}/api/v1/ingest`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(batch)
        });
    } catch {
        // Orbit down or fetch blocked by CSP — keep queue, retry next flush
        return;
    }

    if (res.ok) {
        observations.length = 0;
        dirtyPersons.clear();
        // keep `persons` — cheap to re-send, and Orbit dedups
        return;
    }
    if (res.status === 401) {
        if (!warnedToken) { warnedToken = true; showToast("OrbitBridge: token rejected — paste the current one from Orbit → Sources", Toasts.Type.FAILURE); }
        return; // keep queue
    }
    if (res.status === 422) {
        // a record broke schema/consent rules — log and DROP (don't loop forever)
        try { console.warn("[OrbitBridge] batch rejected (422):", await res.json()); } catch { }
        observations.length = 0;
        dirtyPersons.clear();
        return;
    }
    // other non-OK: keep queue, retry
}

// ---- flux handlers ----------------------------------------------------------
function onPresence(e: any) {
    const ids: string[] = e?.updates ? e.updates.map((u: any) => u.user?.id ?? u.userId) : [e?.user?.id ?? e?.userId];
    for (const id of ids) if (id && isFriend(id)) sync(id);
}
function onRelationshipAdd(e: any) {
    const id = e?.relationship?.id ?? e?.id;
    if (id && isFriend(id)) {
        emit(id, { kind: "friend", meta: { state: "added" } });
        // seed their current state too
        snaps.delete(id);
        sync(id);
    }
}
function onRelationshipRemove(e: any) {
    const id = e?.relationship?.id ?? e?.id;
    if (!id) return;
    // touchPerson still works right after removal; emit the friend-removed event
    if (touchPerson(id)) observations.push({ source: SOURCE, sourceId: id, ts: Date.now(), kind: "friend", meta: { state: "removed" } });
    snaps.delete(id);
}

export default definePlugin({
    name: "OrbitBridge",
    description: "Feeds your Discord friends' presence and custom status to NX Orbit (local only, friends-only, surface-only). The consent-respecting counterpart to a stalker tool.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    toolboxActions: {
        "🛰️ Flush to Orbit now"() { void flush(); },
        async "🩺 Check Orbit connection"() {
            const port = settings.store.ingestPort || 8477;
            try {
                const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
                const ok = r.ok && (await r.json())?.ok;
                showToast(ok ? "OrbitBridge: Orbit is up ✓" : "OrbitBridge: Orbit responded but not healthy", ok ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE);
            } catch {
                showToast("OrbitBridge: can't reach Orbit on 127.0.0.1 (is it running?)", Toasts.Type.FAILURE);
            }
        }
    },

    start() {
        // seed all current friends
        try { (RelationshipStore.getFriendIDs() ?? []).forEach(sync); } catch { }
        FluxDispatcher.subscribe("PRESENCE_UPDATE", onPresence);
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresence);
        FluxDispatcher.subscribe("RELATIONSHIP_ADD", onRelationshipAdd);
        FluxDispatcher.subscribe("RELATIONSHIP_REMOVE", onRelationshipRemove);
        flushTimer = setInterval(flush, Math.max(5, settings.store.flushIntervalSec) * 1000);
        void flush();
    },

    stop() {
        FluxDispatcher.unsubscribe("PRESENCE_UPDATE", onPresence);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresence);
        FluxDispatcher.unsubscribe("RELATIONSHIP_ADD", onRelationshipAdd);
        FluxDispatcher.unsubscribe("RELATIONSHIP_REMOVE", onRelationshipRemove);
        clearInterval(flushTimer);
        observations.length = 0;
        persons.clear();
        dirtyPersons.clear();
        snaps.clear();
        warnedToken = false;
    }
});
