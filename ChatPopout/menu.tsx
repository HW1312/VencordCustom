/*
 * ChatPopout – right-click menu inside the popout window
 * Discord's context menus render into the main window, so this is a recreation in Discord's style.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { cl, Icon } from "./shared";

export interface MenuItem {
    id: string;
    label: string;
    icon?: string;
    danger?: boolean;
    /** Needs a second click (Shift skips it) */
    confirm?: string;
    action(e: React.MouseEvent): void;
}

export interface MenuState {
    x: number;
    y: number;
    sections: MenuItem[][];
}

const EDGE = 8;

export function ContextMenu({ state, onClose }: { state: MenuState; onClose(): void; }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: state.x, top: state.y, ready: false });
    const [confirming, setConfirming] = useState<string | null>(null);
    const [active, setActive] = useState(-1);
    const items = state.sections.flat();

    // Keep the menu inside the window (flip to the left/top like Discord)
    useLayoutEffect(() => {
        const el = ref.current;
        const win = el?.ownerDocument.defaultView;
        if (!el || !win) return;
        const { width, height } = el.getBoundingClientRect();
        let left = state.x, top = state.y;
        if (left + width > win.innerWidth - EDGE) left = Math.max(EDGE, state.x - width);
        if (top + height > win.innerHeight - EDGE) top = Math.max(EDGE, win.innerHeight - height - EDGE);
        setPos({ left, top, ready: true });
        setConfirming(null);
        setActive(-1);
    }, [state]);

    useEffect(() => {
        const el = ref.current;
        const doc = el?.ownerDocument;
        const win = doc?.defaultView;
        if (!doc || !win) return;

        const onDown = (e: MouseEvent) => !el.contains(e.target as Node) && onClose();
        const onWheel = (e: WheelEvent) => !el.contains(e.target as Node) && onClose();
        doc.addEventListener("mousedown", onDown, true);
        doc.addEventListener("wheel", onWheel, true);
        win.addEventListener("blur", onClose);
        win.addEventListener("resize", onClose);
        return () => {
            doc.removeEventListener("mousedown", onDown, true);
            doc.removeEventListener("wheel", onWheel, true);
            win.removeEventListener("blur", onClose);
            win.removeEventListener("resize", onClose);
        };
    }, [onClose]);

    // Keyboard: arrows, Enter, Esc
    useEffect(() => {
        const doc = ref.current?.ownerDocument;
        if (!doc) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") setActive(a => (a + 1) % items.length);
            else if (e.key === "ArrowUp") setActive(a => (a - 1 + items.length) % items.length);
            else if (e.key === "Enter" && active >= 0) ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.click();
            else return;
            e.preventDefault();
            e.stopPropagation();
        };
        doc.addEventListener("keydown", onKey, true);
        return () => doc.removeEventListener("keydown", onKey, true);
    }, [items.length, active, onClose]);

    const run = (item: MenuItem, e: React.MouseEvent) => {
        if (item.confirm && confirming !== item.id && !e.shiftKey) {
            setConfirming(item.id);
            return;
        }
        onClose();
        item.action(e);
    };

    let index = 0;
    return (
        <div
            ref={ref}
            className={cl("menu")}
            role="menu"
            style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
            onContextMenu={e => e.preventDefault()}
        >
            {state.sections.filter(s => s.length).map((section, si) => (
                <div key={si} className={cl("menu-section")}>
                    {section.map(item => {
                        const i = index++;
                        const confirm = confirming === item.id;
                        return (
                            <button
                                key={item.id}
                                data-index={i}
                                role="menuitem"
                                className={classes(cl("menu-item"), item.danger && cl("menu-item-danger"), i === active && cl("menu-item-active"), confirm && cl("menu-item-confirm"))}
                                onMouseEnter={() => setActive(i)}
                                onClick={e => run(item, e)}
                            >
                                <span className={cl("menu-label")}>{confirm ? item.confirm : item.label}</span>
                                {item.icon && <Icon path={item.icon} size={18} className={cl("menu-icon")} />}
                            </button>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}
