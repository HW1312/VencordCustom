/*
 * ChatPopout – user profile card inside the popout window
 * Discord's profile popout renders into the main window, so this is a compact recreation.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fetchUserProfile, openUserProfile } from "@utils/discord";
import { classes } from "@utils/misc";
import { GuildMemberStore, GuildRoleStore, IconUtils, PresenceStore, useEffect, useLayoutEffect, useRef, UserProfileStore, UserStore, useState, useStateFromStores } from "@webpack/common";

import { copyText } from "./media";
import { CDN, cl, Icon, ID_PATH, log, Markdown, tip } from "./shared";

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

const snowflakeDate = (id: string) => new Date(Number(BigInt(id) >> 22n) + 1420070400000);
const formatDate = (d: Date) => d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
const toColor = (n: number | null | undefined) => typeof n === "number" ? `#${n.toString(16).padStart(6, "0")}` : undefined;

export function ProfileCard({ target, onClose, onMessage, onMention }: {
    target: ProfileTarget;
    onClose(): void;
    onMessage?(userId: string): void;
    onMention?(userId: string): void;
}) {
    const { userId, guildId, fallback } = target;
    const ref = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ left: 0, top: 0, ready: false });

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
    }, [target, profile, member]);

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
            <div className={classes(cl("profile-banner"), bannerUrl && cl("profile-banner-image"))} style={bannerUrl ? { backgroundImage: `url("${bannerUrl}")` } : { background: accent }} />
            <div className={cl("profile-avatar-wrap")}>
                <img className={cl("profile-avatar")} src={avatar} alt="" />
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
                            <img key={b.id} src={`${CDN}/badge-icons/${b.icon}.png`} alt="" {...tip(b.description)} />
                        ))}
                    </div>
                )}

                {bio && (
                    <div className={cl("profile-section")}>
                        <div className={cl("profile-label")}>About Me</div>
                        <div className={cl("profile-bio")}><Markdown content={bio} channelId="" messageId="" /></div>
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
                        <button className={classes(cl("profile-btn"), cl("profile-btn-primary"))} onClick={() => { onClose(); onMessage(userId); }}>Message</button>
                    )}
                    {!isWebhook && onMention && (
                        <button className={cl("profile-btn")} onClick={() => { onClose(); onMention(userId); }}>Mention</button>
                    )}
                    {!isWebhook && (
                        <button className={cl("profile-btn")} {...tip("Opens in the main window")} onClick={() => {
                            onClose();
                            window.focus();
                            openUserProfile(userId).catch(e => log.error("Couldn't open profile", e));
                        }}>Full Profile</button>
                    )}
                    <button className={classes(cl("profile-btn"), cl("profile-btn-icon"))} aria-label="Copy User ID" {...tip("Copy User ID", "top", "end")} onClick={() => copyText(userId, "User ID copied")}>
                        <Icon path={ID_PATH} size={16} />
                    </button>
                </div>
            </div>
        </div>
    );
}
