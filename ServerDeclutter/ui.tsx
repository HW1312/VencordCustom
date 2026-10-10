/*
 * ServerDeclutter – Settings (thresholds, tracking, stats)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { GuildStore, showToast, useEffect, useState } from "@webpack/common";

import { Button, confirm, LinkRow, Note, Row, Section, Segmented, Sheet, Stats, TextField, ToggleRow } from "../_ui";
import { cancelAll } from "./actions";
import { ICON_COLOR, ICONS, NumberField } from "./components";
import { openDeclutterModal } from "./DeclutterModal";
import { settings } from "./index";
import { getActivity, onActivityChange, resetActivity } from "./store";

const SPEEDS = [
    { value: "1000", label: "Normal · 1/s" },
    { value: "1500", label: "Careful · 1/1.5 s" },
    { value: "2500", label: "Very careful · 1/2.5 s" }
];

function useActivity() {
    const [, setTick] = useState(0);
    useEffect(() => onActivityChange(() => setTick(t => t + 1)), []);
    return getActivity();
}

async function confirmReset() {
    const ok = await confirm({
        title: "Reset tracking data?",
        body: "All recorded timestamps (“last opened” / “last written”) will be deleted. Tracking starts over.",
        confirmText: "Reset",
        destructive: true
    });
    if (!ok) return;
    resetActivity()
        .then(() => showToast("Tracking data reset", "success"))
        .catch(() => showToast("Reset failed", "failure"));
}

function FolderNameField({ value }: { value: string; }) {
    const [text, setText] = useState(value);
    useEffect(() => setText(value), [value]);
    return (
        <TextField
            value={text}
            maxLength={32}
            onChange={setText}
            onBlur={() => settings.store.archiveFolderName = text.trim() || "Archive"}
        />
    );
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
        <Sheet
            embedded
            header={{
                title: "ServerDeclutter",
                subtitle: "Overview of all servers and decluttering with a click – also via right-click on a server icon → \"Declutter servers …\".",
                icon: ICONS.broom,
                iconColor: ICON_COLOR,
                actions: <Button icon={ICONS.broom} onClick={() => openDeclutterModal()}>Open overview</Button>
            }}
        >
            <Section title="Tracking">
                <ToggleRow
                    icon={ICONS.search}
                    color={ICON_COLOR}
                    title="Track activity locally"
                    subtitle="Remembers when you opened a server or wrote in it. Stored locally only."
                    checked={tracking}
                    onChange={v => settings.store.tracking = v}
                />
            </Section>

            <Stats items={[
                { label: "Tracked since", value: new Date(activity.since).toLocaleDateString() },
                { label: "Days", value: days },
                { label: "Servers opened", value: `${opened} / ${total}` },
                { label: "Servers with your own message", value: wrote }
            ]} />
            {days < staleDays && (
                <Note>
                    Tracking has only been running for {days} {days === 1 ? "day" : "days"}. Until {staleDays} days are reached, "not opened"
                    is partly based on estimates from Discord's read state and the join date.
                </Note>
            )}
            <Section>
                <LinkRow destructive icon={ICONS.refresh} onClick={confirmReset}>Reset tracking data</LinkRow>
            </Section>

            <Section title="Thresholds">
                <Row title={"\"Not opened\" after"} trailing={<NumberField value={staleDays} min={7} max={730} suffix="days" onChange={v => settings.store.staleDays = v} />} />
                <Row title={"\"Dead\" (no messages) after"} trailing={<NumberField value={deadDays} min={3} max={730} suffix="days" onChange={v => settings.store.deadDays = v} />} />
                <Row title="Archive folder name" trailing={<FolderNameField value={archiveFolderName} />} />
            </Section>

            <Section
                title="Action speed"
                footer={"Muting and \"Mark as read\" run one after another, throttled; leaving at most once every 2 seconds. On rate limits the plugin waits automatically. Nothing happens without your click and a confirmation."}
            >
                <Row title={<Segmented value={String(requestInterval)} options={SPEEDS} onChange={v => settings.store.requestInterval = Number(v)} />} />
            </Section>
            <Section>
                <LinkRow icon={ICONS.stop} onClick={cancelAll}>Cancel all running actions</LinkRow>
            </Section>
        </Sheet>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(Panel, { noop: true });
