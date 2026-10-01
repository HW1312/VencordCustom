/*
 * HomeOrganizer – divider fix for PinDMs
 * PinDMs renders category headings as <h2 class="… vc-pindms-section-container">. CSS alone can't filter by
 * text content, so a MutationObserver tags headings whose name consists only of dashes/underscores
 * (or similar characters) with its own class. The actual styling lives in ui.css.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const HEADER_SELECTOR = ".vc-pindms-section-container";
const DIVIDER_CLASS = "vc-homeorganizer-divider";
/** Only dashes, underscores, equals signs, dots, etc. - at least three characters */
const DIVIDER_RE = /^[\s\-_–—=·.•~]{3,}$/;

let observer: MutationObserver | null = null;
let frame = 0;

function scan() {
    frame = 0;
    for (const el of document.querySelectorAll<HTMLElement>(HEADER_SELECTOR)) {
        const text = el.textContent ?? "";
        el.classList.toggle(DIVIDER_CLASS, DIVIDER_RE.test(text));
    }
}

function schedule() {
    if (!frame) frame = requestAnimationFrame(scan);
}

export function startDividerFix() {
    if (observer) return;
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    schedule();
}

export function stopDividerFix() {
    observer?.disconnect();
    observer = null;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const el of document.querySelectorAll(`.${DIVIDER_CLASS}`)) el.classList.remove(DIVIDER_CLASS);
}
