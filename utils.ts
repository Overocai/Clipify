/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Logger } from "@utils/Logger";

export const logger = new Logger("Clipify");

/* ========================================================================== */
/*                              File detection                                */
/* ========================================================================== */

/** Extensions we treat as video even when the browser fails to set a MIME type. */
const VIDEO_EXTENSIONS: readonly string[] = [
    "mp4", "webm", "mov", "mkv", "avi", "m4v", "mpg", "mpeg", "wmv", "flv", "ts", "3gp", "ogv"
];

/**
 * Whether a {@link File} should be treated as a trimmable video.
 * Prefers the MIME type, falling back to the file extension because some
 * platforms (and pasted blobs) don't populate `type`.
 */
export function isVideoFile(file: File): boolean {
    if (file.type.startsWith("video/")) return true;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Pull every concrete {@link File} out of an `UPLOAD_ATTACHMENT_ADD_FILES`
 * action. Discord wraps files in a few different shapes across drag/drop,
 * paste and the file picker, so we probe each known container.
 */
export function extractFiles(value: unknown): File[] {
    if (value instanceof File) return [value];
    if (!Array.isArray(value)) return [];

    return value.flatMap(entry => {
        if (entry instanceof File) return [entry];
        if (!entry || typeof entry !== "object") return [];

        const directFile = "file" in entry ? (entry as { file: unknown; }).file : null;
        if (directFile instanceof File) return [directFile];

        const item = "item" in entry && entry.item && typeof entry.item === "object"
            ? (entry as { item: { file?: unknown; }; }).item
            : null;
        if (item && item.file instanceof File) return [item.file];

        return [];
    });
}

/* ========================================================================== */
/*                               Time helpers                                 */
/* ========================================================================== */

function pad(n: number, len = 2): string {
    return String(Math.max(0, Math.floor(n))).padStart(len, "0");
}

/** Format a number of seconds as `HH:MM:SS.mmm`. */
export function formatTimecode(seconds: number): string {
    const t = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const ms = Math.round((t - Math.floor(t)) * 1000);
    // Rounding ms can roll over to 1000 — normalise so we never print `.1000`.
    const msSafe = ms === 1000 ? 999 : ms;
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(msSafe, 3)}`;
}

/** Clamp a value into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

/** Strip the extension from a file name (`clip.final.mp4` → `clip.final`). */
export function baseName(name: string): string {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
}

/* ========================================================================== */
/*                          MediaRecorder export                              */
/* ========================================================================== */

/** Which trimming engine to use. */
export type Engine = "ffmpeg" | "mediarecorder";

/** Bitrate presets exposed through the plugin settings. */
export type ExportQuality = "high" | "medium" | "low";

/** Map a quality preset to an x264 CRF (lower = better quality). */
export function qualityToCrf(quality: ExportQuality): number {
    return quality === "high" ? 18 : quality === "medium" ? 23 : 28;
}

const QUALITY_BITRATE: Readonly<Record<ExportQuality, number>> = {
    high: 8_000_000,
    medium: 4_000_000,
    low: 1_500_000
};

/** Pick the best webm codec the current MediaRecorder supports. */
function pickMimeType(): string {
    const candidates = [
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
    ];
    for (const c of candidates) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) return c;
    }
    return "video/webm";
}

/** Resolve once the element has seeked to (approximately) `time`. */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise<void>(resolve => {
        const onSeeked = () => {
            video.removeEventListener("seeked", onSeeked);
            resolve();
        };
        video.addEventListener("seeked", onSeeked);
        video.currentTime = time;
    });
}

/** Cooperative cancellation token passed into {@link exportTrimmedVideo}. */
export interface ExportSignal {
    cancelled: boolean;
}

export interface ExportOptions {
    quality?: ExportQuality;
    onProgress?: (fraction: number) => void;
    signal?: ExportSignal;
}

/**
 * Trim `[startTime, endTime]` out of `file` and return it as a new `.webm`
 * {@link File}.
 *
 * Strategy (dependency-free): play the source in an off-screen `<video>`,
 * capture its video track via `captureStream()`, route audio through a
 * detached Web Audio graph (so nothing leaks to the speakers while still
 * being recorded), and feed both into a {@link MediaRecorder}. Recording is
 * real-time — a 30s selection takes ~30s — and re-encodes to webm.
 */
export async function exportTrimmedVideo(
    file: File,
    startTime: number,
    endTime: number,
    options: ExportOptions = {}
): Promise<File> {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = false;
    video.playsInline = true;
    video.preload = "auto";
    // Kept in the DOM and lightly rendered: captureStream needs a live element,
    // but it must not be `display:none` or it stops producing frames.
    video.style.cssText = "position:fixed;left:-99999px;top:0;width:480px;height:auto;opacity:0.01;pointer-events:none;z-index:-1;";
    document.body.appendChild(video);

    let audioCtx: AudioContext | undefined;

    const cleanup = () => {
        try { video.pause(); } catch { /* ignore */ }
        video.removeAttribute("src");
        video.remove();
        URL.revokeObjectURL(url);
        if (audioCtx && audioCtx.state !== "closed") audioCtx.close().catch(() => { });
    };

    try {
        await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("Could not load the video for export."));
        });

        const capture: (() => MediaStream) | undefined =
            (video as any).captureStream?.bind(video) ?? (video as any).mozCaptureStream?.bind(video);
        if (!capture) throw new Error("captureStream is not supported in this environment.");

        // Audio: detached graph → MediaStreamDestination only (never the
        // speakers), so the export is silent to the user but still captured.
        let audioTracks: MediaStreamTrack[] = [];
        try {
            const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
            audioCtx = new AC();
            const sourceNode = audioCtx.createMediaElementSource(video);
            const dest = audioCtx.createMediaStreamDestination();
            sourceNode.connect(dest);
            audioTracks = dest.stream.getAudioTracks();
        } catch (err) {
            logger.warn("Web Audio capture unavailable, falling back to element audio", err);
            audioTracks = [];
        }

        const elementStream = capture();
        const videoTracks = elementStream.getVideoTracks();
        if (audioTracks.length === 0) audioTracks = elementStream.getAudioTracks();

        const combined = new MediaStream([...videoTracks, ...audioTracks]);

        const mimeType = pickMimeType();
        const recorder = new MediaRecorder(combined, {
            mimeType,
            videoBitsPerSecond: QUALITY_BITRATE[options.quality ?? "high"]
        });

        const chunks: BlobPart[] = [];
        recorder.ondataavailable = e => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });

        await seekTo(video, startTime);

        recorder.start();
        if (audioCtx?.state === "suspended") await audioCtx.resume().catch(() => { });
        await video.play();

        // Drive playback to the out-point, reporting progress each frame.
        await new Promise<void>(resolve => {
            const span = Math.max(0.001, endTime - startTime);
            const tick = () => {
                if (options.signal?.cancelled) return resolve();
                const cur = video.currentTime;
                options.onProgress?.(clamp((cur - startTime) / span, 0, 1));
                if (cur >= endTime || video.ended) return resolve();
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });

        video.pause();
        if (recorder.state !== "inactive") recorder.stop();
        await stopped;

        if (options.signal?.cancelled) throw new Error("Export cancelled.");

        const type = mimeType.split(";")[0] || "video/webm";
        const blob = new Blob(chunks, { type });
        if (blob.size === 0) throw new Error("Export produced an empty file.");

        options.onProgress?.(1);
        return new File([blob], `${baseName(file.name)}.webm`, { type });
    } finally {
        cleanup();
    }
}
