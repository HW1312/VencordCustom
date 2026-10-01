/*
 * HomeOrganizer – main window (DMs / Requests tabs), title bar button & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { findComponentByCodeLazy } from "@webpack";
import { Modal, openModal, RelationshipStore, useState, useStateFromStores } from "@webpack/common";

import { Button, cl, Icon, NumberField, QueueBadge, ToggleRow } from "./components";
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
        <div className={cl("modal")}>
            <div className={cl("tabs")}>
                <button className={classes(cl("tab-btn"), tab === "dms" && cl("tab-btn-active"))} onClick={() => setTab("dms")}>
                    <Icon name="chat" size={16} /> DMs
                </button>
                <button className={classes(cl("tab-btn"), tab === "requests" && cl("tab-btn-active"))} onClick={() => setTab("requests")}>
                    <Icon name="personAdd" size={16} /> Requests
                    {pending > 0 && <span className={cl("unread")}>{pending}</span>}
                </button>
            </div>
            <ErrorBoundary>
                {tab === "dms" ? <DmTab onClose={onClose} /> : <RequestsTab />}
            </ErrorBoundary>
        </div>
    );
}

export function openOrganizer(tab: Tab = "dms") {
    openModal(props => (
        <Modal
            {...props}
            size="xl"
            title="HomeOrganizer"
            subtitle="Clean up DMs and review friend requests - nothing happens without your click."
        >
            <ErrorBoundary>
                <Organizer initialTab={tab} onClose={props.onClose} />
            </ErrorBoundary>
        </Modal>
    ));
}

// ---------------------------------------------------------------- Settings

function Panel() {
    const s = settings.use(["activeDays", "quietDays", "spamAccountDays", "protectPinned", "protectedIds", "dividerFix", "showTitleBarButton"]);

    return (
        <div className={cl("settings")}>
            <div className={cl("head")}>
                <span className={cl("logo")}><Icon name="home" size={22} /></span>
                <div>
                    <div className={cl("head-title")}>HomeOrganizer</div>
                    <div className={cl("hint")}>Also available via the home icon in the title bar, by right-clicking a DM or user, or from the Vencord toolbox.</div>
                </div>
            </div>

            <div className={cl("row-inline")}>
                <Button icon="chat" onClick={() => openOrganizer("dms")}>Clean up DMs</Button>
                <Button icon="personAdd" variant="ghost" onClick={() => openOrganizer("requests")}>Review requests</Button>
            </div>

            <div className={cl("section-title")}>Thresholds</div>
            <div className={cl("grid")}>
                <span>Active up to</span>
                <NumberField value={s.activeDays} min={1} max={365} suffix="days" onChange={v => {
                    settings.store.activeDays = v;
                    if (settings.store.quietDays <= v) settings.store.quietDays = v + 1;
                }} />
                <span>Quiet up to (then dormant)</span>
                <NumberField value={s.quietDays} min={2} max={3650} suffix="days" onChange={v => settings.store.quietDays = Math.max(v, settings.store.activeDays + 1)} />
                <span>New account (spam signal) younger than</span>
                <NumberField value={s.spamAccountDays} min={1} max={3650} suffix="days" onChange={v => settings.store.spamAccountDays = v} />
            </div>

            <div className={cl("section-title")}>Protection</div>
            <ToggleRow
                checked={s.protectPinned}
                onChange={v => settings.store.protectPinned = v}
                label="Never close PinDMs pins"
                hint="Only reads the categories from the PinDMs settings - PinDMs itself is not modified."
            />
            <div className={cl("row-inline")}>
                <span className={cl("muted")}>{s.protectedIds.length} DMs on your own “Never close” list (shield icon in the window or right-click a DM).</span>
                {s.protectedIds.length > 0 && <button className={cl("link")} onClick={() => settings.store.protectedIds = []}>Clear list</button>}
            </div>

            <div className={cl("section-title")}>Appearance</div>
            <ToggleRow
                checked={s.dividerFix}
                onChange={v => settings.store.dividerFix = v}
                label="PinDMs dividers"
                hint="Show categories whose name consists only of dashes/underscores (e.g. “------------”) as a clean line."
            />
            <ToggleRow
                checked={s.showTitleBarButton}
                onChange={v => settings.store.showTitleBarButton = v}
                label="Icon in the title bar"
            />

            <div className={cl("row-inline")}>
                <QueueBadge />
                <Button small variant="danger" icon="stop" onClick={cancelAll}>Cancel running jobs</Button>
            </div>
        </div>
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
            className={cl("titlebtn")}
            onClick={() => openOrganizer("dms")}
            tooltip={pending ? `HomeOrganizer · ${pending} open requests` : "HomeOrganizer"}
            icon={() => <Icon name="home" size={20} className={cl("titleicon")} />}
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
