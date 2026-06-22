/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { baseName, clamp } from "./utils";

/* ========================================================================== */
/*                                  Types                                     */
/* ========================================================================== */

/** A rectangle in the image's natural pixel coordinates. */
export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Censorship effect applied to every mark. */
export type CensorStyle = "blur" | "pixelate";

/** A point in natural pixel coordinates. */
export interface Point {
    x: number;
    y: number;
}

/** A rectangular censor area (drag a box). */
export interface RectMark extends Rect {
    type: "rect";
}

/** A free-hand censor stroke (paint with the brush) — a polyline with thickness. */
export interface BrushMark {
    type: "brush";
    points: Point[];
    /** Stroke radius in natural pixels. */
    radius: number;
}

/** Anything the user can paint to censor. */
export type CensorMark = RectMark | BrushMark;

/** The censor look shared by all marks — a single global level, as set by the slider. */
export interface CensorSettings {
    style: CensorStyle;
    /** 0–100 intensity. */
    intensity: number;
}

/** Output format; "auto" keeps the source format. */
export type OutputFormat = "auto" | "png" | "jpeg" | "webp";

export interface RenderOptions extends CensorSettings {
    /** Censor marks to bake in (natural coordinates). */
    marks: readonly CensorMark[];
    /** Crop applied to the output, in natural coordinates. `null` = full image. */
    crop: Rect | null;
    /** Output size; defaults to the crop (or natural) size. */
    resize: { w: number; h: number; } | null;
    /** Output format override (advanced); defaults to "auto". */
    format?: OutputFormat;
    /** Encoder quality 0–1 for lossy formats (jpeg/webp); defaults to 0.92. */
    quality?: number;
}

/* ========================================================================== */
/*                                  Loading                                   */
/* ========================================================================== */

/** Decode a {@link File} into an `HTMLImageElement` (resolves once loaded). */
export function loadImage(file: File): Promise<{ img: HTMLImageElement; url: string; }> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => resolve({ img, url });
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Could not load the image."));
        };
        img.src = url;
    });
}

/* ========================================================================== */
/*                             Intensity mapping                              */
/* ========================================================================== */

/**
 * Map the 0–100 intensity slider to a blur radius / mosaic block size in
 * pixels, scaled to the image so the effect feels consistent regardless of
 * resolution. `scale` lets the same maths drive both the on-screen preview
 * (display scale) and the full-resolution export (scale = 1).
 */
export function blurRadiusFor(intensity: number, minDim: number, scale = 1): number {
    return Math.max(1, (clamp(intensity, 0, 100) / 100) * 0.08 * minDim * scale);
}

export function blockSizeFor(intensity: number, minDim: number, scale = 1): number {
    return Math.max(2, Math.round((clamp(intensity, 0, 100) / 100) * 0.06 * minDim * scale));
}

/* ========================================================================== */
/*                                 Censoring                                  */
/* ========================================================================== */

/** Build a canvas holding the whole image with the censor effect applied to every pixel. */
function buildEffectCanvas(
    img: CanvasImageSource,
    natW: number,
    natH: number,
    settings: CensorSettings,
    scale: number
): HTMLCanvasElement {
    const w = Math.max(1, Math.round(natW * scale));
    const h = Math.max(1, Math.round(natH * scale));
    const minDim = Math.min(natW, natH);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;

    if (settings.style === "blur") {
        ctx.filter = `blur(${blurRadiusFor(settings.intensity, minDim, scale)}px)`;
        ctx.drawImage(img, 0, 0, w, h);
        ctx.filter = "none";
    } else {
        // Mosaic: downsample the whole image, then scale it back up with
        // smoothing disabled to get hard pixel blocks.
        const block = blockSizeFor(settings.intensity, minDim, scale);
        const smallW = Math.max(1, Math.round(w / block));
        const smallH = Math.max(1, Math.round(h / block));
        const tmp = document.createElement("canvas");
        tmp.width = smallW;
        tmp.height = smallH;
        const tctx = tmp.getContext("2d")!;
        tctx.imageSmoothingEnabled = false;
        tctx.drawImage(img, 0, 0, smallW, smallH);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, smallW, smallH, 0, 0, w, h);
    }
    return canvas;
}

/** Build an alpha mask (white where censored) from the marks. */
function buildMaskCanvas(marks: readonly CensorMark[], w: number, h: number, scale: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";

    for (const mark of marks) {
        if (mark.type === "rect") {
            ctx.fillRect(mark.x * scale, mark.y * scale, mark.w * scale, mark.h * scale);
        } else {
            const r = Math.max(1, mark.radius * scale);
            const pts = mark.points;
            if (pts.length === 1) {
                // A single dab — fill a dot.
                ctx.beginPath();
                ctx.arc(pts[0].x * scale, pts[0].y * scale, r, 0, Math.PI * 2);
                ctx.fill();
            } else {
                // Stroke the polyline with round caps/joins for a continuous brush.
                ctx.lineWidth = r * 2;
                ctx.lineCap = "round";
                ctx.lineJoin = "round";
                ctx.beginPath();
                pts.forEach((p, i) => (i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
                ctx.stroke();
            }
        }
    }
    return canvas;
}

/**
 * Bake every censor mark onto `ctx` at the given `scale`. The effect is rendered
 * once over the whole image, then masked to the union of all marks — so boxes
 * and free-hand brush strokes composite cleanly, even where they overlap.
 */
function applyCensor(
    ctx: CanvasRenderingContext2D,
    img: CanvasImageSource,
    natW: number,
    natH: number,
    marks: readonly CensorMark[],
    settings: CensorSettings,
    scale: number
): void {
    if (marks.length === 0) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    const effect = buildEffectCanvas(img, natW, natH, settings, scale);
    const mask = buildMaskCanvas(marks, w, h, scale);

    // Keep only the censored pixels that fall inside the mask…
    const ectx = effect.getContext("2d")!;
    ectx.globalCompositeOperation = "destination-in";
    ectx.drawImage(mask, 0, 0);
    ectx.globalCompositeOperation = "source-over";

    // …then stamp them over the base image.
    ctx.drawImage(effect, 0, 0);
}

/**
 * Render the full (uncropped) image plus baked-in censor marks onto `canvas`
 * at the given `scale`. Used for the live preview (display scale) — the export
 * path reuses {@link applyCensor} at scale = 1.
 */
export function renderPreview(
    canvas: HTMLCanvasElement,
    img: HTMLImageElement,
    marks: readonly CensorMark[],
    settings: CensorSettings,
    scale: number
): void {
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    canvas.width = Math.max(1, Math.round(natW * scale));
    canvas.height = Math.max(1, Math.round(natH * scale));

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    applyCensor(ctx, img, natW, natH, marks, settings, scale);
}

/* ========================================================================== */
/*                                  Export                                    */
/* ========================================================================== */

const FORMAT_TYPE: Record<Exclude<OutputFormat, "auto">, { type: string; ext: string; }> = {
    png: { type: "image/png", ext: ".png" },
    webp: { type: "image/webp", ext: ".webp" },
    jpeg: { type: "image/jpeg", ext: ".jpg" }
};

/** Choose an output MIME type from an explicit format, else from the source. */
function outputType(file: File, format: OutputFormat = "auto"): { type: string; ext: string; } {
    if (format !== "auto") return FORMAT_TYPE[format];

    const t = file.type;
    if (t === "image/png") return FORMAT_TYPE.png;
    if (t === "image/webp") return FORMAT_TYPE.webp;
    if (t === "image/jpeg") return FORMAT_TYPE.jpeg;

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "png") return FORMAT_TYPE.png;
    if (ext === "webp") return FORMAT_TYPE.webp;
    if (ext === "jpg" || ext === "jpeg") return FORMAT_TYPE.jpeg;
    // Fall back to PNG — lossless and universally supported by canvas.
    return FORMAT_TYPE.png;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error("Could not export the image."))), type, quality);
    });
}

/**
 * Bake the edits (censor → crop → resize) into a new image {@link File}. Runs
 * entirely on a canvas; no network and no ffmpeg.
 */
export async function exportImage(file: File, img: HTMLImageElement, opts: RenderOptions): Promise<File> {
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;

    // 1. Full-resolution composite with censor regions baked in.
    const full = document.createElement("canvas");
    full.width = natW;
    full.height = natH;
    const fctx = full.getContext("2d")!;
    fctx.drawImage(img, 0, 0);
    applyCensor(fctx, img, natW, natH, opts.marks, opts, 1);

    // 2. Crop.
    const crop = opts.crop ?? { x: 0, y: 0, w: natW, h: natH };
    const cropW = Math.max(1, Math.round(crop.w));
    const cropH = Math.max(1, Math.round(crop.h));

    // 3. Final output size (resize, defaulting to the crop size).
    const outW = Math.max(1, Math.round(opts.resize?.w ?? cropW));
    const outH = Math.max(1, Math.round(opts.resize?.h ?? cropH));

    const out = document.createElement("canvas");
    out.width = outW;
    out.height = outH;
    const octx = out.getContext("2d")!;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(full, crop.x, crop.y, cropW, cropH, 0, 0, outW, outH);

    const { type, ext } = outputType(file, opts.format);
    const blob = await canvasToBlob(out, type, opts.quality ?? 0.92);
    return new File([blob], `${baseName(file.name)}${ext}`, { type });
}
