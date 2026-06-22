/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

import { LayoutMode } from "./utils";

const cl = classNameFactory("vc-clipify-");

const OPTIONS: ReadonlyArray<[LayoutMode, string]> = [
    ["simple", "Simple"],
    ["moderate", "Moderate"],
    ["advanced", "Advanced"]
];

/**
 * The "layout box" shared by every editor: a segmented control that switches
 * how many controls the editor reveals (simple → moderate → advanced).
 */
export function LayoutSwitch({ value, onChange }: { value: LayoutMode; onChange: (mode: LayoutMode) => void; }) {
    return (
        <div className={cl("layout")}>
            <span className={cl("layout-label")}>Layout</span>
            <div className={cl("modes")}>
                {OPTIONS.map(([mode, label]) => (
                    <button
                        key={mode}
                        className={cl("mode", { "mode-active": value === mode })}
                        onClick={() => onChange(mode)}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}
