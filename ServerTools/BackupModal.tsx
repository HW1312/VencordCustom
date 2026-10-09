/*
 * ServerTools – ServerBackup window (export & restore)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { chooseFile, saveFile } from "@utils/web";
import { ChannelStore, GuildRoleStore, GuildStore, Modal, openModal, showToast, useMemo, UserStore, useState } from "@webpack/common";

import { BackupBundle, backupFileName, buildZip, collectBackup, estimateRequests, getOwnedGuilds, readBackupZip, RestoreSections, runRestore, summarize } from "./backup";
import { Button, Card, cl, Icon, LogList, Notice, ProgressBar, QueueBadge, Segmented, Stat, ToggleRow, useJob } from "./components";
import { describeError, isCancelled, queueConfig } from "./queue";

type Tab = "export" | "restore";

// ---------------------------------------------------------------- Helpers

export function GuildIcon({ guild, size = 32 }: { guild: any; size?: number; }) {
    if (guild?.icon) {
        return <img className={cl("guild-icon")} width={size} height={size} src={`https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.webp?size=64`} alt="" />;
    }
    const acronym = (guild?.name ?? "?").split(/\s+/).map((w: string) => w[0]).join("").slice(0, 3);
    return <span className={cl("guild-icon")} style={{ width: size, height: size }}>{acronym}</span>;
}

export function GuildSelect({ guilds, value, onChange, disabled, placeholder }: {
    guilds: any[];
    value: string | null;
    onChange(id: string): void;
    disabled?: boolean;
    placeholder?: string;
}) {
    return (
        <select className={cl("select")} value={value ?? ""} disabled={disabled} onChange={e => onChange(e.currentTarget.value)}>
            <option value="" disabled>{placeholder ?? "Select server …"}</option>
            {guilds.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
    );
}

const formatBytes = (n: number) => n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

export function formatDuration(seconds: number) {
    if (seconds < 90) return `${Math.round(seconds)} seconds`;
    const min = Math.round(seconds / 60);
    return min < 90 ? `${min} minutes` : `${(min / 60).toFixed(1)} hours`;
}

// ---------------------------------------------------------------- Export

function ExportTab({ initialGuildId }: { initialGuildId: string | null; }) {
    const guilds = useMemo(() => Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name)), []);
    const [guildId, setGuildId] = useState<string | null>(initialGuildId);
    const [bundle, setBundle] = useState<BackupBundle | null>(null);
    const job = useJob();
    const guild = guildId ? GuildStore.getGuild(guildId) : null;

    const collect = () => {
        if (!guildId) return;
        setBundle(null);
        job.run(hooks => collectBackup(guildId, hooks))
            .then(res => res && setBundle(res))
            .catch(e => !isCancelled(e) && showToast(`Backup failed: ${describeError(e)}`, "failure"));
    };

    const save = () => {
        if (!bundle) return;
        try {
            const zip = buildZip(bundle);
            saveFile(new File([zip as BlobPart], backupFileName(bundle.backup), { type: "application/zip" }));
            showToast("Backup saved", "success");
        } catch (e) {
            showToast(`Saving failed: ${describeError(e)}`, "failure");
        }
    };

    const sum = bundle ? summarize(bundle.backup) : null;
    const fileBytes = bundle ? Object.values(bundle.files).reduce((n, f) => n + f.length, 0) : 0;

    return (
        <div className={cl("stack")}>
            <Card title="Source" icon="archive">
                <div className={cl("row-inline")}>
                    {guild && <GuildIcon guild={guild} />}
                    <GuildSelect guilds={guilds} value={guildId} disabled={job.state.running} onChange={id => { setGuildId(id); setBundle(null); }} />
                    {job.state.running
                        ? <Button variant="danger" icon="stop" onClick={job.cancel}>Cancel</Button>
                        : <Button icon="download" disabled={!guildId} onClick={collect}>Collect data</Button>}
                </div>
                <div className={cl("hint")}>
                    The backup contains server settings, roles, categories & channels (including permissions, forum tags),
                    emojis and stickers (with images) and a list of webhooks.
                </div>
                <Notice tone="info">
                    <b>Webhook tokens and URLs are never exported</b> - only name and channel, so the backup can be shared
                    safely. Messages and members are not part of the backup.
                </Notice>
            </Card>

            {(job.state.running || job.state.log.length > 0) && (
                <Card title="Progress" icon="pulse" right={<QueueBadge />}>
                    {job.state.running && <ProgressBar done={job.state.done} total={job.state.total} label={job.state.label} indeterminate={job.state.total <= 1} />}
                    <LogList entries={job.state.log} />
                </Card>
            )}

            {bundle && sum && (
                <Card title="Summary" icon="check">
                    <div className={cl("stats")}>
                        <Stat label="Roles" value={sum.roles} />
                        <Stat label="Categories" value={sum.categories} />
                        <Stat label="Channels" value={sum.channels} />
                        <Stat label="Emojis" value={sum.emojis} />
                        <Stat label="Sticker" value={sum.stickers} />
                        <Stat label="Webhooks" value={sum.webhooks} />
                    </div>
                    <div className={cl("hint")}>
                        {Object.keys(bundle.files).length} image files ({formatBytes(fileBytes)}) · Server “{bundle.backup.source.name}”
                    </div>
                    {bundle.backup.notes.length > 0 && (
                        <ul className={cl("notes")}>
                            {bundle.backup.notes.map((n, i) => <li key={i}>{n}</li>)}
                        </ul>
                    )}
                    <div className={cl("actions")}>
                        <Button icon="download" variant="success" onClick={save}>Save as .zip</Button>
                    </div>
                </Card>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Restore

const SECTION_LABELS: Record<keyof RestoreSections, string> = {
    roles: "Roles",
    channels: "Categories & channels",
    emojis: "Emojis",
    stickers: "Stickers",
    settings: "Server settings"
};

function RestoreTab() {
    const owned = useMemo(() => getOwnedGuilds(), []);
    const [bundle, setBundle] = useState<BackupBundle | null>(null);
    const [targetId, setTargetId] = useState<string | null>(null);
    const [sections, setSections] = useState<RestoreSections>({ roles: true, channels: true, emojis: true, stickers: true, settings: true });
    const [deleteExisting, setDeleteExisting] = useState(false);
    const [deleteConfirmed, setDeleteConfirmed] = useState(false);
    const [result, setResult] = useState<{ ok: number; failed: number; } | null>(null);
    const job = useJob();

    const pick = async () => {
        const file = await chooseFile("application/zip,.zip");
        if (!file) return;
        try {
            setBundle(await readBackupZip(file));
            setResult(null);
        } catch (e) {
            showToast(`Failed to read backup: ${describeError(e)}`, "failure");
        }
    };

    const target = targetId ? GuildStore.getGuild(targetId) : null;
    const existingChannels = targetId ? Object.keys(ChannelStore.getMutableGuildChannelsForGuild(targetId) ?? {}).length : 0;
    const existingRoles = targetId ? Math.max(0, Object.keys(GuildRoleStore.getRolesSnapshot?.(targetId) ?? {}).length - 1) : 0;
    const notEmpty = existingChannels > 0 || existingRoles > 0;
    const sameAsSource = bundle && targetId === bundle.backup.source.id;
    const anySection = Object.values(sections).some(Boolean);

    const requests = bundle ? estimateRequests({ bundle, sections, deleteExisting, targetGuildId: targetId ?? undefined }) : 0;
    const eta = requests * queueConfig.interval / 1000;

    const canStart = !!bundle && !!target && anySection && !job.state.running && (!deleteExisting || deleteConfirmed);

    const start = () => {
        if (!bundle || !targetId) return;
        // Safety net: check ownership again
        if (GuildStore.getGuild(targetId)?.ownerId !== UserStore.getCurrentUser()?.id) {
            showToast("You are not the owner of this server", "failure");
            return;
        }
        setResult(null);
        job.run(hooks => runRestore({ bundle, targetGuildId: targetId, sections, deleteExisting }, hooks))
            .then(res => {
                if (!res) return;
                setResult(res);
                setDeleteConfirmed(false);
                showToast(res.failed ? `Restore finished with ${res.failed} errors` : "Restore completed", res.failed ? "message" : "success");
            })
            .catch(e => !isCancelled(e) && showToast(`Restore failed: ${describeError(e)}`, "failure"));
    };

    const sum = bundle ? summarize(bundle.backup) : null;
    const counts: Record<keyof RestoreSections, string> = sum ? {
        roles: `${sum.roles - sum.managedRoles} roles${sum.managedRoles ? ` (+${sum.managedRoles} bot/booster roles will be skipped)` : ""} + @everyone permissions`,
        channels: `${sum.categories} categories, ${sum.channels} channels with permissions`,
        emojis: `${sum.emojis} emojis (mind the server slots)`,
        stickers: `${sum.stickers} stickers (mind the server slots)`,
        settings: `Name “${bundle!.backup.guild.name}”, icon, verification, notifications, AFK, system channel, language`
    } : {} as any;

    return (
        <div className={cl("stack")}>
            <Card title="Backup file" icon="upload">
                <div className={cl("row-inline")}>
                    <Button icon="upload" variant={bundle ? "ghost" : "primary"} disabled={job.state.running} onClick={pick}>
                        {bundle ? "Choose another file" : "Choose backup (.zip)"}
                    </Button>
                    {bundle && (
                        <span className={cl("hint")}>
                            “{bundle.backup.source.name}” from {new Date(bundle.backup.createdAt).toLocaleString()}
                        </span>
                    )}
                </div>
            </Card>

            {bundle && (
                <Card title="Target server" icon="shield">
                    {owned.length === 0
                        ? <Notice tone="warn">You don't own any server. Create a new, empty server first.</Notice>
                        : (
                            <div className={cl("row-inline")}>
                                {target && <GuildIcon guild={target} />}
                                <GuildSelect guilds={owned} value={targetId} disabled={job.state.running} onChange={id => { setTargetId(id); setDeleteConfirmed(false); }} placeholder="Select your own server …" />
                            </div>
                        )}
                    <div className={cl("hint")}>Only servers you own are shown.</div>
                    <Notice tone="warn">
                        <b>Recommendation: restore into a new, empty server.</b> Otherwise existing content stays
                        and is supplemented by the backup (duplicate channels/roles possible).
                    </Notice>
                    {target && notEmpty && !deleteExisting && (
                        <Notice tone="warn">“{target.name}” is not empty: {existingChannels} channels, {existingRoles} roles.</Notice>
                    )}
                    {sameAsSource && <Notice tone="danger">This is the backup's original server - everything would be created twice.</Notice>}
                </Card>
            )}

            {bundle && (
                <Card title="What will be created?" icon="table">
                    {(Object.keys(SECTION_LABELS) as (keyof RestoreSections)[]).map(key => (
                        <ToggleRow
                            key={key}
                            checked={sections[key]}
                            disabled={job.state.running}
                            onChange={v => setSections(s => ({ ...s, [key]: v }))}
                            label={SECTION_LABELS[key]}
                            hint={counts[key]}
                        />
                    ))}
                    <ToggleRow
                        danger
                        checked={deleteExisting}
                        disabled={job.state.running}
                        onChange={v => { setDeleteExisting(v); setDeleteConfirmed(false); }}
                        label="Delete existing channels/roles first"
                        hint="Deletes all channels and all non-managed roles in the target server before the backup is applied."
                    />
                    {deleteExisting && (
                        <div className={cl("danger-zone")}>
                            <div className={cl("danger-title")}><Icon name="warning" size={20} /> Irreversible!</div>
                            <div>
                                In the server <b>“{target?.name ?? "(no target selected)"}”</b>, <b>{existingChannels} channels</b> including all
                                messages and <b>{existingRoles} roles</b> will be permanently deleted. Nobody can undo this.
                            </div>
                            <label className={cl("confirm")}>
                                <input type="checkbox" checked={deleteConfirmed} disabled={!target || job.state.running} onChange={e => setDeleteConfirmed(e.currentTarget.checked)} />
                                <span>Yes, I want to delete everything in “{target?.name ?? "…"}”.</span>
                            </label>
                        </div>
                    )}
                </Card>
            )}

            {bundle && (
                <Card title="Start" icon="play" right={<QueueBadge />}>
                    <Notice tone="info">
                        The restore sends about <b>{requests} API requests</b> from your account. They are throttled on purpose
                        (roughly one per {queueConfig.interval / 1000 === 1 ? "second" : `${queueConfig.interval / 1000} s`}),
                        so Discord doesn't restrict your account - estimated duration: <b>{formatDuration(eta)}</b>. You can cancel at any time.
                    </Notice>
                    <div className={cl("actions")}>
                        {job.state.running
                            ? <Button variant="danger" icon="stop" onClick={job.cancel}>Cancel</Button>
                            : (
                                <Button
                                    icon="restore"
                                    variant={deleteExisting ? "danger" : "primary"}
                                    disabled={!canStart}
                                    onClick={start}
                                >
                                    {deleteExisting ? "Delete & restore" : "Restore"}
                                </Button>
                            )}
                    </div>
                    {job.state.running && <ProgressBar done={job.state.done} total={job.state.total} label={job.state.label} />}
                    {result && (
                        <div className={classes(cl("hint"), result.failed ? cl("text-warn") : cl("text-good"))}>
                            Done: {result.ok} succeeded, {result.failed} failed.
                        </div>
                    )}
                    <LogList entries={job.state.log} />
                </Card>
            )}
        </div>
    );
}

// ---------------------------------------------------------------- Window

function BackupPanel({ guildId, initialTab }: { guildId: string | null; initialTab: Tab; }) {
    const [tab, setTab] = useState<Tab>(initialTab);
    return (
        <div className={cl("modal")}>
            <Segmented<Tab>
                value={tab}
                onChange={setTab}
                options={[
                    { value: "export", label: "Create backup" },
                    { value: "restore", label: "Restore" }
                ]}
            />
            {/* Both tabs stay mounted so a running job keeps going when switching */}
            <div hidden={tab !== "export"}><ExportTab initialGuildId={guildId} /></div>
            <div hidden={tab !== "restore"}><RestoreTab /></div>
        </div>
    );
}

export function openBackupModal(guildId: string | null, tab: Tab = "export") {
    openModal(props => (
        <Modal {...props} size="lg" title="ServerBackup" subtitle="Back up a server and restore it into a server of your own">
            <ErrorBoundary>
                <BackupPanel guildId={guildId} initialTab={tab} />
            </ErrorBoundary>
        </Modal>
    ));
}
