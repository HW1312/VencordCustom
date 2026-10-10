/*
 * HomeOrganizer – main window (DMs / Requests tabs), title bar button & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { findComponentByCodeLazy } from "@webpack";
import { RelationshipStore, useState, useStateFromStores } from "@webpack/common";

import { Button, Icon, openWindow, Row, Section, Segmented, Sheet, ToggleRow } from "../_ui";
import { APP_COLOR, ICONS, NumberField, QueueBadge } from "./components";
import { DmTab } from "./DmTab";
import { settings } from "./index";
import { cancelAll } from "./queue";
import { RequestsTab } from "./RequestsTab";

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

export type Tab = "dms" | "requests";

// ---------------------------------------------------------------- Main window

function Organizer({ initialTab, onClose }: { initialTab: Tab; onClose(): void; }) {
    const [tab, setTab] = useState<Tab>(initialTab);
    const pending = useStateFromStores([RelationshipStore], () => RelationshipStore.getPendingCount());

    return (
        <Sheet
            height="min(820px, 86vh)"
            onClose={onClose}
            header={{
                title: "HomeOrganizer",
                subtitle: "Clean up DMs and review friend requests - nothing happens without your click.",
                icon: ICONS.home,
                iconColor: APP_COLOR
            }}
            top={
                <Segmented<Tab>
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: "dms", label: "DMs" },
                        { value: "requests", label: "Requests", count: pending || undefined }
                    ]}
                />
            }
        >
            <ErrorBoundary>
                {tab === "dms" ? <DmTab onClose={onClose} /> : <RequestsTab />}
            </ErrorBoundary>
        </Sheet>
    );
}

export function openOrganizer(tab: Tab = "dms") {
    openWindow(close => (
        <ErrorBoundary>
            <Organizer initialTab={tab} onClose={close} />
        </ErrorBoundary>
    ), { size: "large" });
}

// ---------------------------------------------------------------- Settings

function Panel() {
    const s = settings.use(["activeDays", "quietDays", "spamAccountDays", "protectPinned", "protectedIds", "dividerFix", "showTitleBarButton"]);

    return (
        <Sheet
            embedded
            header={{
                title: "HomeOrganizer",
                subtitle: "Also available via the home icon in the title bar, by right-clicking a DM or user, or from the Vencord toolbox.",
                icon: ICONS.home,
                iconColor: APP_COLOR
            }}
        >
            <div className={"vc-homeorganizer-actions"}>
                <Button icon={ICONS.chat} onClick={() => openOrganizer("dms")}>Clean up DMs</Button>
                <Button icon={ICONS.personAdd} variant="gray" onClick={() => openOrganizer("requests")}>Review requests</Button>
            </div>

            <Section title="Thresholds">
                <Row title="Active up to" trailing={
                    <NumberField value={s.activeDays} min={1} max={365} suffix="days" onChange={v => {
                        settings.store.activeDays = v;
                        if (settings.store.quietDays <= v) settings.store.quietDays = v + 1;
                    }} />
                } />
                <Row title="Quiet up to (then dormant)" trailing={
                    <NumberField value={s.quietDays} min={2} max={3650} suffix="days" onChange={v => settings.store.quietDays = Math.max(v, settings.store.activeDays + 1)} />
                } />
                <Row title="New account (spam signal) younger than" trailing={
                    <NumberField value={s.spamAccountDays} min={1} max={3650} suffix="days" onChange={v => settings.store.spamAccountDays = v} />
                } />
            </Section>

            <Section title="Protection">
                <ToggleRow
                    icon={ICONS.pin}
                    color={APP_COLOR}
                    checked={s.protectPinned}
                    onChange={v => settings.store.protectPinned = v}
                    title="Never close PinDMs pins"
                    subtitle="Only reads the categories from the PinDMs settings - PinDMs itself is not modified."
                />
                <Row
                    title={`${s.protectedIds.length} DMs on your own “Never close” list`}
                    subtitle="Shield icon in the window or right-click a DM."
                    trailing={s.protectedIds.length > 0 && <Button small variant="plain" onClick={() => settings.store.protectedIds = []}>Clear list</Button>}
                />
            </Section>

            <Section title="Appearance">
                <ToggleRow
                    icon={ICONS.divider}
                    color="gray"
                    checked={s.dividerFix}
                    onChange={v => settings.store.dividerFix = v}
                    title="PinDMs dividers"
                    subtitle="Show categories whose name consists only of dashes/underscores (e.g. “------------”) as a clean line."
                />
                <ToggleRow
                    icon={ICONS.home}
                    color={APP_COLOR}
                    checked={s.showTitleBarButton}
                    onChange={v => settings.store.showTitleBarButton = v}
                    title="Icon in the title bar"
                />
            </Section>

            <div className={"vc-homeorganizer-actions"}>
                <QueueBadge />
                <Button small variant="destructive" icon={ICONS.stop} onClick={cancelAll}>Cancel running jobs</Button>
            </div>
        </Sheet>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(Panel, { noop: true });

// ---------------------------------------------------------------- Title bar

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    const pending = useStateFromStores([RelationshipStore], () => RelationshipStore.getPendingCount());
    if (!showTitleBarButton) return null;

    return (
        <HeaderBarIcon
            className="vc-homeorganizer-titlebtn"
            onClick={() => openOrganizer("dms")}
            tooltip={pending ? `HomeOrganizer · ${pending} open requests` : "HomeOrganizer"}
            icon={() => <Icon path={ICONS.home} size={20} className="vc-ui-tb-icon" />}
        />
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-homeorganizer-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
