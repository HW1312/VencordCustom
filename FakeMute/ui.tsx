/*
 * FakeMute – title bar button, popout & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { classes } from "@utils/misc";
import { findComponentByCodeLazy } from "@webpack";
import { MediaEngineStore, Popout, SelectedChannelStore, useRef, useState, useStateFromStores } from "@webpack/common";

import { Mode, setDeafMode, setMicMode, settings } from "./index";

const cl = classNameFactory("vc-fakemute-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

// ---------------------------------------------------------------- Icons

const MIC_PATH = "M12 2a4 4 0 0 0-4 4v5a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4Zm-6 9a1 1 0 1 0-2 0 8 8 0 0 0 7 7.94V21H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2.06A8 8 0 0 0 20 11a1 1 0 1 0-2 0 6 6 0 0 1-12 0Z";
const HEADPHONES_PATH = "M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5v-1a7 7 0 0 1 14 0v1h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z";

function Icon({ path, size = 20, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)}>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

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

function Segmented({ value, disabled, onChange }: { value: Mode; disabled?: boolean; onChange(v: Mode): void; }) {
    return (
        <div className={classes(cl("segmented"), disabled && cl("disabled"))}>
            {MODES.map(m => (
                <button
                    key={m.value}
                    disabled={disabled}
                    className={classes(cl("segment"), m.value === value && cl(`segment-${m.value}`))}
                    onClick={() => onChange(m.value)}
                >
                    {m.label}
                </button>
            ))}
        </div>
    );
}

function StatusRow({ label, value, bad }: { label: string; value: string; bad: boolean; }) {
    return (
        <div className={cl("status")}>
            <span className={cl("status-label")}>{label}</span>
            <span className={classes(cl("status-value"), bad ? cl("status-bad") : cl("status-good"))}>{value}</span>
        </div>
    );
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

function Card({ icon, title, children }: { icon: string; title: string; children: React.ReactNode; }) {
    return (
        <div className={cl("card")}>
            <div className={cl("card-title")}>
                <Icon path={icon} size={18} />
                <span>{title}</span>
            </div>
            {children}
        </div>
    );
}

function Controls() {
    const s = useVoiceState();

    return (
        <>
            <Card icon={MIC_PATH} title="Microphone">
                <Segmented value={s.realDeaf ? "real" : s.micMode} disabled={s.realDeaf} onChange={setMicMode} />
                <div className={cl("muted")}>
                    {s.realDeaf ? "While you are actually deafened, your microphone is automatically off." : MIC_HINTS[s.micMode]}
                </div>
                <StatusRow label="Others see" value={s.shownMute ? "Muted" : "Mic on"} bad={s.shownMute} />
                <StatusRow label="In reality" value={s.realMute ? "Nobody hears you" : "Everyone hears you"} bad={s.realMute} />
                {s.deafMode === "fake" && !s.realMute && (
                    <div className={cl("warning")}>
                        You appear deafened, but your mic is on - everyone can hear you. Set the microphone to “Real” if you don't want to be heard.
                    </div>
                )}
            </Card>

            <Card icon={HEADPHONES_PATH} title="Headphones">
                <Segmented value={s.deafMode} onChange={setDeafMode} />
                <div className={cl("muted")}>{DEAF_HINTS[s.deafMode]}</div>
                <StatusRow label="Others see" value={s.shownDeaf ? "Deafened" : "Listening"} bad={s.shownDeaf} />
                <StatusRow label="In reality" value={s.realDeaf ? "You hear nobody" : "You hear everyone"} bad={s.realDeaf} />
            </Card>

            {!s.inVoice && s.fakeActive && (
                <div className={cl("muted")}>You are not in a voice channel - will be applied automatically when you join.</div>
            )}
        </>
    );
}

// ---------------------------------------------------------------- Settings

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);

    return (
        <div className={cl("settings")}>
            <Controls />
            <label className={cl("option")}>
                <span>Show icon in the title bar</span>
                <Switch checked={showTitleBarButton} onChange={v => settings.store.showTitleBarButton = v} />
            </label>
        </div>
    );
}, { noop: true });

// ---------------------------------------------------------------- Title bar

function PopoutPanel() {
    return (
        <div className={cl("popout")}>
            <div className={cl("header")}>
                <Icon path={HEADPHONES_PATH} size={22} />
                <span className={cl("title")}>Fake Mute</span>
            </div>
            <Controls />
        </div>
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
                    icon={() => <Icon path={fakeDeafen ? HEADPHONES_PATH : MIC_PATH} />}
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
