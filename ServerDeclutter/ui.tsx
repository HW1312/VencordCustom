/*
 * ServerDeclutter – Settings (thresholds, tracking, stats)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { ConfirmModal, GuildStore, openModal, showToast, Toasts, useEffect, useState } from "@webpack/common";

import { cancelAll } from "./actions";
import { Button, cl, Icon, Notice, NumberField, Stat } from "./components";
import { openDeclutterModal } from "./DeclutterModal";
import { settings } from "./index";
import { getActivity, onActivityChange, resetActivity } from "./store";

const SPEEDS = [
    { value: 1000, label: "Normal · 1/s" },
    { value: 1500, label: "Careful · 1/1.5 s" },
    { value: 2500, label: "Very careful · 1/2.5 s" }
];

function useActivity() {
    const [, setTick] = useState(0);
    useEffect(() => onActivityChange(() => setTick(t => t + 1)), []);
    return getActivity();
}

function confirmReset() {
    openModal(props => (
        <ConfirmModal
            {...props}
            title="Reset tracking data?"
            subtitle="All recorded timestamps (“last opened” / “last written”) will be deleted. Tracking starts over."
            confirmText="Reset"
            cancelText="Cancel"
            variant="critical-primary"
            onConfirm={() => {
                resetActivity()
                    .then(() => showToast("Tracking data reset", Toasts.Type.SUCCESS))
                    .catch(() => showToast("Reset failed", Toasts.Type.FAILURE));
            }}
        />
    ));
}

function Panel() {
    const { tracking, staleDays, deadDays, requestInterval, archiveFolderName } = settings.use(["tracking", "staleDays", "deadDays", "requestInterval", "archiveFolderName"]);
    const activity = useActivity();
    const entries = Object.values(activity.guilds);
    const opened = entries.filter(a => a.opened).length;
    const wrote = entries.filter(a => a.wrote).length;
    const total = Object.keys(GuildStore.getGuilds()).length;
    const days = Math.floor((Date.now() - activity.since) / 86400_000);

    return (
        <div className={cl("settings")}>
            <div className={cl("head")}>
                <span className={cl("logo")}><Icon name="broom" size={22} /></span>
                <div>
                    <div className={cl("head-title")}>ServerDeclutter</div>
                    <div className={cl("hint")}>Overview of all servers and decluttering with a click – also via right-click on a server icon → "Declutter servers …".</div>
                </div>
            </div>

            <Button icon="broom" onClick={() => openDeclutterModal()}>Open overview</Button>

            <div className={cl("section-title")}>Tracking</div>
            <label className={cl("option")}>
                <span>
                    <span className={cl("option-label")}>Track activity locally</span>
                    <span className={cl("hint")}>Remembers when you opened a server or wrote in it. Stored locally only.</span>
                </span>
                <Switch checked={tracking} onChange={v => settings.store.tracking = v} />
            </label>

            <div className={cl("stats")}>
                <Stat label="Tracked since" value={new Date(activity.since).toLocaleDateString()} />
                <Stat label="Days" value={days} />
                <Stat label="Servers opened" value={`${opened} / ${total}`} />
                <Stat label="Servers with your own message" value={wrote} />
            </div>
            {days < staleDays && (
                <Notice tone="info">
                    Tracking has only been running for {days} {days === 1 ? "day" : "days"}. Until {staleDays} days are reached, "not opened"
                    is partly based on estimates from Discord's read state and the join date.
                </Notice>
            )}
            <div className={cl("row-inline")}>
                <Button small variant="danger" icon="refresh" onClick={confirmReset}>Reset tracking data</Button>
            </div>

            <div className={cl("section-title")}>Thresholds</div>
            <div className={cl("row-inline")}>
                <span className={cl("option-label")}>"Not opened" after</span>
                <NumberField value={staleDays} min={7} max={730} suffix="days" onChange={v => settings.store.staleDays = v} />
            </div>
            <div className={cl("row-inline")}>
                <span className={cl("option-label")}>"Dead" (no messages) after</span>
                <NumberField value={deadDays} min={3} max={730} suffix="days" onChange={v => settings.store.deadDays = v} />
            </div>
            <div className={cl("row-inline")}>
                <span className={cl("option-label")}>Archive folder name</span>
                <input
                    className={cl("input")}
                    defaultValue={archiveFolderName}
                    maxLength={32}
                    onBlur={e => settings.store.archiveFolderName = e.currentTarget.value.trim() || "Archive"}
                />
            </div>

            <div className={cl("section-title")}>Action speed</div>
            <div className={cl("seg")}>
                {SPEEDS.map(s => (
                    <button
                        key={s.value}
                        className={s.value === requestInterval ? `${cl("seg-item")} ${cl("seg-item-active")}` : cl("seg-item")}
                        onClick={() => settings.store.requestInterval = s.value}
                    >
                        {s.label}
                    </button>
                ))}
            </div>
            <div className={cl("hint")}>
                Muting and "Mark as read" run one after another, throttled; leaving at most once every 2 seconds. On rate limits the plugin
                waits automatically. Nothing happens without your click and a confirmation.
            </div>
            <div className={cl("row-inline")}>
                <Button small variant="ghost" icon="stop" onClick={cancelAll}>Cancel all running actions</Button>
            </div>
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(Panel, { noop: true });
