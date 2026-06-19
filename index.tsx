/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { Channel } from "@vencord/discord-types";
import { ChannelStore, DraftType, FluxDispatcher, openModal, SelectedChannelStore, showToast, Toasts, UploadHandler } from "@webpack/common";

import { ChoiceModal } from "./ChoiceModal";
import { TrimMode } from "./ffmpeg";
import { TrimEditorModal } from "./TrimEditorModal";
import { Engine, ExportQuality, extractFiles, isVideoFile, logger } from "./utils";

/* ========================================================================== */
/*                                  Settings                                  */
/* ========================================================================== */

const settings = definePluginSettings({
    interceptUploads: {
        type: OptionType.BOOLEAN,
        description: "Intercept video uploads and ask before sending.",
        default: true
    },
    engine: {
        type: OptionType.SELECT,
        description: "Trim engine. FFmpeg is precise/lossless (downloads a ~30MB core from jsDelivr on first use); MediaRecorder works offline but re-encodes to .webm in real time.",
        options: [
            { label: "FFmpeg (recommended)", value: "ffmpeg", default: true },
            { label: "MediaRecorder (offline)", value: "mediarecorder" }
        ]
    },
    trimMode: {
        type: OptionType.SELECT,
        description: "FFmpeg mode. Precise cuts at the exact frame (re-encodes, mp4); Lossless is instant and keeps quality, but the start snaps to the nearest keyframe.",
        options: [
            { label: "Precise — exact frame", value: "precise", default: true },
            { label: "Fast — lossless (keyframe)", value: "lossless" }
        ]
    },
    exportQuality: {
        type: OptionType.SELECT,
        description: "Quality of the trimmed video (CRF for precise FFmpeg / bitrate for MediaRecorder).",
        options: [
            { label: "High", value: "high", default: true },
            { label: "Medium", value: "medium" },
            { label: "Low", value: "low" }
        ]
    },
    frameRate: {
        type: OptionType.NUMBER,
        description: "Assumed FPS for frame-by-frame navigation in the editor.",
        default: 30
    }
});

/* ========================================================================== */
/*                              Re-entry guard                                */
/* ========================================================================== */

/**
 * Files we've already vetted (originals the user chose to keep, or freshly
 * trimmed clips). When we hand these back to {@link UploadHandler.promptToUpload}
 * it re-dispatches `UPLOAD_ATTACHMENT_ADD_FILES`; the interceptor must let those
 * through instead of looping back into another modal.
 */
const approvedFiles = new WeakSet<File>();

/** Context captured from the intercepted upload action. */
interface UploadContext {
    channelId: string;
    draftType: number;
}

/* ========================================================================== */
/*                              Orchestration                                 */
/* ========================================================================== */

function resolveChannel(channelId: string): Channel | null {
    return ChannelStore.getChannel(channelId) ?? null;
}

/** Hand a set of files back to Discord's normal upload flow. */
function reAddFiles(files: File[], ctx: UploadContext): void {
    if (files.length === 0) return;
    const channel = resolveChannel(ctx.channelId);
    if (!channel) {
        showToast("Clipify: channel not found to re-add the file.", Toasts.Type.FAILURE);
        return;
    }
    files.forEach(f => approvedFiles.add(f));
    try {
        UploadHandler.promptToUpload(files, channel, ctx.draftType);
    } catch (err) {
        logger.error("Failed to re-add files to the composer", err);
        showToast("Clipify: failed to add the file to your message.", Toasts.Type.FAILURE);
    }
}

/** Entry point: show the choice modal for the pending video(s). */
function startFlow(ctx: UploadContext, videos: File[], others: File[]): void {
    openModal(modalProps => (
        <ChoiceModal
            modalProps={modalProps}
            file={videos[0]}
            videoCount={videos.length}
            onTrim={() => {
                modalProps.onClose();
                openTrimEditor(ctx, videos, others);
            }}
            onSendOriginal={() => {
                reAddFiles([...videos, ...others], ctx);
                modalProps.onClose();
            }}
            onCancel={() => modalProps.onClose()}
        />
    ));
}

function openTrimEditor(ctx: UploadContext, videos: File[], others: File[]): void {
    openModal(modalProps => (
        <TrimEditorModal
            modalProps={modalProps}
            file={videos[0]}
            defaultFps={Number(settings.store.frameRate) || 30}
            quality={settings.store.exportQuality as ExportQuality}
            engine={settings.store.engine as Engine}
            defaultMode={settings.store.trimMode as TrimMode}
            onComplete={trimmed => {
                // Only the first video is trimmed; any further videos in the
                // same drop, plus non-video files, pass through untouched.
                reAddFiles([trimmed, ...videos.slice(1), ...others], ctx);
            }}
        />
    ));
}

/* ========================================================================== */
/*                            Flux interceptor                                */
/* ========================================================================== */

type AddFilesAction = {
    type: string;
    channelId?: string;
    draftType?: number;
    files?: unknown;
    uploads?: unknown;
    items?: unknown;
};

let interceptor: ((action: unknown) => void) | null = null;

function handleAction(action: unknown): void {
    if (!action || typeof action !== "object" || !("type" in action)) return;
    const payload = action as AddFilesAction;
    if (payload.type !== "UPLOAD_ATTACHMENT_ADD_FILES") return;
    if (!settings.store.interceptUploads) return;

    // Only the regular channel/DM composer — leave slash-command args, forum
    // creation, etc. to Discord.
    const draftType = payload.draftType ?? DraftType.ChannelMessage;
    if (draftType !== DraftType.ChannelMessage) return;

    const allFiles = [
        ...extractFiles(payload.files),
        ...extractFiles(payload.uploads),
        ...extractFiles(payload.items)
    ];
    const unique = Array.from(new Set(allFiles));

    const pendingVideos = unique.filter(f => isVideoFile(f) && f.size > 0 && !approvedFiles.has(f));
    if (pendingVideos.length === 0) return; // nothing to do — also lets our re-adds pass

    const others = unique.filter(f => !pendingVideos.includes(f));

    // Neutralise the original action so the unedited video never lands in the
    // composer; we re-add files ourselves after the user decides.
    payload.files = [];
    payload.uploads = [];
    payload.items = [];

    const channelId = payload.channelId ?? SelectedChannelStore.getChannelId();
    if (!channelId) {
        logger.warn("No channel id for intercepted upload; aborting.");
        return;
    }

    // Defer opening the modal: we're running inside a Flux dispatch right now,
    // and openModal dispatches too — doing it synchronously would throw
    // "Cannot dispatch in the middle of a dispatch".
    setTimeout(() => startFlow({ channelId, draftType }, pendingVideos, others), 0);
}

/* ========================================================================== */
/*                             Plugin definition                             */
/* ========================================================================== */

export default definePlugin({
    name: "Clipify",
    description: "Asks whether you want to trim a video before sending and opens a frame-accurate trim editor integrated into Discord.",
    authors: [{ name: "overocai", id: 1288832011452153910n }],
    tags: ["Media"],
    settings,

    start() {
        if (interceptor) return;
        interceptor = action => {
            try {
                handleAction(action);
            } catch (err) {
                logger.error("Interceptor error", err);
            }
        };
        FluxDispatcher.addInterceptor(interceptor);
    },

    stop() {
        if (!interceptor) return;
        const idx = FluxDispatcher._interceptors?.indexOf(interceptor);
        if (idx != null && idx > -1) FluxDispatcher._interceptors.splice(idx, 1);
        interceptor = null;
    }
});
