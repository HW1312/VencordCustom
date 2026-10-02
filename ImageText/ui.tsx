/*
 * ImageText – text modal & settings list
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { IS_WINDOWS } from "@utils/constants";
import { Modal, openModal, showToast, Toasts, useEffect, useRef, useState } from "@webpack/common";
import type { RefObject } from "react";

import { joinText, Native, recognize } from "./index";
import type { OcrLanguage, OcrResult } from "./native";

const cl = classNameFactory("vc-imagetext-");

// ---------------------------------------------------------------- Text modal

type State =
    | { status: "loading"; }
    | { status: "done"; result: OcrResult; };

function TextView({ state, text, setText, textareaRef }: {
    state: State;
    text: string;
    setText(text: string): void;
    textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
    if (state.status === "loading") {
        return <div className={cl("status")}>Reading text from image …</div>;
    }

    const { result } = state;
    if (!result.ok) {
        return <div className={cl("status", "status-error")}>Could not read text: {result.error}</div>;
    }

    return (
        <div className={cl("content")}>
            {!result.lines.some(l => l.trim()) && <div className={cl("status")}>No text found. You can still type into the box.</div>}
            <textarea
                ref={textareaRef}
                className={cl("textarea")}
                value={text}
                onChange={e => setText(e.currentTarget.value)}
                spellCheck={false}
                autoFocus
            />
            <div className={cl("hint")}>Select a part of the text to copy only that part.</div>
        </div>
    );
}

function TextModal({ src, modalProps }: { src: string; modalProps: { transitionState: number; onClose(): void; }; }) {
    const [state, setState] = useState<State>({ status: "loading" });
    const [text, setText] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        let alive = true;
        recognize(src).then(result => {
            if (!alive) return;
            setState({ status: "done", result });
            if (result.ok) setText(joinText(result.lines.filter(l => l.trim())));
        });
        return () => { alive = false; };
    }, [src]);

    const lineCount = text.split("\n").filter(l => l.trim()).length;
    const subtitle = state.status === "done" && state.result.ok
        ? `${lineCount} ${lineCount === 1 ? "line" : "lines"}${state.result.language ? ` · OCR language: ${state.result.language}` : ""}`
        : undefined;

    function copy() {
        const el = textareaRef.current;
        const selected = el && el.selectionStart !== el.selectionEnd
            ? el.value.slice(el.selectionStart, el.selectionEnd)
            : text;
        if (!selected.trim()) {
            showToast("Nothing to copy", Toasts.Type.MESSAGE);
            return;
        }
        void copyToClipboard(selected).then(
            () => showToast(selected === text ? "Copied text" : "Copied selection", Toasts.Type.SUCCESS),
            () => showToast("Could not copy the text", Toasts.Type.FAILURE)
        );
    }

    const canCopy = state.status === "done" && state.result.ok;

    return (
        <Modal
            {...modalProps}
            size="md"
            title="Text from image"
            subtitle={subtitle}
            actions={[
                { text: "Close", variant: "secondary", onClick: modalProps.onClose },
                { text: "Copy", variant: "primary", onClick: copy, disabled: !canCopy, loading: state.status === "loading" }
            ]}
        >
            <ErrorBoundary noop>
                <TextView state={state} text={text} setText={setText} textareaRef={textareaRef} />
            </ErrorBoundary>
        </Modal>
    );
}

export function openTextModal(src: string) {
    openModal(props => <TextModal src={src} modalProps={props} />);
}

// ---------------------------------------------------------------- Settings: installed languages

export const LanguageList = ErrorBoundary.wrap(() => {
    const [languages, setLanguages] = useState<OcrLanguage[] | null>(null);

    useEffect(() => {
        if (!IS_WINDOWS || !Native) return;
        Native.getLanguages().then(setLanguages, () => setLanguages([]));
    }, []);

    let body: string;
    if (!IS_WINDOWS || !Native) body = "Only available in the Discord desktop app on Windows.";
    else if (!languages) body = "Loading …";
    else if (!languages.length) body = "None found. Add a language with the optical character recognition feature in Windows Settings > Time & language > Language.";
    else body = languages.map(l => `${l.name} (${l.tag})`).join(", ");

    return (
        <div className={cl("languages")}>
            <div className={cl("languages-title")}>Installed OCR languages</div>
            <div className={cl("languages-list")}>{body}</div>
        </div>
    );
}, { noop: true });
