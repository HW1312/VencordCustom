/*
 * ChatPopout – user profile card inside the popout window
 * Discord's profile popout renders into the main window, so this is a compact recreation.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import { fetchUserProfile, openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import { GuildMemberStore, GuildRoleStore, IconUtils, PresenceStore, showToast, Toasts, useEffect, useLayoutEffect, useRef, UserProfileStore, UserStore, useState, useStateFromStores } from "@webpack/common";

import { MediaItem, openExternal } from "./media";
import { CDN, cl, COPY_PATH, Icon, log, Markdown, tip } from "./shared";

export interface ProfileTarget {
    userId: string;
    guildId: string | null;
    /** Clicked element – the card opens next to it */
    anchor: DOMRect;
    /** Author object from the message, for users Discord doesn't know (webhooks) */
    fallback?: any;
}

const EDGE = 8;
const STATUS_COLOR: Record<string, string> = {
    online: "var(--status-positive, #23a55a)",
    idle: "var(--status-warning, #f0b232)",
    dnd: "var(--status-danger, #f23f43)",
    streaming: "#593695"
};

const CHAT_PATH = "M12 3C6.48 3 2 6.92 2 11.5c0 2.3 1.13 4.38 2.96 5.88L4 21l4.13-2.07c1.2.37 2.5.57 3.87.57 5.52 0 10-3.92 10-8.5S17.52 3 12 3Z";
const AT_PATH = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10h5v-2h-5c-4.34 0-8-3.66-8-8s3.66-8 8-8 8 3.66 8 8v1.43c0 .79-.71 1.57-1.5 1.57s-1.5-.78-1.5-1.57V12c0-2.76-2.24-5-5-5s-5 2.24-5 5 2.24 5 5 5c1.38 0 2.64-.56 3.54-1.47.65.89 1.77 1.47 2.96 1.47 1.97 0 3.5-1.6 3.5-3.57V12c0-5.52-4.48-10-10-10Zm0 13c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3Z";
const PROFILE_PATH = "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm0 4c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6Zm0 14c-2.03 0-4.43-.82-6.14-2.88a9.95 9.95 0 0 1 12.28 0C16.43 19.18 14.03 20 12 20Z";
const CHECK_PATH = "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z";

/** Copies the user ID; the icon turns into a green check for a moment instead of a toast in the main window */
function CopyIdButton({ userId }: { userId: string; }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    useEffect(() => () => clearTimeout(timer.current), []);

    function copy() {
        // DiscordNative's copy is synchronous and returns nothing, so wrap it to always get a promise
        Promise.resolve().then(() => copyToClipboard(userId)).then(() => {
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
        }, e => {
            log.error("Couldn't copy", e);
            showToast("Couldn't copy", Toasts.Type.FAILURE);
        });
    }

    return (
        <button
            className={classes(cl("profile-btn"), cl("profile-btn-icon"), copied && cl("profile-btn-copied"))}
            aria-label="Copy User ID"
            {...tip(copied ? "Copied!" : "Copy User ID", "top", "end")}
            onClick={copy}
        >
            <Icon key={copied ? "check" : "copy"} path={copied ? CHECK_PATH : COPY_PATH} size={18} />
        </button>
    );
}

/** Long bios are cut with "Show more" like in Discord's profile, instead of an inner scroll box */
function ProfileBio({ bio, onResize }: { bio: string; onResize(): void; }) {
    const ref = useRef<HTMLDivElement>(null);
    const [expanded, setExpanded] = useState(false);
    const [overflows, setOverflows] = useState(false);

    // Measured after render, because emojis and markdown change the height
    useLayoutEffect(() => {
        const el = ref.current;
        if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
    }, [bio, expanded]);

    return (
        <>
            <div ref={ref} className={classes(cl("profile-bio"), !expanded && cl("profile-bio-collapsed"))}>
                <Markdown content={bio} channelId="" messageId="" />
            </div>
            {(overflows || expanded) && (
                <button className={cl("profile-more")} onClick={() => { setExpanded(v => !v); onResize(); }}>
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </>
    );
}

const snowflakeDate = (id: string) => new Date(Number(BigInt(id) >> 22n) + 1420070400000);
const formatDate = (d: Date) => d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
const toColor = (n: number | null | undefined) => typeof n === "number" ? `#${n.toString(16).padStart(6, "0")}` : undefined;

export function ProfileCard({ target, onClose, onMessage, onMention, onOpenMedia }: {
    target: ProfileTarget;
    onClose(): void;
    onMessage?(userId: string): void;
    onMention?(userId: string): void;
    /** Shows avatar/banner in the popout's media viewer */
    onOpenMedia?(items: MediaItem[], original: string): void;
}) {
    const { userId, guildId, fallback } = target;
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: 0, top: 0, ready: false });
    // Bumped when the bio is expanded, so the card is re-positioned inside the window
    const [resizeTick, setResizeTick] = useState(0);

    const user: any = useStateFromStores([UserStore], () => UserStore.getUser(userId));
    const member: any = useStateFromStores([GuildMemberStore], () => guildId ? GuildMemberStore.getMember(guildId, userId) : null);
    const profile: any = useStateFromStores([UserProfileStore], () => UserProfileStore.getUserProfile(userId));
    const guildProfile: any = useStateFromStores([UserProfileStore], () => guildId ? UserProfileStore.getGuildMemberProfile(userId, guildId) : null);
    const status = useStateFromStores([PresenceStore], () => PresenceStore.getStatus(userId));

    const isWebhook = !user && !!fallback;
    useEffect(() => {
        if (isWebhook || profile) return;
        fetchUserProfile(userId, guildId ? { guild_id: guildId } : undefined).catch(e => log.warn("Couldn't load profile", e));
    }, [userId]);

    // Next to the clicked element, inside the window
    useLayoutEffect(() => {
        const el = ref.current;
        const win = el?.ownerDocument.defaultView;
        if (!el || !win) return;
        const { width, height } = el.getBoundingClientRect();
        const a = target.anchor;
        let left = a.right + 8;
        if (left + width > win.innerWidth - EDGE) left = a.left - width - 8;
        if (left < EDGE) left = Math.min(Math.max(EDGE, a.left), win.innerWidth - width - EDGE);
        const top = Math.max(EDGE, Math.min(a.top, win.innerHeight - height - EDGE));
        setPos({ left, top, ready: true });
    }, [target, profile, member, resizeTick]);

    useEffect(() => {
        const el = ref.current;
        const doc = el?.ownerDocument;
        if (!doc) return;
        const onDown = (e: MouseEvent) => !el.contains(e.target as Node) && onClose();
        const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
        doc.addEventListener("mousedown", onDown, true);
        doc.addEventListener("keydown", onKey, true);
        doc.defaultView?.addEventListener("blur", onClose);
        return () => {
            doc.removeEventListener("mousedown", onDown, true);
            doc.removeEventListener("keydown", onKey, true);
            doc.defaultView?.removeEventListener("blur", onClose);
        };
    }, [onClose]);

    const raw = user ?? fallback ?? {};
    const name: string = member?.nick || raw.globalName || raw.global_name || raw.username || "Unknown";
    const username: string = raw.username ?? "";
    const bot = !!raw.bot || isWebhook;
    const avatar = user
        ? IconUtils.getUserAvatarURL(user, true, 128)
        : raw.avatar ? `${CDN}/avatars/${userId}/${raw.avatar}.${raw.avatar.startsWith("a_") ? "gif" : "webp"}?size=128` : IconUtils.getDefaultAvatarURL(userId);

    const bannerHash: string | undefined = guildProfile?.banner || profile?.banner || raw.banner;
    const bannerUrl = bannerHash ? `${CDN}/banners/${userId}/${bannerHash}.${bannerHash.startsWith("a_") ? "gif" : "png"}?size=480` : null;
    const accent = toColor(profile?.themeColors?.[0] ?? profile?.accentColor ?? raw.accentColor ?? raw.accent_color) ?? member?.colorString ?? "var(--brand-500, #5865f2)";
    const bio: string | undefined = guildProfile?.bio || profile?.bio;
    const pronouns: string | undefined = guildProfile?.pronouns || profile?.pronouns;
    const badges: any[] = profile?.badges ?? [];

    // Full size versions for the media viewer (avatar first, then banner)
    const big = (url: string, size: number) => url.replace(/([?&])size=\d+/, `$1size=${size}`);
    const avatarBig = big(avatar, 1024);
    const media: MediaItem[] = [
        { url: avatarBig, original: big(avatar, 4096), kind: "image", name: `${username || userId}-avatar` },
        ...bannerUrl ? [{ url: big(bannerUrl, 1024), original: big(bannerUrl, 4096), kind: "image" as const, name: `${username || userId}-banner` }] : []
    ];
    const showMedia = (index: number) => onOpenMedia?.(media, media[index].original);

    const roles = guildId && member?.roles?.length
        ? member.roles.map((id: string) => GuildRoleStore.getRole(guildId, id)).filter(Boolean).sort((a: any, b: any) => b.position - a.position)
        : [];

    return (
        <div
            ref={ref}
            className={cl("profile")}
            style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
            onContextMenu={e => e.stopPropagation()}
        >
            <div
                className={classes(cl("profile-banner"), bannerUrl && cl("profile-banner-image"), bannerUrl && onOpenMedia && cl("profile-clickable"))}
                style={bannerUrl ? { backgroundImage: `url("${bannerUrl}")` } : { background: accent }}
                onClick={bannerUrl ? () => showMedia(1) : undefined}
            />
            <div className={cl("profile-avatar-wrap")}>
                <img
                    className={classes(cl("profile-avatar"), onOpenMedia && cl("profile-clickable"))}
                    src={avatar}
                    alt=""
                    onClick={() => showMedia(0)}
                />
                {!isWebhook && STATUS_COLOR[status] && <span className={cl("profile-status")} style={{ background: STATUS_COLOR[status] }} />}
            </div>

            <div className={cl("profile-body")}>
                <div className={cl("profile-name")}>
                    <span>{name}</span>
                    {bot && <span className={cl("bot-tag")}>{isWebhook ? "WEBHOOK" : "APP"}</span>}
                </div>
                <div className={cl("profile-username")}>
                    {username}
                    {pronouns && <span className={cl("profile-pronouns")}> · {pronouns}</span>}
                </div>

                {badges.length > 0 && (
                    <div className={cl("profile-badges")}>
                        {badges.map(b => (
                            // Tooltips are drawn with ::after, which <img> can't have - so the wrapper carries it
                            <span
                                key={b.id}
                                className={classes(cl("profile-badge"), b.link && cl("profile-clickable"))}
                                role={b.link ? "link" : undefined}
                                {...tip(b.description, "top", "start")}
                                onClick={b.link ? e => openExternal(b.link, e.currentTarget.ownerDocument) : undefined}
                            >
                                <img src={`${CDN}/badge-icons/${b.icon}.png`} alt={b.description} />
                            </span>
                        ))}
                    </div>
                )}

                {bio && (
                    <div className={cl("profile-section")}>
                        <div className={cl("profile-label")}>About Me</div>
                        <ProfileBio bio={bio} onResize={() => setResizeTick(t => t + 1)} />
                    </div>
                )}

                {!isWebhook && (
                    <div className={cl("profile-section")}>
                        <div className={cl("profile-label")}>Member Since</div>
                        <div className={cl("profile-since")}>
                            <span {...tip("Discord")}>{formatDate(snowflakeDate(userId))}</span>
                            {member?.joinedAt && <span {...tip("This server")}> · {formatDate(new Date(member.joinedAt))}</span>}
                        </div>
                    </div>
                )}

                {roles.length > 0 && (
                    <div className={cl("profile-section")}>
                        <div className={cl("profile-label")}>Roles</div>
                        <div className={cl("profile-roles")}>
                            {roles.slice(0, 20).map((r: any) => (
                                <span key={r.id} className={cl("profile-role")}>
                                    <span className={cl("profile-role-dot")} style={{ background: r.colorString ?? "var(--text-muted)" }} />
                                    {r.name}
                                </span>
                            ))}
                            {roles.length > 20 && <span className={cl("profile-role")}>+{roles.length - 20}</span>}
                        </div>
                    </div>
                )}

                <div className={cl("profile-actions")}>
                    {!isWebhook && onMessage && userId !== UserStore.getCurrentUser()?.id && (
                        <button
                            className={classes(cl("profile-btn"), cl("profile-btn-icon"), cl("profile-btn-primary"))}
                            aria-label="Message"
                            {...tip(`Message @${user?.username ?? "user"}`, "top", "start")}
                            onClick={() => { onClose(); onMessage(userId); }}
                        >
                            <Icon path={CHAT_PATH} size={18} />
                        </button>
                    )}
                    {!isWebhook && onMention && (
                        <button
                            className={classes(cl("profile-btn"), cl("profile-btn-icon"))}
                            aria-label="Mention"
                            {...tip(`Mention @${user?.username ?? "user"}`)}
                            onClick={() => { onClose(); onMention(userId); }}
                        >
                            <Icon path={AT_PATH} size={18} />
                        </button>
                    )}
                    {!isWebhook && (
                        <button
                            className={classes(cl("profile-btn"), cl("profile-btn-icon"))}
                            aria-label="Full Profile"
                            {...tip("View Full Profile")}
                            onClick={() => {
                                onClose();
                                window.focus();
                                openUserProfile(userId).catch(e => log.error("Couldn't open profile", e));
                            }}
                        >
                            <Icon path={PROFILE_PATH} size={18} />
                        </button>
                    )}
                    <CopyIdButton userId={userId} />
                </div>
            </div>
        </div>
    );
}
