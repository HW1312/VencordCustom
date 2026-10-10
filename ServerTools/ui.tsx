/*
 * ServerTools – settings (tool overview, queue speed)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { GuildStore, SelectedGuildStore, useMemo, useState } from "@webpack/common";

import { Glyph, Row, Section, Sheet } from "../_ui";
import { GuildSelect, openBackupModal } from "./BackupModal";
import { Button, cl, ICON_COLOR, IconName, ICONS, QueueBadge, Segmented } from "./components";
import { openHealthModal } from "./HealthModal";
import { settings } from "./index";
import { cancelAll } from "./queue";

const SPEEDS = [
    { value: 1000, label: "Normal · 1/s" },
    { value: 1500, label: "Careful · 1/1.5 s" },
    { value: 2500, label: "Very careful · 1/2.5 s" }
];

function ToolRow({ icon, color, title, text, children }: { icon: IconName; color: "orange" | "teal" | "pink"; title: string; text: string; children?: React.ReactNode; }) {
    return (
        <Row align="top" leading={<Glyph path={ICONS[icon]} color={color} />} title={title} subtitle={text}>
            {children && <div className={cl("row-inline")}>{children}</div>}
        </Row>
    );
}

function Panel() {
    const { requestInterval } = settings.use(["requestInterval"]);
    const guilds = useMemo(() => Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name)), []);
    const [guildId, setGuildId] = useState<string | null>(() => SelectedGuildStore.getGuildId() ?? null);

    return (
        <Sheet
            embedded
            header={{
                title: "ServerTools",
                subtitle: "Tools for server owners & admins - also available by right-clicking a server icon, a channel or a message.",
                icon: ICONS.tools,
                iconColor: ICON_COLOR
            }}
        >
            <Section title="Tools">
                <Row title="Server" trailing={<GuildSelect guilds={guilds} value={guildId} onChange={setGuildId} />} />

                <ToolRow icon="archive" color="orange" title="ServerBackup" text="Save roles, channels, permissions, emojis, stickers & settings as a .zip - and restore them into a server of your own.">
                    <Button small icon="download" disabled={!guildId} onClick={() => openBackupModal(guildId, "export")}>Create backup</Button>
                    <Button small variant="ghost" icon="restore" onClick={() => openBackupModal(guildId, "restore")}>Restore</Button>
                </ToolRow>

                <ToolRow icon="pulse" color="teal" title="Channel Health" text="Activity of all readable text channels: ranking, dead channels, weekly heatmap, top members, CSV export.">
                    <Button small icon="play" disabled={!guildId} onClick={() => openHealthModal(guildId)}>Open analysis</Button>
                </ToolRow>

                <ToolRow icon="gift" color="pink" title="FairGiveaway" text="Right-click a message with reactions -> “Draw giveaway”. Filters, verifiable seed (SHA-256), slot animation." />
            </Section>

            <Section
                title="Request speed"
                right={<QueueBadge />}
                footer="All tools share a single queue. Many requests in a short time can get your account restricted - so requests are throttled on purpose and automatically wait on rate limits. Nothing happens without your click."
            >
                <div className={cl("card-body")}>
                    <Segmented value={requestInterval} options={SPEEDS} onChange={v => settings.store.requestInterval = v} />
                    <div>
                        <Button small variant="danger" icon="stop" onClick={cancelAll}>Cancel all running jobs</Button>
                    </div>
                </div>
            </Section>
        </Sheet>
    );
}

export const SettingsPanel = ErrorBoundary.wrap(Panel, { noop: true });
