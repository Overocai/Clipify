/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, showToast, Toasts, useCallback, useEffect, useRef, useState } from "@webpack/common";

import { CensorMark, CensorStyle, exportImage, loadImage, OutputFormat, Point, Rect, renderPreview } from "./image";
import { LayoutSwitch } from "./Layout";
import { Slider } from "./Slider";
import { clamp, LayoutMode, logger } from "./utils";

const cl = classNameFactory("vc-clipify-");

/** Cap the preview canvas buffer so blur/pixelate stay fast on huge images. */
const MAX_PREVIEW = 1280;
/** Minimum drag (natural px) before a gesture counts as a rectangle, not a click. */
const MIN_RECT = 6;

type Tool = "crop" | "resize" | "censor";
type CensorShape = "box" | "brush";

export interface ImageEditorModalProps {
    modalProps: RenderModalProps;
    file: File;
    defaultLayout: LayoutMode;
    onComplete: (edited: File) => void;
}

const FORMATS: ReadonlyArray<[OutputFormat, string]> = [
    ["auto", "Auto"], ["png", "PNG"], ["jpeg", "JPEG"], ["webp", "WebP"]
];
const SCALE_PRESETS = [25, 50, 100] as const;

/** Normalise a drag (which may go up/left) into a positive rect, clamped to bounds. */
function normalizeRect(ax: number, ay: number, bx: number, by: number, maxW: number, maxH: number): Rect {
    const x = clamp(Math.min(ax, bx), 0, maxW);
    const y = clamp(Math.min(ay, by), 0, maxH);
    const w = clamp(Math.max(ax, bx), 0, maxW) - x;
    const h = clamp(Math.max(ay, by), 0, maxH) - y;
    return { x, y, w, h };
}

const Icon = ({ d, ...rest }: { d: string; } & React.SVGProps<SVGSVGElement>) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" {...rest}>
        <path d={d} />
    </svg>
);

const ICONS = {
    crop: "M7 1v4H3v2h4v10a2 2 0 0 0 2 2h10v4h2v-4h4v-2h-4V7a2 2 0 0 0-2-2H9V1H7zm2 6h8v8h-2V9H9V7z",
    resize: "M3 3h8v2H5v6H3V3zm18 18h-8v-2h6v-6h2v8z",
    censor: "M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5C21.3 7.6 17 4.5 12 4.5zm0 12a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z",
    trash: "M6 7h12l-1 14H7L6 7zm3-3h6l1 2H8l1-2z",
    undo: "M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"
};

function ImageEditorInner({ modalProps, file, defaultLayout, onComplete }: ImageEditorModalProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);

    const [img, setImg] = useState<HTMLImageElement | null>(null);
    const [tool, setTool] = useState<Tool>("crop");

    const [crop, setCrop] = useState<Rect | null>(null);
    const [marks, setMarks] = useState<CensorMark[]>([]);
    const [style, setStyle] = useState<CensorStyle>("blur");
    const [intensity, setIntensity] = useState(60);
    const [shape, setShape] = useState<CensorShape>("box");
    const [brushSize, setBrushSize] = useState(24);
    const [resize, setResize] = useState<{ w: number; h: number; } | null>(null);
    const [aspectLock, setAspectLock] = useState(true);

    const [layout, setLayout] = useState<LayoutMode>(defaultLayout);
    const [format, setFormat] = useState<OutputFormat>("auto");
    const [quality, setQuality] = useState(92);

    const [drag, setDrag] = useState<Rect | null>(null);
    const [draftStroke, setDraftStroke] = useState<Point[] | null>(null);
    const [exporting, setExporting] = useState(false);

    const natW = img?.naturalWidth ?? 0;
    const natH = img?.naturalHeight ?? 0;
    const maxBrush = Math.max(20, Math.round(Math.min(natW || 100, natH || 100) * 0.25));
    const mod = layout !== "simple";
    const adv = layout === "advanced";

    // Simple mode keeps censoring to the basics (blur boxes only).
    useEffect(() => {
        if (layout === "simple") {
            setStyle("blur");
            setShape("box");
        }
    }, [layout]);

    // Load the image once, seeding a sensible brush size from its dimensions.
    useEffect(() => {
        let revoke: string | null = null;
        let alive = true;
        loadImage(file)
            .then(({ img, url }) => {
                revoke = url;
                if (!alive) { URL.revokeObjectURL(url); return; }
                setImg(img);
                setBrushSize(Math.max(8, Math.round(Math.min(img.naturalWidth, img.naturalHeight) * 0.05)));
            })
            .catch(err => {
                logger.error("Failed to load image", err);
                showToast("Clipify: couldn't load this image.", Toasts.Type.FAILURE);
                modalProps.onClose();
            });
        return () => {
            alive = false;
            if (revoke) URL.revokeObjectURL(revoke);
        };
    }, [file]);

    // Re-render the preview whenever the censor inputs change (including the
    // in-progress brush stroke, so painting shows up live).
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !img) return;
        const scale = Math.min(1, MAX_PREVIEW / Math.max(natW, natH));
        const renderMarks: CensorMark[] = draftStroke && draftStroke.length
            ? [...marks, { type: "brush", points: draftStroke, radius: brushSize }]
            : marks;
        renderPreview(canvas, img, renderMarks, { style, intensity }, scale);
    }, [img, marks, style, intensity, natW, natH, draftStroke, brushSize]);

    // Entering the resize tool seeds the output size from the current crop.
    useEffect(() => {
        if (tool !== "resize" || !img) return;
        setResize(prev => prev ?? { w: Math.round(crop?.w ?? natW), h: Math.round(crop?.h ?? natH) });
    }, [tool, img]);

    const toNatural = useCallback((clientX: number, clientY: number): Point => {
        const el = canvasRef.current;
        if (!el) return { x: 0, y: 0 };
        const rect = el.getBoundingClientRect();
        const xr = clamp((clientX - rect.left) / rect.width, 0, 1);
        const yr = clamp((clientY - rect.top) / rect.height, 0, 1);
        return { x: xr * natW, y: yr * natH };
    }, [natW, natH]);

    const dragOrigin = useRef<Point | null>(null);
    const isBrush = tool === "censor" && shape === "brush";

    const onPointerDown = (e: React.PointerEvent) => {
        if (exporting || tool === "resize") return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const p = toNatural(e.clientX, e.clientY);
        if (isBrush) {
            setDraftStroke([p]);
            return;
        }
        dragOrigin.current = p;
        setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
    };

    const onPointerMove = (e: React.PointerEvent) => {
        const p = toNatural(e.clientX, e.clientY);
        if (draftStroke) {
            setDraftStroke(prev => (prev ? [...prev, p] : [p]));
            return;
        }
        if (!dragOrigin.current) return;
        const o = dragOrigin.current;
        setDrag(normalizeRect(o.x, o.y, p.x, p.y, natW, natH));
    };

    const onPointerUp = (e: React.PointerEvent) => {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
        const p = toNatural(e.clientX, e.clientY);

        // Brush stroke → commit as a brush mark.
        if (draftStroke) {
            const points = [...draftStroke, p];
            setDraftStroke(null);
            setMarks(prev => [...prev, { type: "brush", points, radius: brushSize }]);
            return;
        }

        const o = dragOrigin.current;
        dragOrigin.current = null;
        setDrag(null);
        if (!o) return;

        const rect = normalizeRect(o.x, o.y, p.x, p.y, natW, natH);
        // Too small → treat as a click, not a rectangle.
        if (rect.w < MIN_RECT || rect.h < MIN_RECT) return;

        if (tool === "crop") setCrop(rect);
        else if (tool === "censor") setMarks(prev => [...prev, { type: "rect", ...rect }]);
    };

    const removeMark = (i: number) => setMarks(prev => prev.filter((_, idx) => idx !== i));
    const undoMark = () => setMarks(prev => prev.slice(0, -1));

    const aspect = (crop?.w ?? natW) / ((crop?.h ?? natH) || 1);

    const onResizeW = (value: number) => {
        const w = clamp(Math.round(value) || 1, 1, 10000);
        setResize(aspectLock ? { w, h: Math.max(1, Math.round(w / aspect)) } : { w, h: resize?.h ?? Math.round(crop?.h ?? natH) });
    };
    const onResizeH = (value: number) => {
        const h = clamp(Math.round(value) || 1, 1, 10000);
        setResize(aspectLock ? { w: Math.max(1, Math.round(h * aspect)), h } : { w: resize?.w ?? Math.round(crop?.w ?? natW), h });
    };

    // Helpers for the overlay rectangles, expressed as percentages of the image.
    const pctStyle = (r: Rect): React.CSSProperties => ({
        left: `${(r.x / natW) * 100}%`,
        top: `${(r.y / natH) * 100}%`,
        width: `${(r.w / natW) * 100}%`,
        height: `${(r.h / natH) * 100}%`
    });

    const handleExport = useCallback(async () => {
        if (exporting || !img) return;
        setExporting(true);
        try {
            const edited = await exportImage(file, img, {
                marks, crop, resize, style, intensity,
                format: adv ? format : "auto",
                quality: quality / 100
            });
            onComplete(edited);
            showToast("Image edited and added to your message!", Toasts.Type.SUCCESS);
            modalProps.onClose();
        } catch (err) {
            showToast(`Edit failed: ${err instanceof Error ? err.message : String(err)}`, Toasts.Type.FAILURE);
            setExporting(false);
        }
    }, [exporting, img, file, marks, crop, resize, style, intensity, adv, format, quality, onComplete, modalProps]);

    const cropW = Math.round(crop?.w ?? natW);
    const cropH = Math.round(crop?.h ?? natH);
    const outW = resize?.w ?? cropW;
    const outH = resize?.h ?? cropH;

    const applyScalePreset = (pct: number) => setResize({ w: Math.max(1, Math.round(cropW * pct / 100)), h: Math.max(1, Math.round(cropH * pct / 100)) });
    const lossyFormat = adv && (format === "jpeg" || format === "webp" || (format === "auto" && /jpe?g|webp/i.test(file.type)));

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Image editor"
            actions={[
                { text: "Apply & send", variant: "primary", onClick: handleExport, loading: exporting, disabled: exporting || !img },
                { text: "Cancel", variant: "secondary", onClick: () => modalProps.onClose(), disabled: exporting }
            ]}
        >
            <div className={cl("editor")}>
                <LayoutSwitch value={layout} onChange={setLayout} />

                <div className={cl("tools")}>
                    <button className={cl("tool", { "tool-active": tool === "crop" })} onClick={() => setTool("crop")}>
                        <Icon d={ICONS.crop} /> Crop
                    </button>
                    <button className={cl("tool", { "tool-active": tool === "resize" })} onClick={() => setTool("resize")}>
                        <Icon d={ICONS.resize} /> Resize
                    </button>
                    <button className={cl("tool", { "tool-active": tool === "censor" })} onClick={() => setTool("censor")}>
                        <Icon d={ICONS.censor} /> Censor
                    </button>
                </div>

                <div className={cl("img-stage")} ref={stageRef}>
                    <div className={cl("img-canvas-wrap")}>
                        <canvas ref={canvasRef} className={cl("img-canvas")} />
                        <div
                            className={cl("img-overlay", { "img-overlay-draw": tool !== "resize" && !exporting })}
                            onPointerDown={onPointerDown}
                            onPointerMove={onPointerMove}
                            onPointerUp={onPointerUp}
                        >
                            {/* Crop selection with darkened surroundings. */}
                            {crop && <div className={cl("crop-rect")} style={pctStyle(crop)} />}

                            {/* Rectangle censor marks get an outline + delete button. Brush
                                strokes are shown directly on the canvas. */}
                            {marks.map((m, i) => (m.type === "rect" ? (
                                <div key={i} className={cl("region-rect")} style={pctStyle(m)}>
                                    {tool === "censor" && !exporting && (
                                        <button
                                            className={cl("region-del")}
                                            title="Remove region"
                                            onPointerDown={e => { e.stopPropagation(); e.preventDefault(); }}
                                            onClick={e => { e.stopPropagation(); removeMark(i); }}
                                        >
                                            <Icon d={ICONS.trash} width="14" height="14" />
                                        </button>
                                    )}
                                </div>
                            ) : null))}

                            {/* Live box-drag rectangle. */}
                            {drag && (
                                <div className={cl(tool === "crop" ? "crop-rect" : "region-rect", "rect-live")} style={pctStyle(drag)} />
                            )}
                        </div>
                    </div>
                    {exporting && (
                        <div className={cl("overlay")}>
                            <div className={cl("overlay-label")}>Rendering image…</div>
                        </div>
                    )}
                </div>

                {/* Tool-specific controls. */}
                {tool === "crop" && (
                    <div className={cl("img-controls")}>
                        <div className={cl("img-hint")}>Drag on the image to select the area to keep.</div>
                        <button className={cl("setbtn")} disabled={!crop} onClick={() => setCrop(null)}>Reset crop</button>
                    </div>
                )}

                {tool === "resize" && (
                    <div className={cl("img-controls")}>
                        <label className={cl("fps")}>
                            W
                            <input type="number" min={1} value={outW} onChange={e => onResizeW(Number(e.target.value))} />
                        </label>
                        <label className={cl("fps")}>
                            H
                            <input type="number" min={1} value={outH} onChange={e => onResizeH(Number(e.target.value))} />
                        </label>
                        <label className={cl("img-check")}>
                            <input type="checkbox" checked={aspectLock} onChange={e => setAspectLock(e.target.checked)} />
                            Lock ratio
                        </label>
                        {adv && (
                            <div className={cl("modes")} title="Scale to a percentage of the crop">
                                {SCALE_PRESETS.map(p => (
                                    <button key={p} className={cl("mode")} onClick={() => applyScalePreset(p)}>{p}%</button>
                                ))}
                            </div>
                        )}
                        <button className={cl("setbtn")} onClick={() => setResize({ w: cropW, h: cropH })}>Reset</button>
                    </div>
                )}

                {tool === "censor" && (
                    <div className={cl("img-controls")}>
                        <div className={cl("modes")}>
                            <button className={cl("mode", { "mode-active": style === "blur" })} onClick={() => setStyle("blur")}>Blur</button>
                            {mod && <button className={cl("mode", { "mode-active": style === "pixelate" })} onClick={() => setStyle("pixelate")}>Pixelate</button>}
                        </div>
                        {mod && (
                            <div className={cl("modes")}>
                                <button className={cl("mode", { "mode-active": shape === "box" })} onClick={() => setShape("box")}>Box</button>
                                <button className={cl("mode", { "mode-active": shape === "brush" })} onClick={() => setShape("brush")}>Brush</button>
                            </div>
                        )}
                        <Slider label="Intensity" min={0} max={100} value={intensity} onChange={setIntensity} />
                        {mod && shape === "brush" && (
                            <Slider label="Brush" min={4} max={maxBrush} value={Math.min(brushSize, maxBrush)} onChange={setBrushSize} display={brushSize} />
                        )}
                        {mod && (
                            <button className={cl("iconbtn", "iconbtn-sm")} title="Undo last mark" disabled={marks.length === 0} onClick={undoMark}>
                                <Icon d={ICONS.undo} />
                            </button>
                        )}
                        <button className={cl("setbtn")} disabled={marks.length === 0} onClick={() => setMarks([])}>Clear all</button>
                    </div>
                )}

                {tool === "censor" && (
                    <div className={cl("img-hint")} style={{ textAlign: "center" }}>
                        {shape === "box" ? "Drag boxes over anything you want to hide." : "Paint over anything you want to hide."}
                    </div>
                )}

                {adv && (
                    <div className={cl("img-controls")}>
                        <span className={cl("layout-label")}>Output</span>
                        <div className={cl("modes")}>
                            {FORMATS.map(([f, label]) => (
                                <button key={f} className={cl("mode", { "mode-active": format === f })} onClick={() => setFormat(f)}>{label}</button>
                            ))}
                        </div>
                        {lossyFormat && (
                            <Slider label="Quality" min={10} max={100} value={quality} onChange={setQuality} />
                        )}
                    </div>
                )}

                <div className={cl("img-info")}>
                    Original {natW}×{natH} · Output {outW}×{outH}{crop ? " (cropped)" : ""} · {marks.length} censor mark{marks.length === 1 ? "" : "s"}
                </div>
            </div>
        </Modal>
    );
}

export const ImageEditorModal = ErrorBoundary.wrap(ImageEditorInner, { noop: true });
