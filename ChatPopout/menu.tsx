/*
 * ChatPopout – right-click menu inside the popout window
 * Discord's context menus render into the main window, so this is a recreation in Discord's style.
 * Sub lists (e.g. "Move To") open inside the menu with a back button, so it always fits the window.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classes } from "@utils/misc";
import { useEffect, useLayoutEffect, useRef, useState } from "@webpack/common";

import { cl, Icon, LEFT_PATH, RIGHT_PATH } from "./shared";

export interface MenuItem {
    id: string;
    label: string;
    icon?: string;
    danger?: boolean;
    /** Needs a second click (Shift skips it) */
    confirm?: string;
    action?(e: React.MouseEvent): void;
    /** Checkbox on the right – clicking runs the action and keeps the menu open */
    checked?: () => boolean;
    /** Custom content instead of a button (e.g. a slider) */
    render?: () => React.ReactNode;
    /** Opens a list inside the menu */
    submenu?: () => MenuItem[];
}

export interface MenuState {
    x: number;
    y: number;
    sections: MenuItem[][];
}

const EDGE = 8;

function CheckBox({ on }: { on: boolean; }) {
    return (
        <span className={classes(cl("menu-check"), on && cl("menu-check-on"))}>
            {on && <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden><path fill="currentColor" d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" /></svg>}
        </span>
    );
}

export function ContextMenu({ state, onClose }: { state: MenuState; onClose(): void; }) {
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: state.x, top: state.y, ready: false });
    const [confirming, setConfirming] = useState<string | null>(null);
    const [active, setActive] = useState(-1);
    const [sub, setSub] = useState<{ label: string; items: MenuItem[]; } | null>(null);
    /** Checkbox states changed in this menu (the stores update with a delay) */
    const [overrides, setOverrides] = useState<Record<string, boolean>>({});

    const sections = sub ? [sub.items] : state.sections;
    const buttons = sections.flat().filter(i => !i.render);

    useEffect(() => {
        setSub(null);
        setOverrides({});
    }, [state]);

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
    }, [state, sub]);

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

    // Keyboard: arrows, Enter, Esc (Esc in a sub list goes back)
    useEffect(() => {
        const doc = ref.current?.ownerDocument;
        if (!doc) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") sub ? setSub(null) : onClose();
            else if (e.key === "ArrowDown") setActive(a => (a + 1) % buttons.length);
            else if (e.key === "ArrowUp") setActive(a => (a - 1 + buttons.length) % buttons.length);
            else if (e.key === "Enter" && active >= 0) ref.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.click();
            else return;
            e.preventDefault();
            e.stopPropagation();
        };
        doc.addEventListener("keydown", onKey, true);
        return () => doc.removeEventListener("keydown", onKey, true);
    }, [buttons.length, active, onClose, sub]);

    const isChecked = (item: MenuItem) => overrides[item.id] ?? item.checked?.() ?? false;

    const run = (item: MenuItem, e: React.MouseEvent) => {
        if (item.submenu) {
            setSub({ label: item.label, items: item.submenu() });
            return;
        }
        if (item.checked) {
            const next = !isChecked(item);
            item.action?.(e);
            setOverrides(o => ({ ...o, [item.id]: next }));
            return;
        }
        if (item.confirm && confirming !== item.id && !e.shiftKey) {
            setConfirming(item.id);
            return;
        }
        onClose();
        item.action?.(e);
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
            {sub && (
                <button className={cl("menu-back")} onClick={() => setSub(null)}>
                    <Icon path={LEFT_PATH} size={16} />
                    <span>{sub.label}</span>
                </button>
            )}
            <div className={classes(sub && cl("menu-sub"))}>
                {sections.filter(s => s.length).map((section, si) => (
                    <div key={si} className={cl("menu-section")}>
                        {section.map(item => {
                            if (item.render) return <div key={item.id} className={cl("menu-custom")}>{item.render()}</div>;
                            const i = index++;
                            const confirm = confirming === item.id;
                            return (
                                <button
                                    key={item.id}
                                    data-index={i}
                                    role={item.checked ? "menuitemcheckbox" : "menuitem"}
                                    aria-checked={item.checked ? isChecked(item) : undefined}
                                    className={classes(cl("menu-item"), item.danger && cl("menu-item-danger"), i === active && cl("menu-item-active"), confirm && cl("menu-item-confirm"))}
                                    onMouseEnter={() => setActive(i)}
                                    onClick={e => run(item, e)}
                                >
                                    <span className={cl("menu-label")}>{confirm ? item.confirm : item.label}</span>
                                    {item.checked
                                        ? <CheckBox on={isChecked(item)} />
                                        : item.submenu
                                            ? <Icon path={RIGHT_PATH} size={16} className={cl("menu-icon")} />
                                            : item.icon && <Icon path={item.icon} size={18} className={cl("menu-icon")} />}
                                </button>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}
