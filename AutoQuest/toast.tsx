/*
 * AutoQuest – own little notifications at the top right inside Discord (instead of Windows notifications).
 * They slide in, stay 6 s (longer while hovered), and a click runs their action.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { createRoot, useEffect, useRef, useState } from "@webpack/common";
import type { ReactNode } from "react";

const cl = classNameFactory("vc-autoquest-");

export type ToastKind = "success" | "attention" | "info";

export interface ToastData {
    title: string;
    body: string;
    kind?: ToastKind;
    /** Quest tile */
    image?: string;
    /** Shown at the right, e.g. the reward */
    side?: ReactNode;
    onClick?(): void;
}

interface Item extends ToastData { id: number; }

const SHOW_MS = 6000;
const MAX = 4;

let items: Item[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function mount() {
    if (root) return;
    host = document.createElement("div");
    host.className = cl("toasts-host");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<ErrorBoundary noop><Toasts /></ErrorBoundary>);
}

export function showQuestToast(data: ToastData) {
    mount();
    items = [...items, { ...data, id: nextId++ }].slice(-MAX);
    emit();
}

function dismiss(id: number) {
    items = items.filter(t => t.id !== id);
    emit();
}

export function unmountToasts() {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
    items = [];
}

const CLOSE_PATH = "M17.3 18.7a1 1 0 0 0 1.4-1.4L13.42 12l5.3-5.3a1 1 0 0 0-1.42-1.4L12 10.58l-5.3-5.3a1 1 0 0 0-1.4 1.42L10.58 12l-5.3 5.3a1 1 0 1 0 1.42 1.4L12 13.42l5.3 5.3Z";
const KIND_PATH: Record<ToastKind, string> = {
    success: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z",
    attention: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z",
    info: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z"
};

function Toast({ item }: { item: Item; }) {
    const kind = item.kind ?? "info";
    const [leaving, setLeaving] = useState(false);
    const [broken, setBroken] = useState(false);
    const hovered = useRef(false);
    const left = useRef(SHOW_MS);

    const close = () => {
        setLeaving(true);
        setTimeout(() => dismiss(item.id), 180);
    };

    // Counts down only while not hovered
    useEffect(() => {
        let last = Date.now();
        const t = setInterval(() => {
            const now = Date.now();
            if (!hovered.current) left.current -= now - last;
            last = now;
            if (left.current <= 0) {
                clearInterval(t);
                close();
            }
        }, 50);
        return () => clearInterval(t);
    }, []);

    return (
        <div
            className={classes(cl("toast"), cl(`toast-${kind}`), leaving && cl("toast-leave"), item.onClick && cl("toast-click"))}
            onMouseEnter={() => hovered.current = true}
            onMouseLeave={() => hovered.current = false}
            onClick={() => {
                if (!item.onClick) return;
                item.onClick();
                close();
            }}
        >
            <button className={cl("toast-close")} aria-label="Close" onClick={e => { e.stopPropagation(); close(); }}>
                <svg viewBox="0 0 24 24" width={10} height={10}><path fill="currentColor" d={CLOSE_PATH} /></svg>
            </button>
            {item.image && !broken
                ? <img className={cl("toast-img")} src={item.image} alt="" onError={() => setBroken(true)} />
                : <div className={cl("toast-icon")}><svg viewBox="0 0 24 24" width={20} height={20}><path fill="currentColor" d={KIND_PATH[kind]} /></svg></div>}
            <div className={cl("toast-main")}>
                <div className={cl("toast-head")}>
                    <span className={cl("toast-title")}>{item.title}</span>
                    <span className={cl("toast-when")}>now</span>
                </div>
                <div className={cl("toast-body")}>{item.body}</div>
                {item.side && <div className={cl("toast-side")}>{item.side}</div>}
            </div>
        </div>
    );
}

function Toasts() {
    const [, setTick] = useState(0);
    useEffect(() => {
        const l = () => setTick(t => t + 1);
        listeners.add(l);
        return () => void listeners.delete(l);
    }, []);

    return (
        <div className={cl("toasts")}>
            {items.map(t => <Toast key={t.id} item={t} />)}
        </div>
    );
}
