/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { React } from "@webpack/common";

const cl = classNameFactory("vc-clipify-");

export interface SliderProps {
    label: string;
    min: number;
    max: number;
    value: number;
    onChange: (value: number) => void;
    /** Optional custom rendering of the value (e.g. "180%"). Defaults to the number. */
    display?: React.ReactNode;
}

/**
 * The thick-track / blurple-fill / white-knob slider used across every editor —
 * a custom-styled range input so it matches the rest of the UI instead of the
 * browser default.
 */
export function Slider({ label, min, max, value, onChange, display }: SliderProps) {
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    return (
        <label className={cl("slider")}>
            <span>{label}</span>
            <input
                type="range"
                min={min}
                max={max}
                value={value}
                style={{ "--clipify-fill": `${pct}%` } as React.CSSProperties}
                onChange={e => onChange(Number(e.target.value))}
            />
            <span className={cl("slider-value")}>{display ?? value}</span>
        </label>
    );
}
