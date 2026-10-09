/*
 * PeopleRoulette – roulette window, title bar button & settings
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./ui.css";

import { classNameFactory } from "@api/Styles";
import ErrorBoundary from "@components/ErrorBoundary";
import { Switch } from "@components/Switch";
import { copyToClipboard } from "@utils/clipboard";
import { fetchUserProfile, openPrivateChannel, openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import type { Activity } from "@vencord/discord-types";
import type { ReactNode } from "react";
import { findComponentByCodeLazy } from "@webpack";
import {
    GuildMemberStore, GuildStore, IconUtils, Modal, openModal, Parser, PresenceStore, showToast, SnowflakeUtils, useEffect, useMemo,
    UserProfileStore, UserStore, useRef, useState, useStateFromStores
} from "@webpack/common";

import { Candidate, getPool, markSeen, pickRandom, PoolResult, resetSeen, settings, SkipReason } from "./index";

const cl = classNameFactory("vc-roulette-");
const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');

/** Picks from this session, so you can go back to someone */
const recent: Candidate[] = [];
const RECENT_MAX = 8;

// ---------------------------------------------------------------- Icons

const COPY_PATH = "M15 2H5a2 2 0 0 0-2 2v12h2V4h10V2Zm3 4H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Zm0 14H9V8h9v12Z";
const CHECK_PATH = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z";
const DICE_PATH = "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2.5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm-4.5 4.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM7.5 15a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm9 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z";

function Icon({ path, size = 20, className }: { path: string; size?: number; className?: string; }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} className={classes(cl("icon"), className)}>
            <path fill="currentColor" d={path} />
        </svg>
    );
}

// ---------------------------------------------------------------- Helpers

type Status = "online" | "idle" | "dnd" | "offline";

function getStatus(id: string): Status {
    const s = PresenceStore.getStatus(id) as string;
    return s === "online" || s === "idle" || s === "dnd" ? s : "offline";
}

function getActivityText(activities: Activity[]): string | null {
    const main = activities.find(a => a.type !== 4);
    if (main) {
        switch (main.type) {
            case 0: return `Playing ${main.name}`;
            case 1: return `Streaming ${main.details || main.name}`;
            case 2: return main.details
                ? `Listening to ${main.details}${main.state ? ` by ${main.state.replace(/;/g, ",")}` : ""}`
                : `Listening to ${main.name}`;
            case 3: return `Watching ${main.details || main.name}`;
            case 5: return `Competing in ${main.name}`;
            default: return main.name;
        }
    }
    const custom = activities.find(a => a.type === 4);
    if (custom) {
        const emoji = custom.emoji && !custom.emoji.id ? custom.emoji.name + " " : "";
        return (emoji + (custom.state ?? "")).trim() || null;
    }
    return null;
}

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function accountAge(id: string) {
    const days = Math.floor((Date.now() - SnowflakeUtils.extractTimestamp(id)) / 86_400_000);
    if (days >= 365) return `${Math.floor(days / 365)} year${days >= 730 ? "s" : ""}`;
    if (days >= 30) return `${Math.floor(days / 30)} month${days >= 60 ? "s" : ""}`;
    return `${days} days`;
}

// ---------------------------------------------------------------- Card

const BIO_LINES = 4;

/** http(s) links and bare "www." links; trailing punctuation is not part of the link */
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<>"]+[^\s<>".,;:!?)\]}'])/gi;

function BioLink({ href, children }: { href: string; children: ReactNode; }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);

    function copy() {
        // DiscordNative's copy is synchronous and returns nothing, so wrap it to always get a promise
        Promise.resolve().then(() => copyToClipboard(href)).then(() => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
        }, () => showToast("Couldn't copy the link", "failure"));
    }

    return (
        <span className={cl("link-wrap")}>
            <a className={cl("link")} href={href} target="_blank" rel="noreferrer noopener" title={href}>{children}</a>
            <button
                className={classes(cl("link-copy"), copied && cl("link-copied"))}
                title={copied ? "Copied!" : "Copy link"}
                onClick={copy}
            >
                <Icon key={copied ? "check" : "copy"} path={copied ? CHECK_PATH : COPY_PATH} size={12} />
            </button>
        </span>
    );
}

function linkify(text: string) {
    const parts: ReactNode[] = [];
    let last = 0;
    for (const m of text.matchAll(URL_RE)) {
        if (m.index! > last) parts.push(text.slice(last, m.index));
        const href = /^https?:/i.test(m[0]) ? m[0] : `https://${m[0]}`;
        parts.push(<BioLink key={m.index} href={href}>{m[0]}</BioLink>);
        last = m.index! + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
}

/**
 * Discord's own markdown parser (emojis, bold, spoilers, headings, timestamps, ...) with its link rules
 * swapped for our link with a copy button
 */
let bioParser: ((content: string, inline?: boolean, state?: Record<string, any>) => ReactNode[]) | null = null;

function getBioParser() {
    if (bioParser) return bioParser;
    const rules: Record<string, any> = { ...Parser.defaultRules };
    for (const name of ["url", "link", "autolink"]) {
        if (!rules[name]) continue;
        rules[name] = {
            ...rules[name],
            react: (node: any, output: (n: any, s: any) => ReactNode, state: any) => (
                <BioLink key={state.key} href={node.target}>
                    {node.content ? output(node.content, state) : node.target}
                </BioLink>
            )
        };
    }
    return bioParser = Parser.reactParserFor(rules);
}

function renderBio(text: string): ReactNode {
    try {
        return getBioParser()(text, true, { allowLinks: true, allowEmojiLinks: true, allowHeading: true, allowList: true });
    } catch {
        return linkify(text);
    }
}

/** Long bios are cut after a few lines with "Show more" instead of an inner scroll box */
function Bio({ text }: { text: string; }) {
    const [expanded, setExpanded] = useState(false);
    // Every line of the bio is its own row, like in Discord's profile
    const lines = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().split("\n");
    const long = lines.length > BIO_LINES;
    const shown = long && !expanded ? lines.slice(0, BIO_LINES) : lines;

    return (
        <div className={cl("bio")}>
            <div className={cl("bio-text")}>
                {shown.map((line, i) => (
                    <div key={i} className={cl("bio-line")}>
                        {line.trim()
                            ? <ErrorBoundary fallback={() => <>{linkify(line)}</>}>{renderBio(line)}</ErrorBoundary>
                            : <br />}
                    </div>
                ))}
            </div>
            {long && (
                <button className={cl("bio-more")} onClick={() => setExpanded(v => !v)}>
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </div>
    );
}

function PersonCard({ candidate, onClose }: { candidate: Candidate; onClose(): void; }) {
    const { id, guildIds } = candidate;
    const user = useStateFromStores([UserStore], () => UserStore.getUser(id));
    const profile = useStateFromStores([UserProfileStore], () => UserProfileStore.getUserProfile(id));
    const status = useStateFromStores([PresenceStore], () => getStatus(id));
    const activity = useStateFromStores([PresenceStore], () => getActivityText(PresenceStore.getActivities(id) ?? []));

    // Bio, pronouns and banner color come from the profile, which isn't loaded for strangers yet
    useEffect(() => {
        fetchUserProfile(id, { guild_id: guildIds[0] }).catch(() => { });
    }, [id]);

    if (!user) return null;

    const name = user.globalName || user.username;
    const accent = profile?.accentColor != null ? `#${profile.accentColor.toString(16).padStart(6, "0")}` : undefined;
    const bannerHash = profile?.banner ?? user.banner;
    const banner = bannerHash ? IconUtils.getUserBannerURL({ id, banner: bannerHash, canAnimate: true, size: 600 }) : undefined;
    const guilds = guildIds.map(g => GuildStore.getGuild(g)).filter(Boolean);
    const nick = guildIds.map(g => GuildMemberStore.getNick(g, id)).find(Boolean);

    return (
        <div className={cl("card")}>
            <div className={cl("banner")} style={banner ? { backgroundImage: `url(${banner})` } : accent ? { background: accent } : undefined} />
            <div className={cl("card-body")}>
                <div className={cl("avatar-wrap")} onClick={() => openUserProfile(id)} title="Open profile">
                    <img className={cl("avatar")} src={user.getAvatarURL(undefined, 128, true)} alt="" />
                    <span className={classes(cl("status"), cl(`status-${status}`))} />
                </div>

                <div className={cl("name")}>{name}</div>
                <div className={cl("sub")}>
                    @{user.username}
                    {profile?.pronouns && <> · {profile.pronouns}</>}
                    {nick && nick !== name && <> · “{nick}” on the server</>}
                </div>

                {activity && <div className={cl("activity")}>{activity}</div>}
                {profile?.bio && <Bio text={profile.bio} />}

                <div className={cl("facts")}>
                    <span>Account {accountAge(id)} old</span>
                    <span>Since {fmtDate(SnowflakeUtils.extractTimestamp(id))}</span>
                </div>

                {guilds.length > 0 && (
                    <div className={cl("guilds")}>
                        <span className={cl("label")}>Shared server{guilds.length > 1 ? "s" : ""}</span>
                        <div className={cl("guild-list")}>
                            {guilds.slice(0, 6).map(g => (
                                <span key={g!.id} className={cl("guild")} title={g!.name}>
                                    {g!.icon
                                        ? <img src={IconUtils.getGuildIconURL({ id: g!.id, icon: g!.icon, canAnimate: false, size: 32 })} alt="" />
                                        : <span className={cl("guild-acronym")}>{g!.name.slice(0, 2)}</span>}
                                    <span className={cl("guild-name")}>{g!.name}</span>
                                </span>
                            ))}
                            {guilds.length > 6 && <span className={cl("more")}>+{guilds.length - 6}</span>}
                        </div>
                    </div>
                )}

                <div className={cl("card-actions")}>
                    <button className={classes(cl("btn"), cl("btn-brand"))} onClick={() => { openPrivateChannel(id); onClose(); }}>
                        Message
                    </button>
                    <button className={cl("btn")} onClick={() => openUserProfile(id)}>Profile</button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Pool stats

const fmt = (n: number) => n.toLocaleString("en-US");

const SKIP_LABELS: Record<SkipReason, string> = {
    relationship: "Friends, blocked or pending requests",
    dm: "Already in your DMs",
    seen: "Already shown",
    new: "Account too new",
    bot: "Bots",
    lurker: "Only lurking in the server",
    excluded: "Only in excluded servers"
};

function PoolStats({ stats }: { stats: PoolResult; }) {
    const rows = (Object.entries(stats.skipped) as [SkipReason, number][])
        .filter(([, n]) => n > 0)
        .sort(([, a], [, b]) => b - a);

    return (
        <div className={cl("stats")}>
            <p>
                Discord never sends your client the full member list of a server, only the people you have come
                across: members shown in the member list, people in chats you opened and in voice channels. That is
                the “loaded” number - it grows the more you use Discord. Loading everyone would mean scraping member
                lists, which Discord treats as abuse and can lock accounts for, so the plugin doesn't do that.
            </p>
            <div className={cl("stats-rows")}>
                {rows.map(([reason, n]) => (
                    <div key={reason} className={cl("stats-row")}>
                        <span>{SKIP_LABELS[reason]}</span>
                        <span>−{fmt(n)}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------- Roulette

const SPIN_TIME = 1400;
const SPIN_STEP = 70;

function Roulette({ onClose }: { onClose(): void; }) {
    const [current, setCurrent] = useState<Candidate | null>(recent[0] ?? null);
    const [spinning, setSpinning] = useState(false);
    const [flicker, setFlicker] = useState<string | null>(null);
    const [stats, setStats] = useState<PoolResult>(getPool);
    const [showStats, setShowStats] = useState(false);
    const poolSize = stats.pool.length;
    const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

    useEffect(() => () => clearInterval(timer.current), []);

    function spin() {
        const result = getPool();
        const { pool } = result;
        setStats(result);
        const winner = pickRandom(pool);
        if (!winner) {
            setCurrent(null);
            return;
        }

        // Flick through random avatars before landing on the winner
        setSpinning(true);
        const started = Date.now();
        clearInterval(timer.current);
        timer.current = setInterval(() => {
            if (Date.now() - started >= SPIN_TIME) {
                clearInterval(timer.current);
                markSeen(winner.id);
                recent.unshift(winner);
                recent.splice(RECENT_MAX);
                setStats(getPool());
                setFlicker(null);
                setCurrent(winner);
                setSpinning(false);
                return;
            }
            setFlicker(pickRandom(pool)!.id);
        }, SPIN_STEP);
    }

    const flickerUser = flicker ? UserStore.getUser(flicker) : null;

    return (
        <div className={cl("roulette")}>
            <div className={cl("stage")}>
                {spinning ? (
                    <div className={cl("spinner")}>
                        {flickerUser && <img className={cl("spin-avatar")} src={flickerUser.getAvatarURL(undefined, 128, false)} alt="" />}
                    </div>
                ) : current ? (
                    <PersonCard key={current.id} candidate={current} onClose={onClose} />
                ) : (
                    <div className={cl("empty")}>
                        <Icon path={DICE_PATH} size={48} />
                        {poolSize
                            ? <span>Press the button to meet someone random from your servers.</span>
                            : <span>Nobody left who matches your filters. Open some member lists or relax the filters in the settings.</span>}
                    </div>
                )}
            </div>

            <button className={classes(cl("btn"), cl("btn-brand"), cl("spin"))} disabled={spinning || !poolSize} onClick={spin}>
                <Icon path={DICE_PATH} size={18} />
                {current ? "Next person" : "Find someone"}
            </button>

            <button className={cl("pool")} onClick={() => setShowStats(v => !v)}>
                {fmt(poolSize)} of {fmt(stats.loaded)} loaded people match your filters
                <span className={cl("pool-why")}>{showStats ? "Hide" : "Why so few?"}</span>
            </button>
            {showStats && <PoolStats stats={stats} />}

            {recent.length > 1 && (
                <div className={cl("recent")}>
                    <span className={cl("label")}>Recently</span>
                    <div className={cl("recent-list")}>
                        {recent.map(c => {
                            const u = UserStore.getUser(c.id);
                            if (!u) return null;
                            return (
                                <img
                                    key={c.id}
                                    className={classes(cl("recent-avatar"), current?.id === c.id && cl("recent-active"))}
                                    src={u.getAvatarURL(undefined, 40, false)}
                                    title={u.globalName || u.username}
                                    alt=""
                                    onClick={() => !spinning && setCurrent(c)}
                                />
                            );
                        })}
                    </div>
                </div>
            )}

            <div className={cl("note")}>
                Discord doesn't reveal whether someone accepts DMs from server members. If your message can't be
                delivered, they only take DMs from friends - just spin again. Be nice!
            </div>
        </div>
    );
}

export function openRouletteModal() {
    openModal(props => (
        <Modal {...props} size="md" title="People Roulette" actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
            <ErrorBoundary noop>
                <Roulette onClose={props.onClose} />
            </ErrorBoundary>
        </Modal>
    ));
}

// ---------------------------------------------------------------- Settings

const FILTERS = [
    ["skipExistingDms", "Skip people you already have a DM with"],
    ["skipSeen", "Don't show the same person twice"],
    ["showTitleBarButton", "Show icon in the title bar"]
] as const;

export const SettingsPanel = ErrorBoundary.wrap(() => {
    const s = settings.use(["skipExistingDms", "skipSeen", "showTitleBarButton", "minAccountAgeDays", "excludedGuilds", "seen"]);
    const guilds = useMemo(() => Object.values(GuildStore.getGuilds()).sort((a, b) => a.name.localeCompare(b.name)), []);
    const excluded = new Set(s.excludedGuilds);

    return (
        <div className={cl("settings")}>
            <button className={classes(cl("btn"), cl("btn-brand"))} onClick={() => openRouletteModal()}>Open People Roulette</button>

            {FILTERS.map(([key, label]) => (
                <label key={key} className={cl("option")}>
                    <span>{label}</span>
                    <Switch checked={s[key]} onChange={v => settings.store[key] = v} />
                </label>
            ))}

            <label className={cl("option")}>
                <span>Minimum account age (days)</span>
                <input
                    className={cl("number")}
                    type="number"
                    min={0}
                    value={s.minAccountAgeDays}
                    onChange={e => settings.store.minAccountAgeDays = Math.max(0, Number(e.currentTarget.value) || 0)}
                />
            </label>

            <div className={cl("option")}>
                <span>{s.seen.length} people already shown</span>
                <button className={cl("btn")} disabled={!s.seen.length} onClick={resetSeen}>Reset</button>
            </div>

            <div className={cl("label")}>Servers to pick from</div>
            <div className={cl("guild-picker")}>
                {guilds.map(g => (
                    <label key={g.id} className={cl("guild-row")}>
                        {g.icon
                            ? <img src={IconUtils.getGuildIconURL({ id: g.id, icon: g.icon, canAnimate: false, size: 32 })} alt="" />
                            : <span className={cl("guild-acronym")}>{g.name.slice(0, 2)}</span>}
                        <span className={cl("guild-name")}>{g.name}</span>
                        <Switch
                            checked={!excluded.has(g.id)}
                            onChange={v => settings.store.excludedGuilds = v
                                ? s.excludedGuilds.filter(x => x !== g.id)
                                : [...s.excludedGuilds, g.id]}
                        />
                    </label>
                ))}
            </div>
        </div>
    );
}, { noop: true });

// ---------------------------------------------------------------- Title bar

function TitleBarButton() {
    const { showTitleBarButton } = settings.use(["showTitleBarButton"]);
    if (!showTitleBarButton) return null;

    return (
        <HeaderBarIcon
            className={cl("btn-titlebar")}
            onClick={() => openRouletteModal()}
            tooltip="People Roulette"
            icon={() => <Icon path={DICE_PATH} />}
        />
    );
}

export function renderTitleBarButton() {
    return (
        <ErrorBoundary key="vc-roulette-titlebar" noop>
            <TitleBarButton />
        </ErrorBoundary>
    );
}
