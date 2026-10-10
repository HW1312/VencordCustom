/*
 * ServerTools – copy a channel or category name (or just part of it)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyWithToast } from "@utils/discord";
import { useEffect, useRef, useState } from "@webpack/common";

import { Field, openWindow, Sheet } from "../_ui";
import { cl, ICON_COLOR, ICONS } from "./components";

const CATEGORY = 4;

function NameCopyWindow({ name, title, close }: { name: string; title: string; close(): void; }) {
    const [text, setText] = useState(name);
    const ref = useRef<HTMLInputElement>(null);

    // Start with the whole name selected, so Ctrl+C or "Copy" works right away
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);

    // Copies the marked part if there is one, otherwise the whole field
    function copy(andClose = false) {
        const el = ref.current;
        const start = el?.selectionStart ?? 0;
        const end = el?.selectionEnd ?? 0;
        const part = end > start ? text.slice(start, end) : text;
        if (!part) return;
        copyWithToast(part, end > start && part !== text ? "Selection copied" : "Name copied");
        if (andClose) close();
    }

    return (
        <Sheet
            header={{ title, icon: ICONS.copy, iconColor: ICON_COLOR }}
            onClose={close}
            actions={[
                { label: "Reset", onClick: () => setText(name), disabled: text === name },
                { label: "Copy", onClick: () => copy() }
            ]}
        >
            <Field
                label="Name"
                hint="Mark the part you want, or delete what you don't need - nothing here changes the actual channel. Enter copies and closes."
            >
                {/* kit field class; plain input because the selection is read through the ref */}
                <input
                    ref={ref}
                    className={`vc-ui-field ${cl("name-input")}`}
                    value={text}
                    spellCheck={false}
                    onChange={e => setText(e.currentTarget.value)}
                    onKeyDown={e => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            copy(true);
                        }
                    }}
                />
            </Field>
        </Sheet>
    );
}

export function openNameCopyModal(channel: { name?: string; type?: number; }) {
    const name = channel.name ?? "";
    const title = channel.type === CATEGORY ? "Copy category name" : "Copy channel name";
    openWindow(close => <NameCopyWindow name={name} title={title} close={close} />, { size: "small" });
}
