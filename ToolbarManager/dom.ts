/*
 * ToolbarManager – detecting buttons in the DOM, CSS control & Vencord chat button marking
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChatBarButtonFactory, ChatBarButtonMap } from "@api/ChatButtons";
import { plugins } from "@api/PluginManager";
import { findCssClassesLazy } from "@webpack";
import { React } from "@webpack/common";

import { Bar, BARS, data, emit, getState, isVencordKey, listKeys, logger, present, registerSeen, SeenButton, subscribe, vencordId } from "./store";

/*
 * How it works:
 * - Every button gets an attribute `data-vc-tbm-item="<key>"` (Discord's own via MutationObserver,
 *   Vencord chat buttons additionally via a `display:contents` wrapper `data-vc-tbm-key`, so they
 *   look correct from the very first render).
 * - A generated <style> sets per key `order` (ordering), `display:none` (hidden) or
 *   "invisibly overlaid" (⋯ menu).
 * - Buttons in the ⋯ menu stay in the DOM (not display:none): they sit invisible and unclickable
 *   exactly on top of the ⋯ button. A programmatic `.click()` keeps working, and popouts
 *   anchored to the button open at the ⋯ button's position instead of somewhere at the screen edge.
 */

export const ATTR_ITEM = "data-vc-tbm-item";
export const ATTR_KEY = "data-vc-tbm-key";
export const ATTR_CONTAINER = "data-vc-tbm-c";
export const ATTR_FIXED = "data-vc-tbm-fixed";
export const ATTR_ANCHOR = "data-vc-tbm-anchor";

const ChannelTextAreaClasses = findCssClassesLazy("buttonContainer", "channelTextArea", "button");

// ---------------------------------------------------------------- Marking Vencord chat buttons

const originals = new Map<string, ChatBarButtonFactory>();
const wrappers = new WeakSet<ChatBarButtonFactory>();

function makeWrapper(id: string, Orig: ChatBarButtonFactory): ChatBarButtonFactory {
    const Wrapped: ChatBarButtonFactory = props => React.createElement(
        "span",
        { [ATTR_KEY]: `vc:${id}`, className: "vc-toolbarmanager-contents" },
        React.createElement(Orig, props)
    );
    wrappers.add(Wrapped);
    return Wrapped;
}

/** Wrap all Vencord chat buttons (including ones added later) */
function wrapChatButtons() {
    for (const [id, entry] of ChatBarButtonMap) {
        if (wrappers.has(entry.render)) continue;
        originals.set(id, entry.render);
        ChatBarButtonMap.set(id, { ...entry, render: makeWrapper(id, entry.render) });
    }
}

function unwrapChatButtons() {
    for (const [id, entry] of ChatBarButtonMap) {
        const orig = originals.get(id);
        if (orig && wrappers.has(entry.render)) ChatBarButtonMap.set(id, { ...entry, render: orig });
    }
    originals.clear();
}

// ---------------------------------------------------------------- Keys & Namen

const SEND_LABEL = /^(nachricht )?senden$|^send( message)?$/i;

function labelOf(el: Element): string | null {
    const own = el.getAttribute("aria-label");
    if (own?.trim()) return own.trim();
    const inner = el.querySelector("[aria-label]")?.getAttribute("aria-label");
    return inner?.trim() || null;
}

/** Must never be touched: text input, send button */
function isProtected(el: Element) {
    if (el.matches("textarea, [role='textbox'], [contenteditable='true']")) return true;
    if (el.querySelector("textarea, [role='textbox'], [contenteditable='true'], [class*='sendButton']")) return true;
    const label = labelOf(el);
    return !!label && SEND_LABEL.test(label);
}

function vcPrefixOf(el: Element): string | null {
    const candidates = [el, ...Array.from(el.querySelectorAll("[class*='vc-']")).slice(0, 12)];
    for (const c of candidates) {
        for (const cls of Array.from(c.classList)) {
            const m = /^vc-([a-z0-9]+)-/.exec(cls);
            if (m && m[1] !== "chatbar") return `vc-${m[1]}`;
        }
    }
    return null;
}

function pluginNameForPrefix(prefix: string): string | null {
    const short = prefix.slice(3);
    for (const name of Object.keys(plugins)) {
        if (name.toLowerCase() === short) return name;
    }
    return null;
}

/** Strips everything active from an SVG (scripts, event handlers, foreign content) */
export function stripUnsafe(root: Element) {
    root.querySelectorAll("script, foreignObject, style, image, iframe").forEach(n => n.remove());
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
        for (const a of Array.from(el.attributes)) {
            if (/^on/i.test(a.name) || /javascript:/i.test(a.value)) el.removeAttribute(a.name);
        }
    }
}

export function sanitizeSvg(svg: SVGElement): string | undefined {
    try {
        const c = svg.cloneNode(true) as SVGElement;
        stripUnsafe(c);
        c.removeAttribute("class");
        c.setAttribute("width", "20");
        c.setAttribute("height", "20");
        const html = c.outerHTML;
        return html.length <= 8000 ? html : undefined;
    } catch {
        return undefined;
    }
}

function iconOf(el: Element) {
    const svg = el.querySelector("svg");
    return svg ? sanitizeSvg(svg) : undefined;
}

interface Item {
    key: string;
    /** The elements that make up the flex item (for Vencord wrappers, the wrapper's children) */
    els: Element[];
    /** Name/kind/icon - only computed for new buttons (cloning the icon is comparatively expensive) */
    describe(): SeenButton;
}

const seenButton = (key: string, name: string, kind: SeenButton["kind"], el: Element): SeenButton =>
    ({ key, name, kind, icon: iconOf(el), lastSeen: Date.now() });

function chatItemOf(child: Element): Item | null {
    // Vencord-Chatbutton im Wrapper
    const vcKey = child.getAttribute(ATTR_KEY);
    if (vcKey) {
        const els = Array.from(child.children);
        if (!els.length) return null;
        return { key: vcKey, els, describe: () => seenButton(vcKey, vencordId(vcKey), "vencord", child) };
    }
    if (isProtected(child)) return null;
    const label = labelOf(child);
    if (!label) return null;
    const key = `n:${label}`;
    return { key, els: [child], describe: () => seenButton(key, label, "native", child) };
}

function titleItemOf(child: Element): Item | null {
    if (isProtected(child)) return null;
    const prefix = vcPrefixOf(child);
    const label = labelOf(child);
    if (prefix) {
        const key = `t:${prefix}`;
        return {
            key,
            els: [child],
            describe: () => seenButton(key, prefix === "vc-toolbarmanager" ? "⋯ menu" : pluginNameForPrefix(prefix) ?? label ?? prefix, "plugin", child)
        };
    }
    if (!label) return null;
    const key = `t:${label}`;
    return { key, els: [child], describe: () => seenButton(key, label, "native", child) };
}

// ---------------------------------------------------------------- Container finden

function chatContainers(): Set<Element> {
    const out = new Set<Element>();
    document.querySelectorAll(`[${ATTR_KEY}]`).forEach(el => el.parentElement && out.add(el.parentElement));
    try {
        const buttonContainer = ChannelTextAreaClasses.buttonContainer?.split(" ")[0];
        const channelTextArea = ChannelTextAreaClasses.channelTextArea?.split(" ")[0];
        if (buttonContainer && channelTextArea) {
            document.querySelectorAll(`.${channelTextArea} .${buttonContainer}`).forEach(el => {
                const parent = el.parentElement;
                // Vencord buttons live in the wrapper - so the container is one level higher
                if (!parent || parent.hasAttribute(ATTR_KEY) || out.has(parent)) return;
                // Only the actual button bar (multiple buttons), not e.g. the single upload button
                const count = Array.from(parent.children).filter(c => c.classList.contains(buttonContainer)).length;
                if (count >= 2) out.add(parent);
            });
        }
    } catch { /* classes not found (yet) */ }
    return out;
}

function titleContainers(): Set<Element> {
    const out = new Set<Element>();
    document.querySelectorAll(`[${ATTR_ANCHOR}="title"]`).forEach(el => el.parentElement && out.add(el.parentElement));
    return out;
}

// ---------------------------------------------------------------- Scan

function scanContainer(bar: Bar, container: Element, keys: Set<string>) {
    if (container.getAttribute(ATTR_CONTAINER) !== bar) container.setAttribute(ATTR_CONTAINER, bar);

    const found: SeenButton[] = [];
    const domKeys: string[] = [];
    let anyKeyed = false;

    for (const child of Array.from(container.children)) {
        if (child.hasAttribute(ATTR_ANCHOR)) continue;
        const item = bar === "chat" ? chatItemOf(child) : titleItemOf(child);
        if (!item) {
            // Keep unmanaged elements (e.g. send) in their natural place
            const fixed = anyKeyed ? "end" : "start";
            if (child.getAttribute(ATTR_FIXED) !== fixed && !child.hasAttribute(ATTR_KEY)) child.setAttribute(ATTR_FIXED, fixed);
            continue;
        }
        anyKeyed = true;
        for (const el of item.els) {
            if (el.getAttribute(ATTR_ITEM) !== item.key) el.setAttribute(ATTR_ITEM, item.key);
            el.removeAttribute(ATTR_FIXED);
        }
        keys.add(item.key);
        domKeys.push(item.key);
        const known = data[bar].seen[item.key];
        // Newly detected - or so far without an icon preview (e.g. because the icon was rendered later)
        if (!known || (!known.icon && item.els.some(el => el.querySelector("svg")))) found.push(item.describe());
    }

    registerSeen(bar, found, domKeys);
}

let scanning = false;

export function scan() {
    if (scanning) return;
    scanning = true;
    try {
        wrapChatButtons();
        const next: Record<Bar, Set<string>> = { chat: new Set(), title: new Set() };
        for (const c of chatContainers()) scanContainer("chat", c, next.chat);
        for (const c of titleContainers()) scanContainer("title", c, next.title);

        let changed = false;
        for (const bar of BARS) {
            const prev = present[bar];
            if (prev.size !== next[bar].size || [...next[bar]].some(k => !prev.has(k))) {
                present[bar] = next[bar];
                changed = true;
            }
        }
        if (changed) emit();
    } catch (e) {
        logger.error("Scan failed", e);
    } finally {
        scanning = false;
    }
}

// ---------------------------------------------------------------- CSS

function selectorFor(bar: Bar, key: string) {
    const k = CSS.escape(key);
    const c = `[${ATTR_CONTAINER}="${bar}"]`;
    return `${c} > [${ATTR_ITEM}="${k}"], ${c} > [${ATTR_KEY}="${k}"] > *`;
}

function buildCss() {
    const rules: string[] = [
        `[${ATTR_CONTAINER}] { position: relative; }`,
        `[${ATTR_FIXED}="start"] { order: -1; }`,
        `[${ATTR_FIXED}="end"] { order: 100000; }`
    ];

    for (const bar of BARS) {
        listKeys(bar).forEach((key, i) => {
            const state = getState(bar, key);
            const selector = selectorFor(bar, key);
            rules.push(`${selector} { order: ${i + 1}; }`);
            if (state === "hidden") rules.push(`${selector} { display: none !important; }`);
            else if (state === "menu") rules.push(`${selector} {
    position: absolute !important;
    left: var(--vc-tbm-dock-x, auto) !important;
    top: var(--vc-tbm-dock-y, 0) !important;
    margin: 0 !important;
    opacity: 0 !important;
    pointer-events: none !important;
}`);
        });
    }
    return rules.join("\n");
}

let styleEl: HTMLStyleElement | null = null;

function applyCss() {
    if (!styleEl) return;
    const css = buildCss();
    if (styleEl.textContent !== css) styleEl.textContent = css;
}

// ---------------------------------------------------------------- Triggering menu buttons

/** Buttons of a bar that are in the ⋯ menu, in the same container as `from` */
export function collapsedItemsNear(bar: Bar, from: Element | null): { key: string; el: Element; name: string; }[] {
    const container = from?.closest(`[${ATTR_CONTAINER}="${bar}"]`) ?? document.querySelector(`[${ATTR_CONTAINER}="${bar}"]`);
    if (!container) return [];
    const out: { key: string; el: Element; name: string; }[] = [];
    const seenKeys = new Set<string>();
    for (const el of Array.from(container.querySelectorAll(`[${ATTR_ITEM}]`))) {
        const key = el.getAttribute(ATTR_ITEM)!;
        if (seenKeys.has(key) || getState(bar, key) !== "menu") continue;
        // only direct items (or children of a Vencord wrapper)
        const parent = el.parentElement;
        if (parent !== container && parent?.parentElement !== container) continue;
        seenKeys.add(key);
        out.push({ key, el, name: data[bar].seen[key]?.name ?? labelOf(el) ?? key });
    }
    const order = listKeys(bar);
    return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

/** Place hidden buttons exactly over the ⋯ button (for popouts) */
export function positionUnderDock(dock: Element) {
    const container = dock.closest(`[${ATTR_CONTAINER}]`) as HTMLElement | null;
    if (!container) return;
    const c = container.getBoundingClientRect();
    const d = dock.getBoundingClientRect();
    container.style.setProperty("--vc-tbm-dock-x", `${Math.round(d.left - c.left)}px`);
    container.style.setProperty("--vc-tbm-dock-y", `${Math.round(d.top - c.top)}px`);
}

/** Trigger the original button (only after the user clicks it in the ⋯ menu) */
export function activate(el: Element) {
    const target = (el.matches("button, [role='button']") ? el : el.querySelector("button, [role='button']")) ?? el;
    (target as HTMLElement).click();
}

// ---------------------------------------------------------------- Right-click on buttons

export interface ItemHit { bar: Bar; key: string; el: Element; }

export function hitTest(target: EventTarget | null): ItemHit | null {
    if (!(target instanceof Element)) return null;
    const el = target.closest(`[${ATTR_ITEM}]`);
    if (!el) return null;
    const container = el.closest(`[${ATTR_CONTAINER}]`);
    const bar = container?.getAttribute(ATTR_CONTAINER) as Bar | null;
    if (!bar || !BARS.includes(bar)) return null;
    const key = el.getAttribute(ATTR_ITEM)!;
    if (bar === "chat" && !isVencordKey(key) && !key.startsWith("n:")) return null;
    return { bar, key, el };
}

// ---------------------------------------------------------------- Start / Stop

let observer: MutationObserver | null = null;
let unsubscribe: (() => void) | null = null;
let rescanQueued = false;

function queueRescan() {
    if (rescanQueued) return;
    rescanQueued = true;
    requestAnimationFrame(() => {
        rescanQueued = false;
        scan();
    });
}

export function startDom() {
    styleEl = document.createElement("style");
    styleEl.id = "vc-toolbarmanager-dynamic";
    document.head.appendChild(styleEl);

    unsubscribe = subscribe(() => {
        applyCss();
        queueRescan();
    });

    // Scan synchronously in the observer callback (microtask before painting) -> no flicker after a re-render
    observer = new MutationObserver(() => scan());
    observer.observe(document.body, { childList: true, subtree: true });

    wrapChatButtons();
    applyCss();
    scan();
}

export function stopDom() {
    observer?.disconnect();
    observer = null;
    unsubscribe?.();
    unsubscribe = null;
    styleEl?.remove();
    styleEl = null;
    unwrapChatButtons();

    for (const attr of [ATTR_ITEM, ATTR_CONTAINER, ATTR_FIXED]) {
        document.querySelectorAll(`[${attr}]`).forEach(el => el.removeAttribute(attr));
    }
    document.querySelectorAll("[style*='--vc-tbm-dock']").forEach(el => {
        (el as HTMLElement).style.removeProperty("--vc-tbm-dock-x");
        (el as HTMLElement).style.removeProperty("--vc-tbm-dock-y");
    });
    for (const bar of BARS) present[bar] = new Set();
    emit();
}
