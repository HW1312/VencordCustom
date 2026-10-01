/*
 * LinkCards – YouTube videos: title & channel (oEmbed), views, likes, dislikes (Return YouTube Dislike)
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ICONS } from "../icons";
import { api } from "../net";
import { CardView, formatCompact, formatNumber, hostIs, HttpError, NotFoundError, Provider, segments, Stat, Target } from "../types";

type VideoTarget = Target & { videoId: string; short: boolean; };

const VIDEO_ID = /^[\w-]{11}$/;

function match(url: URL): VideoTarget | null {
    let videoId: string | null | undefined;
    let short = false;

    if (hostIs(url, "youtu.be")) {
        [videoId] = segments(url);
    } else if (hostIs(url, "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com")) {
        const [section, id] = segments(url);
        if (section === "watch") videoId = url.searchParams.get("v");
        else if (section === "shorts" || section === "live" || section === "embed") {
            videoId = id;
            short = section === "shorts";
        }
    }

    if (!videoId || !VIDEO_ID.test(videoId)) return null;
    return { videoId, short, id: videoId, url: url.href };
}

interface VideoData {
    title?: string | null;
    channel?: string | null;
    views?: number | null;
    likes?: number | null;
    dislikes?: number | null;
}

async function fetchVideo(t: VideoTarget): Promise<VideoData> {
    const watchUrl = `https://www.youtube.com/watch?v=${t.videoId}`;
    const [oembed, votes] = await Promise.all([
        // 401 = embedding disabled – the video still exists
        api(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`)
            .catch(e => e instanceof HttpError && e.status === 401 ? null : Promise.reject(e)),
        api(`https://returnyoutubedislikeapi.com/votes?videoId=${t.videoId}`).catch(() => null)
    ]);

    if (!oembed && !votes) throw new NotFoundError();

    return {
        title: oembed?.title,
        channel: oembed?.author_name,
        views: votes?.viewCount,
        likes: votes?.likes,
        dislikes: votes?.dislikes
    };
}

function render(d: VideoData, t: VideoTarget): CardView {
    const stats: Stat[] = [];
    if (d.views != null) stats.push({ icon: ICONS.eye, value: `${formatCompact(d.views)} views`, title: `${formatNumber(d.views)} views` });
    if (d.likes != null) stats.push({ icon: ICONS.thumb, value: formatCompact(d.likes), title: `${formatNumber(d.likes)} likes` });
    if (d.dislikes != null) stats.push({ icon: ICONS.thumbDown, value: formatCompact(d.dislikes), title: `${formatNumber(d.dislikes)} dislikes (estimated by Return YouTube Dislike)` });

    return {
        color: "#ff0033",
        provider: "YouTube",
        context: t.short ? "Short" : "Video",
        icon: ICONS.play,
        title: d.title || `Video ${t.videoId}`,
        url: t.short ? `https://www.youtube.com/shorts/${t.videoId}` : `https://www.youtube.com/watch?v=${t.videoId}`,
        meta: [d.channel],
        stats
    };
}

export const youtube: Provider<VideoTarget, VideoData> = {
    id: "youtube",
    label: "YouTube",
    hint: "Videos and Shorts: views, likes, dislikes",
    ttl: 15 * 60_000,
    match,
    fetch: fetchVideo,
    render
};
