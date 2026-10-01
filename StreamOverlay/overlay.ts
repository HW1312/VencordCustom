/*
 * StreamOverlay – the actual overlay page for the OBS browser source
 * Completely self-contained (HTML/CSS/JS in one string), only loads avatars/emojis from Discord's CDN.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { DEFAULTS, ENUMS, PARAMS, RANGES } from "./config";

// ---------------------------------------------------------------- CSS

const CSS = String.raw`
:root {
    --size: 48px;
    --accent: #43b581;
    --font: 16px;
    --radius: 50%;
    --text: #fff;
    --muted: rgba(255, 255, 255, .72);
    --danger: #f23f43;
    --pill: rgba(18, 19, 22, .62);
    --card: rgba(18, 19, 22, .72);
    --spring: cubic-bezier(.34, 1.45, .5, 1);
    --ease: cubic-bezier(.22, 1, .36, 1);
}
* { box-sizing: border-box; }
html, body {
    margin: 0;
    padding: 0;
    background: transparent !important;
    overflow: hidden;
}
body {
    padding: 8px;
    color: var(--text);
    font-family: "gg sans", "Noto Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: var(--font);
    font-weight: 600;
    -webkit-font-smoothing: antialiased;
}
/* Demo preview in a regular browser: dark background so you can see something */
html.demo, html.demo body { background: #1e1f22 !important; min-height: 100vh; }
body.shape-rounded { --radius: 28%; }
body.shape-square { --radius: 6%; }

/* Readability without a background */
body.bg-none .name, body.bg-none .header, body.bg-none .msg-body {
    text-shadow: 0 1px 2px rgba(0, 0, 0, .9), 0 0 6px rgba(0, 0, 0, .6);
}

/* ---------- Header ---------- */
.header {
    display: none;
    align-items: baseline;
    gap: .5em;
    margin: 0 0 .6em;
    font-size: 1.05em;
    font-weight: 800;
    animation: fade-in .4s var(--ease);
}
body.show-header.in-voice .header { display: flex; }
.header .guild { font-size: .75em; font-weight: 600; color: var(--muted); }
body.bg-pill .header, body.bg-card .header {
    width: fit-content;
    padding: .3em .8em;
    border-radius: 999px;
    background: var(--pill);
}
body.bg-card .header { border-radius: 10px; background: var(--card); }

/* ---------- Participants ---------- */
#users { display: flex; gap: 8px; }
body.hide-users #users { display: none; }
body.layout-list #users { flex-direction: column; align-items: flex-start; }
body.layout-row #users { flex-direction: row; flex-wrap: wrap; align-items: center; }
body.layout-grid #users { flex-direction: row; flex-wrap: wrap; align-items: flex-start; gap: 12px; }

.user {
    display: flex;
    align-items: center;
    gap: .55em;
    max-width: 100%;
    animation: user-in .45s var(--spring) both;
    transition: opacity .3s, transform .3s var(--ease), filter .3s;
}
.user.leaving { animation: user-out .32s var(--ease) forwards; pointer-events: none; }
body.layout-grid .user {
    flex-direction: column;
    gap: .35em;
    width: calc(var(--size) + 28px);
    text-align: center;
}
body.bg-card .user { padding: 6px 12px 6px 6px; border-radius: 12px; background: var(--card); }
body.bg-card.layout-grid .user { padding: 8px 6px; width: calc(var(--size) + 40px); }

.av-wrap {
    position: relative;
    flex: none;
    width: var(--size);
    height: var(--size);
    border-radius: var(--radius);
    transition: box-shadow .2s var(--ease), transform .25s var(--spring);
}
.av {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: var(--radius);
    object-fit: cover;
    background: rgba(128, 128, 128, .25);
    transition: filter .3s, opacity .3s;
}
.user.deaf .av, .user.srv-deaf .av { filter: grayscale(.6); opacity: .6; }

/* Speaking effects */
body.effect-glow .user.speaking .av-wrap {
    box-shadow: 0 0 0 3px var(--accent), 0 0 14px 3px color-mix(in srgb, var(--accent) 70%, transparent);
}
body.effect-ring .av-wrap { box-shadow: 0 0 0 2px transparent; }
body.effect-ring .user.speaking .av-wrap { box-shadow: 0 0 0 3px var(--accent); }
body.effect-ring .user.speaking .name { color: var(--accent); }
body.effect-bounce .user.speaking .av-wrap {
    animation: bounce .5s var(--ease) infinite alternate;
    box-shadow: 0 0 0 2px var(--accent);
}

.name {
    min-width: 0;
    max-width: 22em;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    transition: color .2s, background .2s;
}
body.hide-names .name { display: none; }
body.bg-pill .name { padding: .22em .7em; border-radius: 999px; background: var(--pill); }
body.bg-pill .user.speaking .name { box-shadow: inset 0 0 0 1.5px var(--accent); }
body.layout-grid .name { max-width: 100%; font-size: .8em; }
body.layout-grid.bg-pill .name { padding: .15em .5em; }

/* Status icons */
.icons { display: flex; align-items: center; gap: 3px; flex: none; }
body.hide-icons .icons { display: none; }
body.layout-grid .icons {
    position: absolute;
    right: -4px;
    bottom: -4px;
}
.icon {
    display: inline-flex;
    width: 1.15em;
    height: 1.15em;
    color: var(--muted);
    animation: pop-in .3s var(--spring);
}
.icon svg { width: 100%; height: 100%; }
.icon.red { color: var(--danger); }
body.layout-grid .icon {
    width: calc(var(--size) * .36);
    height: calc(var(--size) * .36);
    min-width: 16px;
    min-height: 16px;
    padding: 2px;
    border-radius: 50%;
    background: #1e1f22;
}
.live {
    padding: .05em .4em;
    border-radius: 4px;
    background: var(--danger);
    color: #fff;
    font-size: .62em;
    font-weight: 800;
    letter-spacing: .04em;
    animation: pop-in .3s var(--spring);
}
body.layout-grid .live { display: none; }

/* ---------- Chat ---------- */
#chat {
    display: none;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-top: 12px;
    max-width: 640px;
}
body.show-chat #chat { display: flex; }
body.hide-users #chat { margin-top: 0; }
.msg {
    display: flex;
    align-items: flex-start;
    gap: .5em;
    max-width: 100%;
    animation: msg-in .4s var(--spring) both;
    transition: opacity .6s var(--ease), transform .6s var(--ease);
}
.msg.gone { opacity: 0; transform: translateX(-12px); }
.msg.leaving { animation: user-out .3s var(--ease) forwards; }
body.bg-pill .msg, body.bg-card .msg { padding: .35em .75em .35em .35em; border-radius: 14px; background: var(--pill); }
body.bg-card .msg { border-radius: 10px; background: var(--card); }
.msg-av { flex: none; width: 1.6em; height: 1.6em; border-radius: var(--radius); object-fit: cover; }
.msg-body { min-width: 0; font-weight: 500; line-height: 1.35; word-wrap: break-word; overflow-wrap: anywhere; }
.msg-author { font-weight: 800; margin-right: .35em; }
.msg-text { white-space: pre-wrap; }
.emoji { width: 1.35em; height: 1.35em; vertical-align: -.3em; object-fit: contain; }
.emoji.jumbo { width: 2.2em; height: 2.2em; }

/* ---------- Animations ---------- */
@keyframes user-in { from { opacity: 0; transform: translateY(8px) scale(.85); } }
@keyframes user-out { to { opacity: 0; transform: scale(.85); } }
@keyframes msg-in { from { opacity: 0; transform: translateX(-16px); } }
@keyframes pop-in { from { opacity: 0; transform: scale(.4); } }
@keyframes fade-in { from { opacity: 0; } }
@keyframes bounce { from { transform: translateY(0) scale(1); } to { transform: translateY(-5px) scale(1.06); } }
@media (prefers-reduced-motion: reduce) { * { animation-duration: .01s !important; transition-duration: .01s !important; } }
`;

// ---------------------------------------------------------------- Script

const SCRIPT = String.raw`
(function () {
    "use strict";

    var DEFAULTS = __DEFAULTS__;
    var PARAMS = __PARAMS__;
    var ENUMS = __ENUMS__;
    var RANGES = __RANGES__;
    var q = new URLSearchParams(location.search);
    var demo = q.get("demo") === "1";

    var ICONS = {
        mic: "M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3 3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z",
        deaf: "M12 4c3.87 0 7 3.13 7 7v2h-2.92L21 17.92V11c0-4.97-4.03-9-9-9-1.95 0-3.76.62-5.23 1.68l1.44 1.44C9.3 4.41 10.6 4 12 4zM2.27 1.72 1 3l3.33 3.32C3.49 7.68 3 9.29 3 11v7c0 1.1.9 2 2 2h4v-8H5v-1c0-1.17.29-2.26.79-3.22L15 17v3h3.18l2.55 2.55 1.27-1.27L2.27 1.72z",
        cam: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"
    };

    var usersEl = document.getElementById("users");
    var chatEl = document.getElementById("chat");
    var headerName = document.querySelector(".header .channel");
    var headerGuild = document.querySelector(".header .guild");

    var state = null;
    var userEls = {};
    var msgEls = {};
    var lastSpoke = {};

    // ---------- Configuration: Discord settings, overridden by URL parameters
    function clamp(n, r) { return Math.min(r[1], Math.max(r[0], n)); }

    function config() {
        var base = q.get("fixed") === "1" ? DEFAULTS : ((state && state.config) || DEFAULTS);
        var c = {};
        for (var k in DEFAULTS) c[k] = k in base ? base[k] : DEFAULTS[k];
        for (var key in PARAMS) {
            var v = q.get(PARAMS[key]);
            if (v === null) continue;
            var def = DEFAULTS[key];
            if (typeof def === "boolean") c[key] = v === "1" || v === "true" || v === "";
            else if (typeof def === "number") { var n = parseFloat(v); if (!isNaN(n)) c[key] = RANGES[key] ? clamp(n, RANGES[key]) : n; }
            else if (ENUMS[key]) { if (ENUMS[key].indexOf(v) !== -1) c[key] = v; }
            else if (key === "accent") { if (/^#?[0-9a-f]{3,8}$/i.test(v)) c[key] = v.charAt(0) === "#" ? v : "#" + v; }
            else c[key] = v;
        }
        return c;
    }

    function applyConfig(c) {
        var root = document.documentElement.style;
        root.setProperty("--size", c.avatarSize + "px");
        root.setProperty("--font", c.fontSize + "px");
        root.setProperty("--accent", c.accent);
        document.body.className = [
            "layout-" + c.layout, "shape-" + c.shape, "effect-" + c.effect, "bg-" + c.background,
            c.showNames ? "" : "hide-names",
            c.showIcons ? "" : "hide-icons",
            c.showUsers ? "" : "hide-users",
            c.showHeader ? "show-header" : "",
            c.chat ? "show-chat" : "",
            state && state.channel ? "in-voice" : ""
        ].join(" ");
    }

    // ---------- Helpers
    function el(tag, cls) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        return e;
    }

    function svg(path) {
        return '<svg viewBox="0 0 24 24"><path fill="currentColor" d="' + path + '"/></svg>';
    }

    function safeImg(url) {
        return typeof url === "string" && /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//.test(url) ? url : "";
    }

    /** Remove nodes gently (wait for the fade-out animation) */
    function removeSoft(node, map, id) {
        if (node.classList.contains("leaving")) return;
        node.classList.add("leaving");
        delete map[id];
        setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 350);
    }

    /** Restore order without moving existing nodes unnecessarily (otherwise animations restart) */
    function order(container, nodes) {
        var cur = container.firstChild;
        for (var i = 0; i < nodes.length; i++) {
            while (cur && cur.classList.contains("leaving")) cur = cur.nextSibling;
            if (cur === nodes[i]) cur = cur.nextSibling;
            else container.insertBefore(nodes[i], cur);
        }
    }

    // ---------- Participants
    function visibleUsers(c) {
        var now = Date.now();
        var list = (state && state.users) || [];
        return list.filter(function (u) {
            if (u.speaking) lastSpoke[u.id] = now;
            var recentlySpoke = u.speaking || now - (lastSpoke[u.id] || 0) < 1200;
            if (c.onlySpeaking && !recentlySpoke) return false;
            if (c.hideMuted && (u.selfMute || u.mute || u.selfDeaf || u.deaf) && !recentlySpoke) return false;
            return true;
        });
    }

    function renderUser(u, c) {
        var node = userEls[u.id];
        if (!node) {
            node = el("div", "user");
            var wrap = el("div", "av-wrap");
            var img = el("img", "av");
            img.alt = "";
            img.referrerPolicy = "no-referrer";
            wrap.appendChild(img);
            node.appendChild(wrap);
            node.appendChild(el("div", "name"));
            var icons = el("div", "icons");
            // In the grid the icons sit at the bottom right of the avatar
            node.appendChild(icons);
            node._img = img;
            node._wrap = wrap;
            node._name = node.children[1];
            node._icons = icons;
            userEls[u.id] = node;
        }

        var src = safeImg(c.animated && u.avatarAnimated ? u.avatarAnimated : u.avatar);
        if (node._src !== src) { node._src = src; node._img.src = src; }
        if (node._name.textContent !== u.name) node._name.textContent = u.name;

        var grid = c.layout === "grid";
        var iconParent = grid ? node._wrap : node;
        if (node._icons.parentNode !== iconParent) iconParent.appendChild(node._icons);

        var iconKey = [u.selfMute, u.mute, u.selfDeaf, u.deaf, u.stream, u.video].join();
        if (node._iconKey !== iconKey) {
            node._iconKey = iconKey;
            var html = "";
            if (u.deaf || u.selfDeaf) html += '<span class="icon' + (u.deaf ? " red" : "") + '">' + svg(ICONS.deaf) + "</span>";
            else if (u.mute || u.selfMute) html += '<span class="icon' + (u.mute ? " red" : "") + '">' + svg(ICONS.mic) + "</span>";
            if (u.video) html += '<span class="icon">' + svg(ICONS.cam) + "</span>";
            if (u.stream) html += '<span class="live">LIVE</span>';
            node._icons.innerHTML = html;
        }

        node.classList.toggle("speaking", !!u.speaking);
        node.classList.toggle("deaf", !!u.selfDeaf);
        node.classList.toggle("srv-deaf", !!u.deaf);
        return node;
    }

    function renderUsers(c) {
        var list = c.showUsers ? visibleUsers(c) : [];
        var seen = {};
        var nodes = list.map(function (u) { seen[u.id] = true; return renderUser(u, c); });
        for (var id in userEls) if (!seen[id]) removeSoft(userEls[id], userEls, id);
        order(usersEl, nodes);
    }

    // ---------- Chat
    function renderParts(parts, target) {
        var onlyEmojis = parts.length > 0 && parts.length <= 3 && parts.every(function (p) {
            return p.t === "emoji" || !p.v.trim();
        });
        parts.forEach(function (p) {
            if (p.t === "emoji" && safeImg(p.url)) {
                var img = el("img", "emoji" + (onlyEmojis ? " jumbo" : ""));
                img.src = p.url;
                img.alt = ":" + p.v + ":";
                img.referrerPolicy = "no-referrer";
                target.appendChild(img);
            } else {
                target.appendChild(document.createTextNode(p.t === "emoji" ? ":" + p.v + ":" : p.v));
            }
        });
    }

    function renderMessage(m) {
        var node = msgEls[m.id];
        var key = JSON.stringify(m.parts) + m.author + m.avatar + (m.color || "");
        if (node && node._key === key) return node;
        if (!node) {
            node = el("div", "msg");
            msgEls[m.id] = node;
        }
        node._key = key;
        node._ts = m.ts;
        node.innerHTML = "";

        var av = el("img", "msg-av");
        av.src = safeImg(m.avatar);
        av.alt = "";
        av.referrerPolicy = "no-referrer";
        var body = el("div", "msg-body");
        var author = el("span", "msg-author");
        author.textContent = m.author;
        if (m.color) author.style.color = m.color;
        var text = el("span", "msg-text");
        renderParts(m.parts || [], text);
        body.appendChild(author);
        body.appendChild(text);
        node.appendChild(av);
        node.appendChild(body);
        return node;
    }

    function renderChat(c) {
        var list = c.chat && state && state.messages ? state.messages.slice(-c.chatMax) : [];
        var seen = {};
        var nodes = list.map(function (m) { seen[m.id] = true; return renderMessage(m); });
        for (var id in msgEls) if (!seen[id]) removeSoft(msgEls[id], msgEls, id);
        order(chatEl, nodes);
        fadeMessages(c);
    }

    function fadeMessages(c) {
        var now = Date.now();
        for (var id in msgEls) {
            var node = msgEls[id];
            node.classList.toggle("gone", c.chatFade > 0 && now - node._ts > c.chatFade * 1000);
        }
    }

    // ---------- Overall
    var current = DEFAULTS;
    function render() {
        current = config();
        applyConfig(current);
        var ch = state && state.channel;
        headerName.textContent = ch ? ch.name : "";
        headerGuild.textContent = ch && ch.guild ? ch.guild : "";
        renderUsers(current);
        renderChat(current);
    }

    // Follow-up for "only speaking" and chat fade-out
    setInterval(function () {
        if (current.onlySpeaking || current.hideMuted) renderUsers(current);
        if (current.chat) fadeMessages(current);
    }, 400);

    // ---------- Demo data (?demo=1) for setup without a voice channel
    function startDemo() {
        var names = ["Luna", "Max", "Mia", "Jonas"];
        var tick = 0;
        function demoState() {
            tick++;
            return {
                config: state && state.config,
                channel: { name: "Gaming", guild: "Demo Server" },
                users: names.map(function (n, i) {
                    return {
                        id: "demo" + i,
                        name: n,
                        avatar: "https://cdn.discordapp.com/embed/avatars/" + i + ".png",
                        speaking: (tick + i) % 4 === 0,
                        selfMute: i === 2,
                        selfDeaf: false,
                        mute: false,
                        deaf: i === 3 && tick % 8 < 4,
                        stream: i === 1,
                        video: i === 0
                    };
                }),
                messages: [
                    { id: "m1", author: "Luna", avatar: "https://cdn.discordapp.com/embed/avatars/0.png", ts: Date.now() - 4000, parts: [{ t: "text", v: "gg, next round?" }] },
                    { id: "m2", author: "Max", color: "#e67e22", avatar: "https://cdn.discordapp.com/embed/avatars/1.png", ts: Date.now() - 2000, parts: [{ t: "text", v: "I'm in " }] }
                ]
            };
        }
        function step() {
            var cfgOnly = state && state.config;
            state = demoState();
            state.config = cfgOnly;
            render();
        }
        step();
        setInterval(step, 900);
    }

    // ---------- Connection
    var lostTimer = null;
    function connect() {
        var es = new EventSource("/events");
        es.onmessage = function (e) {
            clearTimeout(lostTimer);
            try {
                var next = JSON.parse(e.data);
                if (demo) { state = state || {}; state.config = next.config; return; }
                state = next;
                render();
            } catch (err) { /* ignore invalid data */ }
        };
        es.onerror = function () {
            // Discord closed? Clear after a short time instead of leaving stale data
            clearTimeout(lostTimer);
            lostTimer = setTimeout(function () {
                if (demo) return;
                state = state ? { config: state.config } : null;
                render();
            }, 5000);
        };
    }

    render();
    connect();
    if (demo) {
        document.documentElement.classList.add("demo");
        startDemo();
    }
})();
`;

// ---------------------------------------------------------------- Page

export function buildOverlayHtml() {
    // Escape "<" so JSON never produces a </script>
    const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
    const script = SCRIPT
        .replace("__DEFAULTS__", () => json(DEFAULTS))
        .replace("__PARAMS__", () => json(PARAMS))
        .replace("__ENUMS__", () => json(ENUMS))
        .replace("__RANGES__", () => json(RANGES));

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StreamOverlay</title>
<style>${CSS}</style>
</head>
<body>
<div class="header"><span class="channel"></span><span class="guild"></span></div>
<div id="users"></div>
<div id="chat"></div>
<script>${script}</script>
</body>
</html>`;
}
