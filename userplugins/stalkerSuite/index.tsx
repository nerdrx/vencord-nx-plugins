/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 nerdrx and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * StalkerSuite — a local "presence intelligence" dashboard.
 *
 * It logs and organises ONLY the data Discord already streams to every client
 * for people you're friends with or share a server with (presence, activity,
 * voice state, typing, profile changes). Nothing hidden is fetched; nothing
 * leaves your machine (IndexedDB via DataStore). It only deep-logs a watchlist
 * you pick by right-clicking a user.
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { createStore, get, set } from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import {
    ChannelStore, FluxDispatcher, GuildStore, Menu, PresenceStore,
    showToast, Toasts, UserStore
} from "@webpack/common";

// ActivityType enum values
const T_PLAYING = 0, T_STREAMING = 1, T_LISTENING = 2, T_CUSTOM = 4;
const OFFLINE = new Set(["offline", "invisible", "unknown"]);

const store = createStore("StalkerSuite", "data");
const KEY = "db";

const settings = definePluginSettings({
    watchIds: {
        type: OptionType.STRING,
        description: "Watched user IDs (comma-separated). Easier: right-click a user → Watch in Stalker Suite.",
        default: ""
    },
    logTyping: {
        type: OptionType.BOOLEAN,
        description: "Log when watched users start typing in channels you share",
        default: true
    }
});

interface Ev { t: number; k: string; a?: string; b?: string; }
interface Rec {
    id: string;
    name: string;
    events: Ev[];
    games: Record<string, number>;   // name -> minutes seen playing
    tracks: { ar: string; ti: string; t: number; }[];
    names: { v: string; t: number; }[];
    avatars: { v: string; t: number; }[];
    hist: number[];                   // 24 buckets: minutes seen online per hour-of-day
    lastOnline: number;
}

let db: Record<string, Rec> = {};
let dirty = false;
let saveTimer: ReturnType<typeof setInterval> | undefined;
let sampler: ReturnType<typeof setInterval> | undefined;

// live snapshot for diffing presence transitions
const live = new Map<string, { status?: string; game?: string; spotify?: string; custom?: string; }>();
const typingUntil = new Map<string, number>();

function watch(): Set<string> {
    return new Set(settings.store.watchIds.split(",").map(s => s.trim()).filter(Boolean));
}
function setWatch(s: Set<string>) { settings.store.watchIds = [...s].join(","); }

function rec(id: string): Rec {
    return db[id] ??= { id, name: id, events: [], games: {}, tracks: [], names: [], avatars: [], hist: new Array(24).fill(0), lastOnline: 0 };
}
function log(id: string, k: string, a?: string, b?: string) {
    const r = rec(id);
    r.events.push({ t: Date.now(), k, a, b });
    if (r.events.length > 800) r.events.shift();
    dirty = true;
}

async function load() { db = (await get<Record<string, Rec>>(KEY, store)) ?? {}; }
async function persist() { if (dirty) { dirty = false; await set(KEY, db, store); } }

function platformOf(id: string): string {
    try {
        const cs: any = PresenceStore.getClientStatus(id) ?? {};
        const k = Object.keys(cs)[0];
        return k ?? "";
    } catch { return ""; }
}
function activities(id: string): any[] {
    try { return PresenceStore.getActivities(id) ?? []; } catch { return []; }
}
function gameOf(acts: any[]) { return acts.find(a => a.type === T_PLAYING || a.type === T_STREAMING)?.name; }
function spotifyOf(acts: any[]) {
    const s = acts.find(a => a.type === T_LISTENING);
    return s ? { ar: s.state ?? "?", ti: s.details ?? s.name ?? "?" } : null;
}
function customOf(acts: any[]) {
    const c = acts.find(a => a.type === T_CUSTOM);
    if (!c) return undefined;
    return `${c.emoji?.name ? c.emoji.name + " " : ""}${c.state ?? ""}`.trim();
}

// diff a watched user's current presence against the live snapshot; log transitions
function syncUser(id: string) {
    const status = (() => { try { return PresenceStore.getStatus(id); } catch { return "offline"; } })();
    const acts = activities(id);
    const prev = live.get(id) ?? {};
    const cur = { status, game: gameOf(acts), spotify: (sp => sp ? `${sp.ar} — ${sp.ti}` : undefined)(spotifyOf(acts)), custom: customOf(acts) };

    if (cur.status !== prev.status)
        log(id, "status", cur.status, platformOf(id) || undefined);

    if (cur.game !== prev.game) {
        if (cur.game) log(id, "game", cur.game, "start");
        else if (prev.game) log(id, "game", prev.game, "stop");
    }
    if (cur.spotify && cur.spotify !== prev.spotify) {
        log(id, "spotify", cur.spotify);
        const sp = spotifyOf(acts);
        if (sp) { const r = rec(id); r.tracks.push({ ...sp, t: Date.now() }); if (r.tracks.length > 200) r.tracks.shift(); }
    }
    if (cur.custom !== prev.custom && cur.custom)
        log(id, "custom", cur.custom);

    live.set(id, cur);
}

// once a minute: accumulate online-time histogram, game minutes, catch identity changes
function sample() {
    const w = watch();
    if (!w.size) return;
    const hour = new Date().getHours();
    for (const id of w) {
        const r = rec(id);
        const status = (() => { try { return PresenceStore.getStatus(id); } catch { return "offline"; } })();
        if (!OFFLINE.has(status)) {
            r.hist[hour]++;
            r.lastOnline = Date.now();
            const g = gameOf(activities(id));
            if (g) r.games[g] = (r.games[g] ?? 0) + 1;
        }
        const user: any = UserStore.getUser(id);
        if (user) {
            r.name = user.username ?? r.name;
            const last = r.names.at(-1)?.v;
            if (user.username && user.username !== last) {
                r.names.push({ v: user.username, t: Date.now() });
                if (last) log(id, "name", `${last} → ${user.username}`);
            }
            const av = user.avatar ?? "";
            const lastAv = r.avatars.at(-1)?.v;
            if (av !== lastAv) { r.avatars.push({ v: av, t: Date.now() }); if (lastAv !== undefined) log(id, "avatar", "changed avatar"); }
        }
        dirty = true;
    }
}

// ---------- sleep estimate ----------
function sleepWindow(hist: number[]): [number, number] | null {
    const total = hist.reduce((a, b) => a + b, 0);
    if (total < 60) return null; // need a bit of history
    const max = Math.max(...hist, 1);
    const low = hist.map(v => v / max < 0.18); // "asleep-ish" hours
    // find the longest contiguous run of low hours (wrap around midnight)
    let bestStart = -1, bestLen = 0;
    for (let s = 0; s < 24; s++) {
        let len = 0;
        while (len < 24 && low[(s + len) % 24]) len++;
        if (len > bestLen) { bestLen = len; bestStart = s; }
    }
    if (bestLen < 3 || bestLen >= 24) return null;
    return [bestStart, (bestStart + bestLen) % 24];
}

// ================= UI =================
const ACCENT = "#b47aff";
let panel: HTMLDivElement | null = null;
let selected: string | null = null;
let tab = "radar";
let ui = 0;

function h(tag: string, css: string, txt?: string) {
    const e = document.createElement(tag);
    e.style.cssText = css;
    if (txt != null) e.textContent = txt;
    return e as HTMLElement;
}
function ago(t: number) {
    if (!t) return "never";
    const s = (Date.now() - t) / 1000;
    if (s < 60) return `${s | 0}s ago`;
    if (s < 3600) return `${s / 60 | 0}m ago`;
    if (s < 86400) return `${s / 3600 | 0}h ago`;
    return `${s / 86400 | 0}d ago`;
}
function hhmm(h24: number) { return `${String(h24).padStart(2, "0")}:00`; }

function render() {
    if (!panel || panel.style.display === "none") return;
    const content = panel.querySelector("#ss-content") as HTMLElement;
    const listEl = panel.querySelector("#ss-list") as HTMLElement;
    if (!content || !listEl) return;

    const w = [...watch()];
    // left watchlist
    listEl.replaceChildren(...w.map(id => {
        const r = db[id];
        const status = (() => { try { return PresenceStore.getStatus(id); } catch { return "offline"; } })();
        const online = !OFFLINE.has(status);
        const row = h("div", `display:flex;align-items:center;gap:7px;padding:6px 8px;border-radius:8px;cursor:pointer;${selected === id ? "background:rgba(119,0,255,0.18);" : ""}`);
        const dot = h("span", `width:8px;height:8px;border-radius:50%;flex:none;background:${online ? (status === "idle" ? "#f1c40f" : status === "dnd" ? "#e74c3c" : "#2ecc71") : "#555"};`);
        const nm = h("span", "font-size:12px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", r?.name ?? id);
        row.append(dot, nm);
        row.onclick = () => { selected = id; render(); };
        return row;
    }));
    if (!w.length) listEl.innerHTML = `<div style="opacity:0.5;font-size:11px;padding:10px;">Right-click a user → Watch in Stalker Suite.</div>`;

    // right content by tab
    content.replaceChildren();
    if (tab === "radar") return renderRadar(content, w);
    if (!selected || !db[selected]) { content.innerHTML = `<div style="opacity:0.5;font-size:12px;padding:16px;">Pick someone from the list.</div>`; return; }
    const r = db[selected];
    if (tab === "timeline") return renderTimeline(content, r);
    if (tab === "sleep") return renderSleep(content, r);
    if (tab === "music") return renderMusic(content, r);
    if (tab === "identity") return renderIdentity(content, r);
}

function renderRadar(c: HTMLElement, w: string[]) {
    if (!w.length) { c.innerHTML = `<div style="opacity:0.5;font-size:12px;padding:16px;">No one watched yet.</div>`; return; }
    for (const id of w) {
        const r = db[id]; const user: any = UserStore.getUser(id);
        const status = (() => { try { return PresenceStore.getStatus(id); } catch { return "offline"; } })();
        const acts = activities(id);
        const g = gameOf(acts); const sp = spotifyOf(acts); const cu = customOf(acts);
        const plat = platformOf(id);
        const typing = (typingUntil.get(id) ?? 0) > Date.now();

        const card = h("div", "padding:10px 12px;margin-bottom:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(119,0,255,0.2);border-radius:10px;");
        const online = !OFFLINE.has(status);
        card.append(h("div", `font-weight:700;font-size:13px;color:${ACCENT};`, `${r?.name ?? id}  ·  ${online ? status : "offline"}${plat ? ` (${plat})` : ""}`));
        const info: string[] = [];
        if (typing) info.push("⌨️ typing…");
        if (g) info.push(`🎮 ${g}`);
        if (sp) info.push(`🎧 ${sp.ti} — ${sp.ar}`);
        if (cu) info.push(`💬 ${cu}`);
        info.push(`👁 last online ${ago(r?.lastOnline ?? 0)}`);
        card.append(h("div", "font-size:11px;opacity:0.8;margin-top:4px;line-height:1.6;", info.join("   ")));
        c.append(card);
    }
}

function renderTimeline(c: HTMLElement, r: Rec) {
    const icon: Record<string, string> = { status: "●", game: "🎮", spotify: "🎧", custom: "💬", voice: "🔊", typing: "⌨️", name: "✏️", avatar: "🖼" };
    const evs = [...r.events].reverse().slice(0, 200);
    if (!evs.length) { c.innerHTML = `<div style="opacity:0.5;font-size:12px;padding:16px;">No events logged yet — give it time.</div>`; return; }
    for (const e of evs) {
        const d = new Date(e.t);
        const row = h("div", "display:flex;gap:8px;font-size:11px;padding:3px 4px;border-bottom:1px solid rgba(119,0,255,0.08);");
        row.append(h("span", "opacity:0.4;flex:none;font-variant-numeric:tabular-nums;", `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`));
        row.append(h("span", "flex:none;", icon[e.k] ?? "•"));
        row.append(h("span", "flex:1;color:#e8e4f5;", `${e.a ?? ""}${e.b && e.b !== "start" ? ` (${e.b})` : ""}`));
        c.append(row);
    }
}

function renderSleep(c: HTMLElement, r: Rec) {
    const win = sleepWindow(r.hist);
    const hdr = h("div", "font-size:12px;margin-bottom:10px;");
    if (win) {
        const nowH = new Date().getHours();
        const asleep = win[0] < win[1] ? (nowH >= win[0] && nowH < win[1]) : (nowH >= win[0] || nowH < win[1]);
        const status = (() => { try { return PresenceStore.getStatus(r.id); } catch { return "offline"; } })();
        hdr.innerHTML = `Usually asleep <b style="color:${ACCENT};">${hhmm(win[0])}–${hhmm(win[1])}</b> (your local time).<br>` +
            `<span style="opacity:0.8;">Right now: ${asleep && OFFLINE.has(status) ? "😴 probably asleep" : "🟢 probably awake"}</span>`;
    } else {
        hdr.textContent = "Not enough history yet to estimate a sleep window — keep them watched for a day or two.";
    }
    c.append(hdr);
    // 24h bar chart
    const max = Math.max(...r.hist, 1);
    const grid = h("div", "display:grid;grid-template-columns:repeat(24,1fr);gap:2px;align-items:end;height:90px;margin-top:6px;");
    for (let i = 0; i < 24; i++) {
        const bar = h("div", `background:rgba(119,0,255,${0.25 + 0.75 * (r.hist[i] / max)});height:${Math.max(3, (r.hist[i] / max) * 90) | 0}px;border-radius:2px;`);
        bar.title = `${hhmm(i)} — seen online ${r.hist[i]} min`;
        grid.append(bar);
    }
    c.append(grid);
    const labels = h("div", "display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin-top:3px;");
    for (let i = 0; i < 24; i++) labels.append(h("div", "font-size:7px;opacity:0.4;text-align:center;", i % 6 === 0 ? String(i) : ""));
    c.append(labels);
    c.append(h("div", "font-size:10px;opacity:0.5;margin-top:8px;", "Bars = how often they've been seen online at each hour of the day."));
}

function renderMusic(c: HTMLElement, r: Rec) {
    if (!r.tracks.length) { c.innerHTML = `<div style="opacity:0.5;font-size:12px;padding:16px;">No Spotify activity logged yet.</div>`; return; }
    const byArtist: Record<string, number> = {};
    const byTrack: Record<string, number> = {};
    for (const t of r.tracks) { byArtist[t.ar] = (byArtist[t.ar] ?? 0) + 1; byTrack[`${t.ti} — ${t.ar}`] = (byTrack[`${t.ti} — ${t.ar}`] ?? 0) + 1; }
    const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const col = (title: string, rows: [string, number][]) => {
        const d = h("div", "flex:1;min-width:0;");
        d.append(h("div", `font-size:11px;font-weight:700;color:${ACCENT};margin-bottom:6px;`, title));
        for (const [k, v] of rows) {
            const row = h("div", "display:flex;gap:6px;font-size:11px;padding:2px 0;");
            row.append(h("span", "flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;", k));
            row.append(h("span", "opacity:0.5;flex:none;", `×${v}`));
            d.append(row);
        }
        return d;
    };
    const wrap = h("div", "display:flex;gap:18px;");
    wrap.append(col(`Top artists (${r.tracks.length} plays)`, top(byArtist)), col("Top tracks", top(byTrack)));
    c.append(wrap);
}

function renderIdentity(c: HTMLElement, r: Rec) {
    if (!r.names.length && !r.avatars.length) { c.innerHTML = `<div style="opacity:0.5;font-size:12px;padding:16px;">No identity history yet.</div>`; return; }
    c.append(h("div", `font-size:11px;font-weight:700;color:${ACCENT};margin-bottom:6px;`, "Usernames seen"));
    for (const n of [...r.names].reverse()) {
        const row = h("div", "display:flex;gap:8px;font-size:11px;padding:2px 0;");
        row.append(h("span", "opacity:0.4;flex:none;", new Date(n.t).toLocaleDateString()));
        row.append(h("span", "flex:1;", n.v));
        c.append(row);
    }
    c.append(h("div", `font-size:11px;font-weight:700;color:${ACCENT};margin:12px 0 6px;`, `Avatar changes: ${r.avatars.length}`));
}

function buildPanel() {
    panel = document.createElement("div");
    panel.id = "ss-panel";
    panel.style.cssText = `
        position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:3100;
        width:min(860px,94vw);height:min(560px,80vh);display:flex;flex-direction:column;
        background:rgba(10,8,20,0.92);backdrop-filter:blur(20px) saturate(1.4);
        border:1px solid rgba(119,0,255,0.4);border-radius:16px;overflow:hidden;
        font-family:var(--font-primary,sans-serif);color:#e8e4f5;box-shadow:0 16px 50px rgba(0,0,0,0.6);`;

    const header = h("div", "display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:grab;border-bottom:1px solid rgba(119,0,255,0.25);flex:none;");
    const title = h("div", "flex:1;");
    title.innerHTML = `<span style="font-size:13px;font-weight:700;letter-spacing:1px;color:${ACCENT};">🕵️ STALKER SUITE</span> <span style="font-size:10px;opacity:0.5;">local only · watchlist-driven</span>`;
    const tabsWrap = h("div", "display:flex;gap:4px;");
    for (const [id, label] of [["radar", "Radar"], ["timeline", "Timeline"], ["sleep", "Sleep"], ["music", "Music"], ["identity", "Identity"]] as const) {
        const b = h("button", "background:rgba(119,0,255,0.15);border:none;color:#e8e4f5;border-radius:6px;padding:4px 9px;font-size:11px;cursor:pointer;", label);
        b.onclick = () => { tab = id; [...tabsWrap.children].forEach(x => (x as HTMLElement).style.background = "rgba(119,0,255,0.15)"); b.style.background = "rgba(119,0,255,0.45)"; render(); };
        if (id === tab) b.style.background = "rgba(119,0,255,0.45)";
        tabsWrap.append(b);
    }
    const close = h("button", "background:rgba(119,0,255,0.2);border:none;color:#fff;border-radius:8px;width:26px;height:26px;font-size:15px;cursor:pointer;", "×");
    close.onclick = () => hide();
    header.append(title, tabsWrap, close);

    let drag: [number, number] | null = null;
    header.onpointerdown = e => { if ((e.target as HTMLElement).tagName === "BUTTON") return; drag = [e.clientX - panel!.offsetLeft, e.clientY - panel!.offsetTop]; panel!.style.transform = "none"; header.setPointerCapture((e as PointerEvent).pointerId); };
    header.onpointermove = e => { if (!drag) return; panel!.style.left = e.clientX - drag[0] + "px"; panel!.style.top = e.clientY - drag[1] + "px"; };
    header.onpointerup = () => { drag = null; };

    const body = h("div", "display:flex;flex:1;overflow:hidden;");
    const list = h("div", "width:190px;flex:none;border-right:1px solid rgba(119,0,255,0.2);overflow-y:auto;padding:6px;");
    list.id = "ss-list";
    const content = h("div", "flex:1;overflow-y:auto;padding:14px;");
    content.id = "ss-content";
    body.append(list, content);

    panel.append(header, body);
    document.body.append(panel);
}

function show() { if (!panel) buildPanel(); panel!.style.display = "flex"; render(); }
function hide() { if (panel) panel.style.display = "none"; }

const userCtx: NavContextMenuPatchCallback = (children, { user }: { user?: { id: string; username?: string; }; }) => {
    if (!user) return;
    const w = watch();
    const on = w.has(user.id);
    const item = (
        <Menu.MenuItem
            id="stalker-watch"
            label={on ? "Unwatch in Stalker Suite" : "🕵️ Watch in Stalker Suite"}
            color={on ? "danger" : undefined}
            action={() => {
                if (on) w.delete(user.id);
                else { w.add(user.id); rec(user.id).name = user.username ?? user.id; }
                setWatch(w);
                showToast(`Stalker Suite: ${on ? "unwatched" : "now watching"} ${user.username ?? user.id}`, Toasts.Type.SUCCESS);
                render();
            }}
        />
    );
    const group = findGroupChildrenByChildId(["block", "user-profile"], children) ?? children;
    group.push(item);
};

function onPresence(e: any) {
    const w = watch();
    if (!w.size) return;
    const ids: string[] = e?.updates ? e.updates.map((u: any) => u.user?.id ?? u.userId) : [e?.user?.id ?? e?.userId];
    for (const id of ids) if (id && w.has(id)) syncUser(id);
}

export default definePlugin({
    name: "StalkerSuite",
    description: "Local presence-intelligence dashboard: timeline, sleep-schedule estimate, music taste, name/avatar history and a live radar for a watchlist of users — built only from the presence/activity data Discord already sends your client. Nothing leaves your machine.",
    authors: [{ name: "nerdrx", id: 0n }],
    settings,

    contextMenus: { "user-context": userCtx },

    toolboxActions: {
        "🕵️ Toggle Stalker Suite"() { if (panel && panel.style.display !== "none") hide(); else show(); },
        async "🗑 Wipe all logged data"() { db = {}; dirty = true; await persist(); showToast("Stalker Suite: history wiped", Toasts.Type.SUCCESS); render(); }
    },

    flux: {
        VOICE_STATE_UPDATES({ voiceStates }: { voiceStates: Array<{ userId: string; channelId?: string | null; }>; }) {
            const w = watch();
            for (const s of voiceStates) {
                if (!w.has(s.userId)) continue;
                if (s.channelId) {
                    const ch: any = ChannelStore.getChannel(s.channelId);
                    const gName = ch?.guild_id ? GuildStore.getGuild(ch.guild_id)?.name : "";
                    log(s.userId, "voice", `joined ${ch?.name ?? "voice"}`, gName || undefined);
                } else log(s.userId, "voice", "left voice");
            }
        },
        TYPING_START(e: any) {
            if (!settings.store.logTyping) return;
            const id = e?.userId; const w = watch();
            if (!id || !w.has(id)) return;
            typingUntil.set(id, Date.now() + 8000);
            const ch: any = ChannelStore.getChannel(e.channelId);
            log(id, "typing", `typing in ${ch?.name ? "#" + ch.name : "a channel"}`);
        }
    },

    async start() {
        await load();
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresence);
        sampler = setInterval(sample, 60_000);
        saveTimer = setInterval(persist, 30_000);
        ui = window.setInterval(() => { if (panel && panel.style.display !== "none" && (tab === "radar")) render(); }, 3000);
    },

    async stop() {
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresence);
        clearInterval(sampler); clearInterval(saveTimer); clearInterval(ui);
        await persist();
        panel?.remove(); panel = null;
    }
});
