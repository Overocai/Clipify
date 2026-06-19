/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";

import { classWorkerRaw } from "./ffmpegWorker";
import { baseName, clamp, logger } from "./utils";

/* ========================================================================== */
/*                               Loader                                       */
/* ========================================================================== */

let ffmpeg: FFmpeg | null = null;
let ffmpegLoading: Promise<FFmpeg> | null = null;
let counter = 0;

/** Core matches the build clipUpload ships with, so it's a known-good combo. */
const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";

/**
 * Lazily load ffmpeg.wasm. The core is fetched from jsDelivr (allow-listed in
 * Discord's CSP) and the wrapper worker is supplied as a blob: URL so the
 * bundler never has to emit it. Concurrent callers share one in-flight load.
 */
async function loadFFmpeg(): Promise<FFmpeg> {
    if (ffmpeg?.loaded) return ffmpeg;
    if (ffmpegLoading) return ffmpegLoading;

    ffmpegLoading = (async () => {
        const instance = new FFmpeg();
        const classWorkerBlob = new Blob([new TextEncoder().encode(classWorkerRaw)], { type: "text/javascript" });
        const classWorkerURL = URL.createObjectURL(classWorkerBlob);

        try {
            await instance.load({
                coreURL: `${CORE_BASE}/ffmpeg-core.js`,
                wasmURL: `${CORE_BASE}/ffmpeg-core.wasm`,
                workerURL: `${CORE_BASE}/ffmpeg-core.worker.js`,
                classWorkerURL
            });
            ffmpeg = instance;
            logger.info("FFmpeg loaded.");
            return instance;
        } catch (error) {
            instance.terminate();
            ffmpeg = null;
            throw error;
        } finally {
            URL.revokeObjectURL(classWorkerURL);
            ffmpegLoading = null;
        }
    })();

    return ffmpegLoading;
}

/** Whether the ffmpeg.wasm core is already loaded (no network needed). */
export function isFFmpegLoaded(): boolean {
    return ffmpeg?.loaded ?? false;
}

/** Kill the worker — used to abort an in-flight export. Next call reloads. */
export function terminateFFmpeg(): void {
    try { ffmpeg?.terminate(); } catch { /* ignore */ }
    ffmpeg = null;
    ffmpegLoading = null;
}

/* ========================================================================== */
/*                                  Trim                                      */
/* ========================================================================== */

export type TrimMode = "precise" | "lossless";

export interface FfmpegTrimOptions {
    /** "precise" re-encodes (frame-accurate); "lossless" stream-copies. */
    mode: TrimMode;
    /** x264 CRF for precise mode (lower = higher quality). */
    crf: number;
    onProgress?: (fraction: number) => void;
    signal?: { cancelled: boolean; };
}

function extOf(name: string): string {
    return name.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? ".mp4";
}

/**
 * Trim `[startTime, endTime]` out of `file` with ffmpeg.wasm.
 *
 * - **precise**: `-ss` (accurate seek) + libx264/aac → frame-accurate mp4.
 * - **lossless**: `-c copy` → instant, no quality loss, keeps the container,
 *   but the in-point snaps to the nearest preceding keyframe.
 */
export async function trimWithFFmpeg(
    file: File,
    startTime: number,
    endTime: number,
    options: FfmpegTrimOptions
): Promise<File> {
    const ff = await loadFFmpeg();
    const id = counter++;
    const ext = extOf(file.name);
    const input = `clipify_in_${id}${ext}`;
    const duration = Math.max(0.001, endTime - startTime);

    const onProgress = ({ progress }: { progress: number; }) => options.onProgress?.(clamp(progress, 0, 1));
    ff.on("progress", onProgress);

    const lossless = options.mode === "lossless";
    const output = lossless ? `clipify_out_${id}${ext}` : `clipify_out_${id}.mp4`;
    const args = lossless
        ? [
            "-ss", String(startTime),
            "-i", input,
            "-t", String(duration),
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+faststart",
            output
        ]
        : [
            "-ss", String(startTime),
            "-i", input,
            "-t", String(duration),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", String(options.crf),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "128k",
            "-movflags", "+faststart",
            output
        ];

    try {
        await ff.writeFile(input, new Uint8Array(await file.arrayBuffer()));

        const exitCode = await ff.exec(args);
        if (options.signal?.cancelled) throw new Error("Export cancelled.");
        if (exitCode !== 0) throw new Error("FFmpeg failed to trim the video.");

        const data = await ff.readFile(output);
        if (typeof data === "string") throw new Error("Could not read the trimmed video.");

        options.onProgress?.(1);
        const outType = lossless ? (file.type || "video/mp4") : "video/mp4";
        const outName = `${baseName(file.name)}${lossless ? ext : ".mp4"}`;
        return new File([new Uint8Array(data as Uint8Array)], outName, { type: outType });
    } finally {
        ff.off("progress", onProgress);
        ff.deleteFile(input).catch(() => undefined);
        ff.deleteFile(output).catch(() => undefined);
    }
}
