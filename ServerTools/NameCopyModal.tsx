/*
 * ServerTools – copy a channel or category name (or just part of it)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { Modal, openModal, useEffect, useRef, useState } from "@webpack/common";

import { Button, cl } from "./components";

const CATEGORY = 4;

function NameCopyPanel({ name, onClose }: { name: string; onClose(): void; }) {
    const [text, setText] = useState(name);
    const ref = useRef<HTMLInputElement>(null);

    // Start with the whole name selected, so Ctrl+C or "Copy" works right away
    useEffect(() => {
        ref.current?.focus();
        ref.current?.select();
    }, []);

    // Copies the marked part if there is one, otherwise the whole field
    function copy(close = false) {
        const el = ref.current;
        const start = el?.selectionStart ?? 0;
        const end = el?.selectionEnd ?? 0;
        const part = end > start ? text.slice(start, end) : text;
        if (!part) return;
        copyWithToast(part, end > start && part !== text ? "Selection copied" : "Name copied");
        if (close) onClose();
    }

    return (
        <div className={cl("modal")}>
            <input
                ref={ref}
                className={cl("input")}
                style={{ width: "100%", boxSizing: "border-box", fontSize: 16 }}
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
            <div className={cl("hint")} style={{ margin: "8px 0 12px" }}>
                Mark the part you want, or delete what you don't need - nothing here changes the actual channel.
                Enter copies and closes.
            </div>
            <div className={cl("row-inline")}>
                <Button icon="copy" onClick={() => copy()}>Copy</Button>
                <Button variant="ghost" icon="refresh" disabled={text === name} onClick={() => setText(name)}>Reset</Button>
            </div>
        </div>
    );
}

export function openNameCopyModal(channel: { name?: string; type?: number; }) {
    const name = channel.name ?? "";
    openModal(props => (
        <Modal {...props} size="sm" title={channel.type === CATEGORY ? "Copy category name" : "Copy channel name"}>
            <ErrorBoundary>
                <NameCopyPanel name={name} onClose={props.onClose} />
            </ErrorBoundary>
        </Modal>
    ));
}
