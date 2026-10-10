import assert from "node:assert/strict";
import test from "node:test";
import { safeCoverUrl, trackKey } from "../artwork.ts";
import { createPresence } from "../presence.ts";

const cover = "https://litter.catbox.moe/ab12cd.jpg";
const track = { title: "A Song - Remix", artist: "An Artist", album: "An Album", durationMs: 180500 };

test("cover links must be own Litterbox uploads over HTTPS with no credentials", () => {
    for (const url of ["http://litter.catbox.moe/ab12cd.jpg", "data:image/png;base64,test",
        "https://litter.catbox.moe.evil.example/ab12cd.jpg", cover.replace("https://", "https://user@"),
        cover.replace("litter.catbox.moe", "litter.catbox.moe:444"), "https://litter.catbox.moe/ab12cd.exe",
        `${cover}?x=1`, "https://files.catbox.moe/ab12cd.jpg", "https://litter.catbox.moe/../x/ab12cd.jpg", 42, null]) {
        assert.equal(safeCoverUrl(url), null, String(url));
    }
    assert.equal(safeCoverUrl(cover), cover);
    assert.equal(safeCoverUrl("https://litter.catbox.moe/zz9988.png"), "https://litter.catbox.moe/zz9988.png");
});
test("track keys distinguish albums and do not collide on separators", () => {
    assert.notEqual(trackKey(track), trackKey({ ...track, album: "Other" }));
    assert.notEqual(trackKey({ title: "a|b", artist: "c", album: "d" }), trackKey({ title: "a", artist: "b|c", album: "d" }));
});
test("resolved cover becomes the large Discord asset without account fields", () => {
    const now = Date.now();
    const activity = createPresence({ ...track, playing: true, positionMs: 10000, observedAt: now }, {
        applicationId: "1528896038163710112", showProgress: true, searchButton: false, coverAsset: "mp:external/resolved-cover"
    }, now);
    assert.deepEqual(activity.assets, { large_image: "mp:external/resolved-cover", large_text: "An Album" });
    assert.ok(!("session_id" in activity));
    assert.ok(!("sync_id" in activity));
});
