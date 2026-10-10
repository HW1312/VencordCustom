/*
 * FakeMute – title bar button, popout & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { findComponentByCodeLazy } from "@webpack";
import { MediaEngineStore, Popout, SelectedChannelStore, useRef, useState, useStateFromStores } from "@webpack/common";

import { classes, Icon, Note, Popover, Row, Section, Segmented, Sheet, State, ToggleRow } from "../_ui";
import { Mode, setDeafMode, setMicMode, settings } from "./index";

const cl = classNameFactory("vc-fakemute-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const MIC_PATH = "M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4Zm-6 9a1 1 0 1 0-2 0 8 8 0 0 0 7 7.94V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.06A8 8 0 0 0 20 11a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z";
const HEADPHONES_PATH = "M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z";

const ICON_COLOR = "orange";
const HEADER = { title: "Fake Mute", icon: HEADPHONES_PATH, iconColor: ICON_COLOR } as const;

// ---------------------------------------------------------------- State

function useVoiceState() {
    const { fakeMute, fakeDeafen } = settings.use(["fakeMute", "fakeDeafen"]);
    const realMute = useStateFromStores([MediaEngineStore], () => MediaEngineStore.isSelfMute());
    const realDeaf = useStateFromStores([MediaEngineStore], () => MediaEngineStore.isSelfDeaf());
    const inVoice = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId() != null);

    const micMode: Mode = realMute ? "real" : fakeMute ? "fake" : "off";
    const deafMode: Mode = realDeaf ? "real" : fakeDeafen ? "fake" : "off";

    return {
        micMode,
        deafMode,
        realMute,
        realDeaf,
        inVoice,
        shownMute: realMute || fakeMute || fakeDeafen,
        shownDeaf: realDeaf || fakeDeafen,
        fakeActive: fakeMute || fakeDeafen
    };
}

// ---------------------------------------------------------------- Building blocks

const MODES: { value: Mode; label: string; }[] = [
    { value: "off", label: "Off" },
    { value: "fake", label: "Fake" },
    { value: "real", label: "Real" }
];

function ModePicker({ value, disabled, onChange }: { value: Mode; disabled?: boolean; onChange(v: Mode): void; }) {
    return (
        <div className={classes(cl("modes"), disabled && cl("disabled"))}>
            <Segmented value={value} options={MODES} onChange={v => { if (!disabled) onChange(v); }} />
        </div>
    );
}

function StatusRow({ label, value, bad }: { label: string; value: string; bad: boolean; }) {
    return <Row title={label} trailing={<State tone={bad ? "bad" : "ok"}>{value}</State>} />;
}

const MIC_HINTS: Record<Mode, string> = {
    off: "Normal - your microphone works as usual.",
    fake: "Everyone sees you as muted, but can still hear you.",
    real: "You are actually muted - nobody can hear you."
};

const DEAF_HINTS: Record<Mode, string> = {
    off: "Normal - you hear everyone as usual.",
    fake: "Everyone sees you as deafened, but you can still hear everything.",
    real: "You are actually deafened (and therefore also muted)."
};

function Controls() {
    const s = useVoiceState();

    return (
        <>
            <Section
                title="Microphone"
                footer={s.realDeaf ? "While you are actually deafened, your microphone is automatically off." : MIC_HINTS[s.micMode]}
            >
                <Row title={<ModePicker value={s.realDeaf ? "real" : s.micMode} disabled={s.realDeaf} onChange={setMicMode} />} />
                <StatusRow label="Others see" value={s.shownMute ? "Muted" : "Mic on"} bad={s.shownMute} />
                <StatusRow label="In reality" value={s.realMute ? "Nobody hears you" : "Everyone hears you"} bad={s.realMute} />
            </Section>
            {s.deafMode === "fake" && !s.realMute && (
                <Note tone="warn">
                    You appear deafened, but your mic is on - everyone can hear you. Set the microphone to “Real” if you don't want to be heard.
                </Note>
            )}

            <Section title="Headphones" footer={DEAF_HINTS[s.deafMode]}>
                <Row title={<ModePicker value={s.deafMode} onChange={setDeafMode} />} />
                <StatusRow label="Others see" value={s.shownDeaf ? "Deafened" : "Listening"} bad={s.shownDeaf} />
                <StatusRow label="In reality" value={s.realDeaf ? "You hear nobody" : "You hear everyone"} bad={s.realDeaf} />
            </Section>

            {!s.inVoice && s.fakeActive && (
                <Note>You are not in a voice channel - will be applied automatically when you join.</Note>
            )}
        </>
    );
}

// ---------------------------------------------------------------- Settings

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);

    return (
        <Sheet embedded header={HEADER}>
            <Controls />
            <Section>
                <ToggleRow
                    icon={MIC_PATH}
                    color={ICON_COLOR}
                    title="Show icon in the title bar"
                    checked={showTitleBarButton}
                    onChange={v => settings.store.showTitleBarButton = v}
                />
            </Section>
        </Sheet>
    );
}, { noop: true });

// ---------------------------------------------------------------- Title bar

function PopoutPanel() {
    return (
        <Popover width={320}>
            <Sheet header={HEADER}>
                <Controls />
            </Sheet>
        </Popover>
    );
}

function TitleBarButton() {
    const { showTitleBarButton, fakeMute, fakeDeafen } = settings.use(["showTitleBarButton", "fakeMute", "fakeDeafen"]);
    const fakeActive = fakeMute || fakeDeafen;
    const buttonRef = useRef(null);
    const [show, setShow] = useState(false);

    if (!showTitleBarButton) return null;

    const tooltip = fakeDeafen ? "Fake Deafen active" : fakeMute ? "Fake Mute active" : "Fake Mute";

    return (
        <Popout
            position="bottom"
            align="left"
            animation={Popout.Animation.NONE}
            shouldShow={show}
            onRequestClose={() => setShow(false)}
            targetElementRef={buttonRef}
            renderPopout={() => (
                <ErrorBoundary noop>
                    <PopoutPanel />
                </ErrorBoundary>
            )}
        >
            {(_, { isShown }) => (
                <HeaderBarIcon
                    ref={buttonRef}
                    className={classes(cl("btn"), fakeActive && cl("btn-active"))}
                    onClick={() => setShow(v => !v)}
                    tooltip={isShown ? null : tooltip}
                    icon={() => <Icon path={fakeDeafen ? HEADPHONES_PATH : MIC_PATH} size={20} className={classes("vc-ui-tb-icon", cl("icon"))} />}
                    selected={isShown}
                />
            )}
        </Popout>
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-fakemute-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
