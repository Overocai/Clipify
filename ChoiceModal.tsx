/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { classNameFactory } from "@utils/css";
import type { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, useEffect, useMemo, useState } from "@webpack/common";

import { formatTimecode, MediaKind } from "./utils";

const cl = classNameFactory("vc-clipify-");

function formatBytes(bytes: number): string {
    if (!bytes) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Copy + verb for each media kind. */
const COPY: Record<MediaKind, { title: string; action: string; question: string; }> = {
    video: { title: "Trim video before sending?", action: "Trim video", question: "Do you want to trim this video before sending?" },
    audio: { title: "Trim audio before sending?", action: "Trim audio", question: "Do you want to trim this audio before sending?" },
    image: { title: "Edit image before sending?", action: "Edit image", question: "Do you want to edit this image before sending?" }
};

export interface ChoiceModalProps {
    modalProps: RenderModalProps;
    file: File;
    kind: MediaKind;
    /** Total number of files in this drop (>= 1). */
    count: number;
    onEdit: () => void;
    onSendOriginal: () => void;
    onCancel: () => void;
}

function ChoiceModalInner({ modalProps, file, kind, count, onEdit, onSendOriginal, onCancel }: ChoiceModalProps) {
    const url = useMemo(() => URL.createObjectURL(file), [file]);
    const [duration, setDuration] = useState<number | null>(null);
    const [dimensions, setDimensions] = useState<string | null>(null);

    useEffect(() => () => URL.revokeObjectURL(url), [url]);

    const copy = COPY[kind];

    const subtitleParts = [
        formatBytes(file.size),
        duration != null ? formatTimecode(duration) : null,
        dimensions,
        count > 1 ? `+${count - 1} more file(s)` : null
    ].filter(Boolean);

    return (
        <Modal
            {...modalProps}
            size="md"
            title={copy.title}
            actions={[
                { text: copy.action, variant: "primary", onClick: onEdit },
                { text: "Send original", variant: "secondary", onClick: onSendOriginal },
                { text: "Cancel", variant: "secondary", onClick: onCancel }
            ]}
        >
            <div className={cl("choice")}>
                <div className={cl("choice-preview")}>
                    <span className={cl("choice-badge")}>Preview</span>
                    {kind === "video" && (
                        <video src={url} muted loop autoPlay playsInline onLoadedMetadata={e => setDuration(e.currentTarget.duration)} />
                    )}
                    {kind === "image" && (
                        <img
                            src={url}
                            alt={file.name}
                            onLoad={e => setDimensions(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
                        />
                    )}
                    {kind === "audio" && (
                        <div className={cl("choice-audio")}>
                            <svg width="46" height="46" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z" /></svg>
                            <audio src={url} controls onLoadedMetadata={e => setDuration(e.currentTarget.duration)} />
                        </div>
                    )}
                </div>

                <div className={cl("choice-meta")}>
                    <div className={cl("choice-name")}>{file.name}</div>
                    {subtitleParts.length > 0 && (
                        <div className={cl("choice-sub")}>{subtitleParts.join(" • ")}</div>
                    )}
                </div>

                <div className={cl("choice-question")}>{copy.question}</div>
            </div>
        </Modal>
    );
}

export const ChoiceModal = ErrorBoundary.wrap(ChoiceModalInner, { noop: true });
