/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, showToast, Toasts, useCallback, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { terminateFFmpeg, TrimMode, trimWithFFmpeg } from "./ffmpeg";
import { LayoutSwitch } from "./Layout";
import { clamp, Engine, ExportQuality, exportTrimmedVideo, formatTimecode, LayoutMode, qualityToCrf } from "./utils";

const cl = classNameFactory("vc-clipify-");

/* Minimum trimmable selection length, in seconds. */
const MIN_SELECTION = 0.05;

export interface TrimEditorModalProps {
    modalProps: RenderModalProps;
    file: File;
    defaultFps: number;
    quality: ExportQuality;
    engine: Engine;
    defaultMode: TrimMode;
    defaultLayout: LayoutMode;
    /** Called with the finished, trimmed file once the user exports. */
    onComplete: (trimmed: File) => void;
}

const SPEEDS = [0.5, 1, 2] as const;
const QUALITIES: ReadonlyArray<[ExportQuality, string]> = [["high", "High"], ["medium", "Medium"], ["low", "Low"]];

/* ----------------------------- Timeline --------------------------------- */

type DragKind = "start" | "end" | "scrub";

interface TimelineProps {
    duration: number;
    start: number;
    end: number;
    current: number;
    onScrub: (t: number) => void;
    onChangeStart: (t: number) => void;
    onChangeEnd: (t: number) => void;
}

function Timeline({ duration, start, end, current, onScrub, onChangeStart, onChangeEnd }: TimelineProps) {
    const trackRef = useRef<HTMLDivElement>(null);
    const [drag, setDrag] = useState<DragKind | null>(null);

    const pct = (t: number) => (duration > 0 ? clamp(t / duration, 0, 1) * 100 : 0);

    const posToTime = useCallback((clientX: number): number => {
        const el = trackRef.current;
        if (!el || duration <= 0) return 0;
        const rect = el.getBoundingClientRect();
        const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
        return ratio * duration;
    }, [duration]);

    const handlers = (kind: DragKind) => ({
        onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            setDrag(kind);
            apply(kind, posToTime(e.clientX));
        },
        onPointerMove: (e: React.PointerEvent) => {
            if (drag !== kind) return;
            apply(kind, posToTime(e.clientX));
        },
        onPointerUp: (e: React.PointerEvent) => {
            (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
            setDrag(null);
        }
    });

    const apply = (kind: DragKind, t: number) => {
        if (kind === "start") onChangeStart(clamp(t, 0, end - MIN_SELECTION));
        else if (kind === "end") onChangeEnd(clamp(t, start + MIN_SELECTION, duration));
        else onScrub(clamp(t, 0, duration));
    };

    return (
        <div className={cl("timeline")} aria-label="Timeline">
            <div className={cl("timeline-track")} ref={trackRef} {...handlers("scrub")}>
                <div
                    className={cl("timeline-selection")}
                    style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
                />
            </div>

            <div
                className={cl("timeline-playhead")}
                style={{ left: `${pct(current)}%` }}
            />

            <div
                className={cl("timeline-handle", { "handle-active": drag === "start" })}
                style={{ left: `${pct(start)}%` }}
                role="slider"
                aria-label="Selection start"
                aria-valuenow={start}
                {...handlers("start")}
            />
            <div
                className={cl("timeline-handle", { "handle-active": drag === "end" })}
                style={{ left: `${pct(end)}%` }}
                role="slider"
                aria-label="Selection end"
                aria-valuenow={end}
                {...handlers("end")}
            />
        </div>
    );
}

/* ------------------------------ Icons ----------------------------------- */

const Icon = ({ d, ...rest }: { d: string; } & React.SVGProps<SVGSVGElement>) => (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" {...rest}>
        <path d={d} />
    </svg>
);

const ICONS = {
    play: "M8 5v14l11-7z",
    pause: "M6 5h4v14H6zm8 0h4v14h-4z",
    frameBack: "M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z",
    frameFwd: "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z",
    toStart: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
    toEnd: "M16 6h2v12h-2zM6 18l8.5-6L6 6z",
    chevLeft: "M14 7.4 9.4 12l4.6 4.6V7.4z",
    chevRight: "M10 7.4 14.6 12 10 16.6V7.4z"
};

/* --------------------------- Editor modal ------------------------------- */

function TrimEditorInner({ modalProps, file, defaultFps, quality: initialQuality, engine, defaultMode, defaultLayout, onComplete }: TrimEditorModalProps) {
    const url = useMemo(() => URL.createObjectURL(file), [file]);
    const videoRef = useRef<HTMLVideoElement>(null);
    const rafRef = useRef<number>(0);
    const signalRef = useRef<{ cancelled: boolean; }>({ cancelled: false });

    const [duration, setDuration] = useState(0);
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(0);
    const [current, setCurrent] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [fps, setFps] = useState(() => clamp(defaultFps, 1, 240));
    const [mode, setMode] = useState<TrimMode>(defaultMode);
    const [exporting, setExporting] = useState(false);
    const [progress, setProgress] = useState(0);

    const [layout, setLayout] = useState<LayoutMode>(defaultLayout);
    const [quality, setQuality] = useState<ExportQuality>(initialQuality);
    const [speed, setSpeed] = useState(1);
    const [muted, setMuted] = useState(false);
    const [dims, setDims] = useState<{ w: number; h: number; } | null>(null);

    const frame = 1 / fps;
    const useFFmpeg = engine === "ffmpeg";
    const mod = layout !== "simple";
    const adv = layout === "advanced";

    useEffect(() => () => {
        URL.revokeObjectURL(url);
        signalRef.current.cancelled = true;
        cancelAnimationFrame(rafRef.current);
    }, [url]);

    const onLoadedMetadata = () => {
        const v = videoRef.current;
        if (!v) return;
        const d = Number.isFinite(v.duration) ? v.duration : 0;
        setDuration(d);
        setEnd(d);
        setCurrent(0);
        if (v.videoWidth) setDims({ w: v.videoWidth, h: v.videoHeight });
    };

    // Apply advanced playback options (speed / mute) to the preview element.
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        v.playbackRate = speed;
        v.muted = muted;
    }, [speed, muted, playing]);

    /* Keep `current` in sync with the element while it plays, and loop the
       preview inside the [start, end] selection for a live preview. */
    useEffect(() => {
        if (!playing) return;
        const v = videoRef.current;
        if (!v) return;

        const tick = () => {
            if (!v) return;
            if (v.currentTime >= end) {
                v.currentTime = start;
            }
            setCurrent(v.currentTime);
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [playing, start, end]);

    const seek = useCallback((t: number) => {
        const v = videoRef.current;
        const clamped = clamp(t, 0, duration);
        if (v) v.currentTime = clamped;
        setCurrent(clamped);
    }, [duration]);

    const togglePlay = useCallback(() => {
        const v = videoRef.current;
        if (!v) return;
        if (playing) {
            v.pause();
            setPlaying(false);
        } else {
            if (v.currentTime < start || v.currentTime >= end) v.currentTime = start;
            v.play().then(() => setPlaying(true)).catch(() => { /* ignore */ });
        }
    }, [playing, start, end]);

    const pauseThen = useCallback((t: number) => {
        const v = videoRef.current;
        if (v && !v.paused) v.pause();
        setPlaying(false);
        seek(t);
    }, [seek]);

    // Read the live element time (not React state) so that held-key repeats and
    // rapid presses step exactly one frame each, even before the next re-render.
    const stepFrame = (frames: number) => {
        const v = videoRef.current;
        const base = v ? v.currentTime : current;
        pauseThen(base + frames * frame);
    };

    const setStartHere = () => {
        const next = clamp(current, 0, end - MIN_SELECTION);
        setStart(next);
    };
    const setEndHere = () => {
        const next = clamp(current, start + MIN_SELECTION, duration);
        setEnd(next);
    };

    const nudgeStart = (dir: number) => {
        setStart(prev => clamp(prev + dir * frame, 0, end - MIN_SELECTION));
        pauseThen(start + dir * frame);
    };
    const nudgeEnd = (dir: number) => {
        setEnd(prev => clamp(prev + dir * frame, start + MIN_SELECTION, duration));
        pauseThen(end + dir * frame);
    };

    const selectionLength = Math.max(0, end - start);

    const runExport = useCallback(async (): Promise<File> => {
        if (useFFmpeg) {
            try {
                return await trimWithFFmpeg(file, start, end, {
                    mode,
                    crf: qualityToCrf(quality),
                    signal: signalRef.current,
                    onProgress: setProgress
                });
            } catch (err) {
                if (signalRef.current.cancelled) throw err;
                // Network blocked / core failed to load → degrade gracefully.
                showToast("FFmpeg unavailable — falling back to MediaRecorder.", Toasts.Type.MESSAGE);
                setProgress(0);
            }
        }
        return exportTrimmedVideo(file, start, end, {
            quality,
            signal: signalRef.current,
            onProgress: setProgress
        });
    }, [useFFmpeg, file, start, end, mode, quality]);

    const handleExport = useCallback(async () => {
        if (exporting) return;
        const v = videoRef.current;
        if (v && !v.paused) v.pause();
        setPlaying(false);

        if (selectionLength < MIN_SELECTION) {
            showToast("Selection is too short to trim.", Toasts.Type.FAILURE);
            return;
        }

        signalRef.current = { cancelled: false };
        setExporting(true);
        setProgress(0);

        try {
            const trimmed = await runExport();
            onComplete(trimmed);
            showToast("Video trimmed and added to your message!", Toasts.Type.SUCCESS);
            modalProps.onClose();
        } catch (err) {
            if (!signalRef.current.cancelled) {
                showToast(`Trim failed: ${err instanceof Error ? err.message : String(err)}`, Toasts.Type.FAILURE);
            }
            setExporting(false);
        }
    }, [exporting, selectionLength, runExport, onComplete, modalProps]);

    const cancel = () => {
        signalRef.current.cancelled = true;
        if (useFFmpeg) terminateFFmpeg();
        modalProps.onClose();
    };

    // Keyboard shortcuts. The ref always holds the latest closure, so the
    // listener (attached once) never goes stale during playback re-renders.
    const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | undefined>(undefined);
    keyHandlerRef.current = (e: KeyboardEvent) => {
        if (exporting) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

        switch (e.key) {
            case "ArrowLeft": e.preventDefault(); stepFrame(e.shiftKey ? -10 : -1); break;
            case "ArrowRight": e.preventDefault(); stepFrame(e.shiftKey ? 10 : 1); break;
            case " ": e.preventDefault(); togglePlay(); break;
            case "i": case "I": e.preventDefault(); setStartHere(); break;
            case "o": case "O": e.preventDefault(); setEndHere(); break;
            case "Home": e.preventDefault(); pauseThen(start); break;
            case "End": e.preventDefault(); pauseThen(end); break;
        }
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => keyHandlerRef.current?.(e);
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
    }, []);

    return (
        <Modal
            {...modalProps}
            size="lg"
            title="Trim editor"
            actions={[
                { text: "Trim & send", variant: "primary", onClick: handleExport, loading: exporting, disabled: exporting || selectionLength < MIN_SELECTION },
                { text: "Cancel", variant: "secondary", onClick: cancel, disabled: exporting }
            ]}
        >
            <div className={cl("editor")}>
                <LayoutSwitch value={layout} onChange={setLayout} />

                <div className={cl("stage")}>
                    <video
                        ref={videoRef}
                        src={url}
                        playsInline
                        onLoadedMetadata={onLoadedMetadata}
                        onClick={togglePlay}
                        onEnded={() => setPlaying(false)}
                    />
                    {exporting && (
                        <div className={cl("overlay")}>
                            <div className={cl("overlay-label")}>Processing video… {Math.round(progress * 100)}%</div>
                            <div className={cl("overlay-bar")}>
                                <div className={cl("overlay-fill")} style={{ width: `${Math.round(progress * 100)}%` }} />
                            </div>
                            <div className={cl("overlay-hint")}>
                                {!useFFmpeg
                                    ? "Re-encoding in real time (MediaRecorder) — this takes about the length of the clip."
                                    : mode === "lossless"
                                        ? "Lossless cut — almost instant."
                                        : "Re-encoding with quality (FFmpeg) — much faster than real time."}
                            </div>
                        </div>
                    )}
                </div>

                <div className={cl("readouts")}>
                    <div className={cl("readout", { "readout-sel": true })}>
                        <span className={cl("readout-label")}>Start</span>
                        <span className={cl("readout-value")}>{formatTimecode(start)}</span>
                    </div>
                    <div className={cl("readout", { "readout-sel": true })}>
                        <span className={cl("readout-label")}>End</span>
                        <span className={cl("readout-value")}>{formatTimecode(end)}</span>
                    </div>
                    <div className={cl("readout")}>
                        <span className={cl("readout-label")}>Current</span>
                        <span className={cl("readout-value")}>{formatTimecode(current)}</span>
                    </div>
                    <div className={cl("readout")}>
                        <span className={cl("readout-label")}>Duration</span>
                        <span className={cl("readout-value")}>{formatTimecode(selectionLength)}</span>
                    </div>
                </div>

                {mod && (
                    <div className={cl("optbar")}>
                        {useFFmpeg ? (
                            <div className={cl("modes")}>
                                <button
                                    className={cl("mode", { "mode-active": mode === "precise" })}
                                    onClick={() => setMode("precise")}
                                    title="Cuts exactly at the chosen frame (re-encodes to mp4)"
                                >
                                    Precise
                                </button>
                                <button
                                    className={cl("mode", { "mode-active": mode === "lossless" })}
                                    onClick={() => setMode("lossless")}
                                    title="Instant and lossless; the start snaps to the nearest keyframe"
                                >
                                    Lossless
                                </button>
                            </div>
                        ) : <span />}

                        <label className={cl("fps")}>
                            FPS
                            <input
                                type="number"
                                min={1}
                                max={240}
                                value={fps}
                                onChange={e => setFps(clamp(Number(e.target.value) || defaultFps, 1, 240))}
                            />
                        </label>
                    </div>
                )}

                {adv && (
                    <div className={cl("img-controls")}>
                        <div className={cl("modes")}>
                            {QUALITIES.map(([q, label]) => (
                                <button key={q} className={cl("mode", { "mode-active": quality === q })} onClick={() => setQuality(q)} title="Output quality">
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div className={cl("modes")}>
                            {SPEEDS.map(s => (
                                <button key={s} className={cl("mode", { "mode-active": speed === s })} onClick={() => setSpeed(s)} title="Preview speed">
                                    {s}×
                                </button>
                            ))}
                        </div>
                        <label className={cl("img-check")}>
                            <input type="checkbox" checked={muted} onChange={e => setMuted(e.target.checked)} />
                            Mute preview
                        </label>
                    </div>
                )}

                <Timeline
                    duration={duration}
                    start={start}
                    end={end}
                    current={current}
                    onScrub={pauseThen}
                    onChangeStart={setStart}
                    onChangeEnd={setEnd}
                />

                <div className={cl("transport")}>
                    {mod && (
                        <button className={cl("iconbtn")} title="Jump to selection start" onClick={() => pauseThen(start)}>
                            <Icon d={ICONS.toStart} />
                        </button>
                    )}
                    {mod && (
                        <button className={cl("iconbtn")} title="Previous frame" onClick={() => stepFrame(-1)}>
                            <Icon d={ICONS.frameBack} />
                        </button>
                    )}
                    <button className={cl("iconbtn", { "iconbtn-primary": true })} title={playing ? "Pause" : "Play selection"} onClick={togglePlay}>
                        <Icon d={playing ? ICONS.pause : ICONS.play} />
                    </button>
                    {mod && (
                        <button className={cl("iconbtn")} title="Next frame" onClick={() => stepFrame(1)}>
                            <Icon d={ICONS.frameFwd} />
                        </button>
                    )}
                    {mod && (
                        <button className={cl("iconbtn")} title="Jump to selection end" onClick={() => pauseThen(end)}>
                            <Icon d={ICONS.toEnd} />
                        </button>
                    )}
                </div>

                {mod && (
                    <div className={cl("setbtns")}>
                        <div className={cl("setgroup")}>
                            <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge start back 1 frame" onClick={() => nudgeStart(-1)}>
                                <Icon d={ICONS.chevLeft} />
                            </button>
                            <button className={cl("setbtn")} title="Set start to current frame" onClick={setStartHere}>
                                Set start
                            </button>
                            <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge start forward 1 frame" onClick={() => nudgeStart(1)}>
                                <Icon d={ICONS.chevRight} />
                            </button>
                        </div>

                        <div className={cl("setgroup")}>
                            <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge end back 1 frame" onClick={() => nudgeEnd(-1)}>
                                <Icon d={ICONS.chevLeft} />
                            </button>
                            <button className={cl("setbtn")} title="Set end to current frame" onClick={setEndHere}>
                                Set end
                            </button>
                            <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge end forward 1 frame" onClick={() => nudgeEnd(1)}>
                                <Icon d={ICONS.chevRight} />
                            </button>
                        </div>
                    </div>
                )}

                {mod && (
                    <div className={cl("hint")}>
                        ← → frame · Shift + ← → jump 10 · Space play · I / O set in/out · Home / End edges
                        {adv && dims ? ` · source ${dims.w}×${dims.h}` : ""}
                    </div>
                )}
            </div>
        </Modal>
    );
}

export const TrimEditorModal = ErrorBoundary.wrap(TrimEditorInner, { noop: true });
