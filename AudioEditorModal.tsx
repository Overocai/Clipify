/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, showToast, Toasts, useCallback, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { terminateFFmpeg, trimAudioWithFFmpeg, TrimMode } from "./ffmpeg";
import { clamp, Engine, formatTimecode, trimAudioWebAudio } from "./utils";

const cl = classNameFactory("vc-clipify-");

const MIN_SELECTION = 0.05;

export interface AudioEditorModalProps {
    modalProps: RenderModalProps;
    file: File;
    engine: Engine;
    defaultMode: TrimMode;
    onComplete: (trimmed: File) => void;
}

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
        return clamp((clientX - rect.left) / rect.width, 0, 1) * duration;
    }, [duration]);

    const apply = (kind: DragKind, t: number) => {
        if (kind === "start") onChangeStart(clamp(t, 0, end - MIN_SELECTION));
        else if (kind === "end") onChangeEnd(clamp(t, start + MIN_SELECTION, duration));
        else onScrub(clamp(t, 0, duration));
    };

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

    return (
        <div className={cl("timeline")} aria-label="Timeline">
            <div className={cl("timeline-track")} ref={trackRef} {...handlers("scrub")}>
                <div
                    className={cl("timeline-selection")}
                    style={{ left: `${pct(start)}%`, width: `${pct(end) - pct(start)}%` }}
                />
            </div>
            <div className={cl("timeline-playhead")} style={{ left: `${pct(current)}%` }} />
            <div
                className={cl("timeline-handle", { "handle-active": drag === "start" })}
                style={{ left: `${pct(start)}%` }}
                role="slider"
                aria-label="Selection start"
                {...handlers("start")}
            />
            <div
                className={cl("timeline-handle", { "handle-active": drag === "end" })}
                style={{ left: `${pct(end)}%` }}
                role="slider"
                aria-label="Selection end"
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
    toStart: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
    toEnd: "M16 6h2v12h-2zM6 18l8.5-6L6 6z",
    chevLeft: "M14 7.4 9.4 12l4.6 4.6V7.4z",
    chevRight: "M10 7.4 14.6 12 10 16.6V7.4z",
    note: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"
};

/* --------------------------- Editor modal ------------------------------- */

function AudioEditorInner({ modalProps, file, engine, defaultMode, onComplete }: AudioEditorModalProps) {
    const url = useMemo(() => URL.createObjectURL(file), [file]);
    const audioRef = useRef<HTMLAudioElement>(null);
    const rafRef = useRef<number>(0);
    const signalRef = useRef<{ cancelled: boolean; }>({ cancelled: false });

    const [duration, setDuration] = useState(0);
    const [start, setStart] = useState(0);
    const [end, setEnd] = useState(0);
    const [current, setCurrent] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [mode, setMode] = useState<TrimMode>(defaultMode);
    const [exporting, setExporting] = useState(false);
    const [progress, setProgress] = useState(0);

    const useFFmpeg = engine === "ffmpeg";

    useEffect(() => () => {
        URL.revokeObjectURL(url);
        signalRef.current.cancelled = true;
        cancelAnimationFrame(rafRef.current);
    }, [url]);

    const onLoadedMetadata = () => {
        const a = audioRef.current;
        if (!a) return;
        const d = Number.isFinite(a.duration) ? a.duration : 0;
        setDuration(d);
        setEnd(d);
        setCurrent(0);
    };

    /* Loop playback inside the [start, end] selection for a live preview. */
    useEffect(() => {
        if (!playing) return;
        const a = audioRef.current;
        if (!a) return;
        const tick = () => {
            if (!a) return;
            if (a.currentTime >= end) a.currentTime = start;
            setCurrent(a.currentTime);
            rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
    }, [playing, start, end]);

    const seek = useCallback((t: number) => {
        const a = audioRef.current;
        const clamped = clamp(t, 0, duration);
        if (a) a.currentTime = clamped;
        setCurrent(clamped);
    }, [duration]);

    const togglePlay = useCallback(() => {
        const a = audioRef.current;
        if (!a) return;
        if (playing) {
            a.pause();
            setPlaying(false);
        } else {
            if (a.currentTime < start || a.currentTime >= end) a.currentTime = start;
            a.play().then(() => setPlaying(true)).catch(() => { /* ignore */ });
        }
    }, [playing, start, end]);

    const pauseThen = useCallback((t: number) => {
        const a = audioRef.current;
        if (a && !a.paused) a.pause();
        setPlaying(false);
        seek(t);
    }, [seek]);

    const stepTime = (delta: number) => {
        const a = audioRef.current;
        const base = a ? a.currentTime : current;
        pauseThen(base + delta);
    };

    const setStartHere = () => setStart(clamp(current, 0, end - MIN_SELECTION));
    const setEndHere = () => setEnd(clamp(current, start + MIN_SELECTION, duration));
    const nudgeStart = (dir: number) => setStart(prev => clamp(prev + dir * 0.05, 0, end - MIN_SELECTION));
    const nudgeEnd = (dir: number) => setEnd(prev => clamp(prev + dir * 0.05, start + MIN_SELECTION, duration));

    const selectionLength = Math.max(0, end - start);

    const runExport = useCallback(async (): Promise<File> => {
        if (useFFmpeg) {
            try {
                return await trimAudioWithFFmpeg(file, start, end, { mode, signal: signalRef.current, onProgress: setProgress });
            } catch (err) {
                if (signalRef.current.cancelled) throw err;
                showToast("FFmpeg unavailable — exporting offline as WAV.", Toasts.Type.MESSAGE);
            }
        }
        return trimAudioWebAudio(file, start, end);
    }, [useFFmpeg, file, start, end, mode]);

    const handleExport = useCallback(async () => {
        if (exporting) return;
        const a = audioRef.current;
        if (a && !a.paused) a.pause();
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
            showToast("Audio trimmed and added to your message!", Toasts.Type.SUCCESS);
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

    const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | undefined>(undefined);
    keyHandlerRef.current = (e: KeyboardEvent) => {
        if (exporting) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        switch (e.key) {
            case "ArrowLeft": e.preventDefault(); stepTime(e.shiftKey ? -5 : -1); break;
            case "ArrowRight": e.preventDefault(); stepTime(e.shiftKey ? 5 : 1); break;
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
            title="Audio trim editor"
            actions={[
                { text: "Trim & send", variant: "primary", onClick: handleExport, loading: exporting, disabled: exporting || selectionLength < MIN_SELECTION },
                { text: "Cancel", variant: "secondary", onClick: cancel, disabled: exporting }
            ]}
        >
            <div className={cl("editor")}>
                <audio ref={audioRef} src={url} onLoadedMetadata={onLoadedMetadata} onEnded={() => setPlaying(false)} />

                <div className={cl("audio-stage")}>
                    <button
                        className={cl("audio-play", { "audio-play-on": playing })}
                        onClick={togglePlay}
                        title={playing ? "Pause" : "Play selection"}
                    >
                        <Icon d={playing ? ICONS.pause : ICONS.play} width="34" height="34" />
                    </button>
                    <div className={cl("audio-meta")}>
                        <span className={cl("audio-icon")}><Icon d={ICONS.note} /></span>
                        <span className={cl("audio-name")}>{file.name}</span>
                    </div>
                    {exporting && (
                        <div className={cl("overlay")}>
                            <div className={cl("overlay-label")}>Processing audio… {Math.round(progress * 100)}%</div>
                            <div className={cl("overlay-bar")}>
                                <div className={cl("overlay-fill")} style={{ width: `${Math.round(progress * 100)}%` }} />
                            </div>
                            <div className={cl("overlay-hint")}>
                                {!useFFmpeg
                                    ? "Exporting offline as lossless WAV."
                                    : mode === "lossless"
                                        ? "Lossless cut — almost instant."
                                        : "Re-encoding to AAC (FFmpeg)."}
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

                {useFFmpeg && (
                    <div className={cl("optbar")}>
                        <div className={cl("modes")}>
                            <button
                                className={cl("mode", { "mode-active": mode === "lossless" })}
                                onClick={() => setMode("lossless")}
                                title="Instant; keeps the original format and quality"
                            >
                                Lossless
                            </button>
                            <button
                                className={cl("mode", { "mode-active": mode === "precise" })}
                                onClick={() => setMode("precise")}
                                title="Re-encodes to AAC (.m4a)"
                            >
                                Re-encode
                            </button>
                        </div>
                        <span />
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
                    <button className={cl("iconbtn")} title="Jump to selection start" onClick={() => pauseThen(start)}>
                        <Icon d={ICONS.toStart} />
                    </button>
                    <button className={cl("iconbtn", { "iconbtn-primary": true })} title={playing ? "Pause" : "Play selection"} onClick={togglePlay}>
                        <Icon d={playing ? ICONS.pause : ICONS.play} />
                    </button>
                    <button className={cl("iconbtn")} title="Jump to selection end" onClick={() => pauseThen(end)}>
                        <Icon d={ICONS.toEnd} />
                    </button>
                </div>

                <div className={cl("setbtns")}>
                    <div className={cl("setgroup")}>
                        <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge start back" onClick={() => nudgeStart(-1)}>
                            <Icon d={ICONS.chevLeft} />
                        </button>
                        <button className={cl("setbtn")} title="Set start to current time" onClick={setStartHere}>
                            Set start
                        </button>
                        <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge start forward" onClick={() => nudgeStart(1)}>
                            <Icon d={ICONS.chevRight} />
                        </button>
                    </div>
                    <div className={cl("setgroup")}>
                        <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge end back" onClick={() => nudgeEnd(-1)}>
                            <Icon d={ICONS.chevLeft} />
                        </button>
                        <button className={cl("setbtn")} title="Set end to current time" onClick={setEndHere}>
                            Set end
                        </button>
                        <button className={cl("iconbtn", "iconbtn-sm")} title="Nudge end forward" onClick={() => nudgeEnd(1)}>
                            <Icon d={ICONS.chevRight} />
                        </button>
                    </div>
                </div>

                <div className={cl("hint")}>
                    ← → 1s · Shift + ← → 5s · Space play · I / O set in/out · Home / End edges
                </div>
            </div>
        </Modal>
    );
}

export const AudioEditorModal = ErrorBoundary.wrap(AudioEditorInner, { noop: true });
