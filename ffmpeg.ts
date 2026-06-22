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
    /** Extra `-vf` filters (e.g. crop / eq). Forces a re-encode when present. */
    videoFilters?: string[];
    /** Extra `-af` filters (e.g. volume boost). Forces a re-encode when present. */
    audioFilters?: string[];
    /** Playback speed multiplier (1 = unchanged). Forces a re-encode when ≠ 1. */
    speed?: number;
    onProgress?: (fraction: number) => void;
    signal?: { cancelled: boolean; };
}

function extOf(name: string): string {
    return name.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? ".mp4";
}

/**
 * Decompose a speed factor into a chain of `atempo` filters, each within
 * ffmpeg's supported [0.5, 2.0] range (e.g. 5× → atempo=2,2,1.25).
 */
function buildAtempo(speed: number): string[] {
    const parts: number[] = [];
    let r = speed;
    while (r > 2) { parts.push(2); r /= 2; }
    while (r < 0.5) { parts.push(0.5); r /= 0.5; }
    parts.push(r);
    return parts.map(p => `atempo=${p.toFixed(4)}`);
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

    const speed = options.speed ?? 1;
    const speedChanged = Math.abs(speed - 1) > 0.001;

    const vf = [...(options.videoFilters?.filter(Boolean) ?? [])];
    const af = [...(options.audioFilters?.filter(Boolean) ?? [])];
    if (speedChanged) {
        vf.push(`setpts=${(1 / speed).toFixed(6)}*PTS`);
        af.push(...buildAtempo(speed));
    }
    const hasFilters = vf.length > 0 || af.length > 0;
    // Filters can't be applied to a stream copy, so any effect forces a re-encode.
    const lossless = options.mode === "lossless" && !hasFilters;
    // Speeding up/slowing down changes the output length; cap by the resulting duration.
    const outDur = speedChanged ? duration / speed : duration;
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
            "-t", String(outDur),
            ...(vf.length ? ["-vf", vf.join(",")] : []),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", String(options.crf),
            "-pix_fmt", "yuv420p",
            ...(af.length ? ["-af", af.join(",")] : []),
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

/* ========================================================================== */
/*                               Audio trim                                   */
/* ========================================================================== */

export interface FfmpegAudioTrimOptions {
    /** "precise" re-encodes to AAC/m4a; "lossless" stream-copies the source. */
    mode: TrimMode;
    /** Output AAC bitrate in kbps for "precise" mode (default 192). */
    bitrateK?: number;
    /** Volume multiplier (1 = unchanged). Any boost forces a re-encode. */
    gain?: number;
    onProgress?: (fraction: number) => void;
    signal?: { cancelled: boolean; };
}

/**
 * Trim `[startTime, endTime]` out of an audio `file` with ffmpeg.wasm.
 *
 * - **lossless**: `-c copy` → instant, keeps the original codec/container.
 * - **precise**: re-encodes with FFmpeg's built-in AAC encoder (always
 *   compiled in, unlike libmp3lame) → `.m4a`.
 */
export async function trimAudioWithFFmpeg(
    file: File,
    startTime: number,
    endTime: number,
    options: FfmpegAudioTrimOptions
): Promise<File> {
    const ff = await loadFFmpeg();
    const id = counter++;
    const ext = extOf(file.name);
    const input = `clipify_ain_${id}${ext}`;
    const duration = Math.max(0.001, endTime - startTime);

    const onProgress = ({ progress }: { progress: number; }) => options.onProgress?.(clamp(progress, 0, 1));
    ff.on("progress", onProgress);

    const gain = options.gain ?? 1;
    const hasGain = Math.abs(gain - 1) > 0.001;
    // A volume change can't be stream-copied, so it forces a re-encode.
    const lossless = options.mode === "lossless" && !hasGain;
    const output = lossless ? `clipify_aout_${id}${ext}` : `clipify_aout_${id}.m4a`;
    const args = lossless
        ? [
            "-ss", String(startTime),
            "-i", input,
            "-t", String(duration),
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
            output
        ]
        : [
            "-ss", String(startTime),
            "-i", input,
            "-t", String(duration),
            "-vn",
            ...(hasGain ? ["-af", `volume=${gain}`] : []),
            "-c:a", "aac",
            "-b:a", `${Math.round(options.bitrateK ?? 192)}k`,
            "-movflags", "+faststart",
            output
        ];

    try {
        await ff.writeFile(input, new Uint8Array(await file.arrayBuffer()));

        const exitCode = await ff.exec(args);
        if (options.signal?.cancelled) throw new Error("Export cancelled.");
        if (exitCode !== 0) throw new Error("FFmpeg failed to trim the audio.");

        const data = await ff.readFile(output);
        if (typeof data === "string") throw new Error("Could not read the trimmed audio.");

        options.onProgress?.(1);
        const outType = lossless ? (file.type || "audio/mpeg") : "audio/mp4";
        const outName = `${baseName(file.name)}${lossless ? ext : ".m4a"}`;
        return new File([new Uint8Array(data as Uint8Array)], outName, { type: outType });
    } finally {
        ff.off("progress", onProgress);
        ff.deleteFile(input).catch(() => undefined);
        ff.deleteFile(output).catch(() => undefined);
    }
}
