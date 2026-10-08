/*
 * ChatPopout – Sending files from the window's own input (paste, drop, + button).
 * Files within the upload limit are uploaded like Discord does (CloudUpload) and sent as one message. For larger
 * ones it asks first, then hands them to Discord's normal upload, where GofileUpload turns them into a link.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";
import { Channel, CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { Alerts, Constants, DraftType, RestAPI, showToast, SnowflakeUtils, Toasts, UploadHandler, UserStore } from "@webpack/common";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const MB = 1024 * 1024;

/** Discord's upload limit – GofileUpload's numbers when it's on, otherwise Discord's (premiumType 2 = Nitro, 1/3 = Classic / Basic) */
export function uploadLimit() {
    const premium = UserStore.getCurrentUser()?.premiumType ?? 0;
    const gofile = Settings.plugins.GofileUpload;
    const [free, basic, nitro] = gofile?.enabled
        ? [gofile.limitFree ?? 9.8, gofile.limitBasic ?? 49.8, gofile.limitNitro ?? 499]
        : [10, 50, 500];
    return (premium === 2 ? nitro : premium === 1 || premium === 3 ? basic : free) * MB;
}

export function formatBytes(bytes: number) {
    return bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Uploads one file to Discord's storage – the result goes into a message's attachments */
export function uploadOne(file: File, channelId: string) {
    return new Promise<TCloudUpload>((resolve, reject) => {
        const upload = new CloudUpload({ file, isThumbnail: false, platform: CloudUploadPlatform.WEB }, channelId);
        upload.on("complete", () => resolve(upload));
        upload.on("error", () => reject(new Error(`Upload of ${file.name} failed`)));
        upload.upload();
    });
}

export function attachmentOf(upload: TCloudUpload, index: number) {
    return { id: String(index), filename: upload.filename, uploaded_filename: upload.uploadedFilename };
}

/**
 * The file is over the upload limit: ask whether it may go to Gofile (GofileUpload sends the link).
 * win = the window the question should show in (a popout window can't see Discord's dialogs).
 */
export function askGofile(file: File, note: string, win?: Window | null): Promise<boolean> {
    const limit = formatBytes(uploadLimit());
    if (!Settings.plugins.GofileUpload?.enabled) {
        showToast(`${file.name} is larger than your upload limit (${limit}) – turn on GofileUpload to send big files`, Toasts.Type.FAILURE);
        return Promise.resolve(false);
    }
    const text = `“${file.name}” (${formatBytes(file.size)}) is larger than your upload limit (${limit}). Upload it to Gofile and send the link instead? ${note}`;

    if (win && win !== window) return Promise.resolve(win.confirm(text));
    return new Promise(resolve => Alerts.show({
        title: "File too large",
        body: text,
        confirmText: "Use Gofile",
        cancelText: "Cancel",
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        onCloseCallback: () => resolve(false)
    }));
}

/** Hands a file to Discord's normal upload – GofileUpload takes it from there */
export function sendViaGofile(channel: Channel, file: File) {
    UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
}

/** Sends the files as one message (without text – the text goes as its own message) */
export async function sendFiles(channel: Channel, files: File[], messageReference?: unknown, win?: Window | null) {
    const limit = uploadLimit();
    const small: File[] = [];
    for (const f of files) {
        if (f.size <= limit) small.push(f);
        else if (await askGofile(f, "", win)) sendViaGofile(channel, f);
    }
    if (!small.length) return;

    const uploads = await Promise.all(small.map(f => uploadOne(f, channel.id)));
    await RestAPI.post({
        url: Constants.Endpoints.MESSAGES(channel.id),
        body: {
            channel_id: channel.id,
            content: "",
            nonce: SnowflakeUtils.fromTimestamp(Date.now()),
            sticker_ids: [],
            type: 0,
            attachments: uploads.map(attachmentOf),
            message_reference: messageReference ?? null
        }
    });
}
