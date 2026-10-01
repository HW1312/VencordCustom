/*
 * ServerTools – settings (tool overview, queue speed)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { GuildStore, SelectedGuildStore, useMemo, useState } from "@webpack/common";

import { GuildSelect, openBackupModal } from "./BackupModal";
import { Button, cl, Icon, IconName, QueueBadge, Segmented } from "./components";
import { openHealthModal } from "./HealthModal";
import { settings } from "./index";
import { cancelAll } from "./queue";

const SPEEDS = [
    { value: 1000, label: "Normal · 1/s" },
    { value: 1500, label: "Careful · 1/1.5 s" },
    { value: 2500, label: "Very careful · 1/2.5 s" }
];

function ToolCard({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: React.ReactNode; }) {
    return (
        <div className={cl("tool")}>
            <span className={cl("tool-icon")}><Icon name={icon} size={20} /></span>
            <div className={cl("tool-body")}>
                <div className={cl("tool-title")}>{title}</div>
                <div className={cl("hint")}>{text}</div>
                {children && <div className={cl("row-inline")}>{children}</div>}
            </div>
        </div>
    );
}

function Panel() {
    const { requestInterval } = settings.use(["requestInterval"]);
    const guilds = useMemo(() => Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name)), []);
    const [guildId, setGuildId] = useState<string | null>(() => SelectedGuildStore.getGuildId() ?? null);

    return (
        <div className={cl("settings")}>
            <div className={cl("head")}>
                <span className={cl("logo")}><Icon name="tools" size={22} /></span>
                <div>
                    <div className={cl("head-title")}>ServerTools</div>
                    <div className={cl("hint")}>Tools for server owners & admins - also available by right-clicking a server icon or a message.</div>
                </div>
            </div>

            <div className={cl("row-inline")}>
                <span className={cl("muted")}>Server:</span>
                <GuildSelect guilds={guilds} value={guildId} onChange={setGuildId} />
            </div>

            <ToolCard icon="archive" title="ServerBackup" text="Save roles, channels, permissions, emojis, stickers & settings as a .zip - and restore them into a server of your own.">
                <Button small icon="download" disabled={!guildId} onClick={() => openBackupModal(guildId, "export")}>Create backup</Button>
                <Button small variant="ghost" icon="restore" onClick={() => openBackupModal(guildId, "restore")}>Restore</Button>
            </ToolCard>

            <ToolCard icon="pulse" title="Channel Health" text="Activity of all readable text channels: ranking, dead channels, weekly heatmap, top members, CSV export.">
                <Button small icon="play" disabled={!guildId} onClick={() => openHealthModal(guildId)}>Open analysis</Button>
            </ToolCard>

            <ToolCard icon="gift" title="FairGiveaway" text="Right-click a message with reactions -> “Draw giveaway”. Filters, verifiable seed (SHA-256), slot animation." />

            <div className={cl("section-title")}>Request speed</div>
            <Segmented value={requestInterval} options={SPEEDS} onChange={v => settings.store.requestInterval = v} />
            <div className={cl("hint")}>
                All tools share a single queue. Many requests in a short time can get your account restricted -
                so requests are throttled on purpose and automatically wait on rate limits. Nothing happens without your click.
            </div>
            <div className={cl("row-inline")}>
                <QueueBadge />
                <Button small variant="danger" icon="stop" onClick={cancelAll}>Cancel all running jobs</Button>
            </div>
        </div>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(Panel, { noop: true });
