# Clipify

A [Vencord](https://vencord.dev/) / [Equicord](https://equicord.org/) userplugin that asks whether you want to trim a video **before** sending it, then opens a frame-accurate trim editor built right into Discord.

Drop or paste a video into any channel/DM composer and Clipify steps in: send the original as-is, or trim it down to just the part you want — no leaving Discord, no external tools.

## Screenshots

| Choice prompt | Trim editor |
| :---: | :---: |
| ![Trim video before sending prompt](assets/choice-modal.png) | ![Frame-accurate trim editor](assets/trim-editor.png) |

## Features

- **Upload interception** — catches video uploads in the normal message composer and prompts you with a choice: *trim* or *send original*. Non-video files and extra videos in the same drop pass through untouched.
- **Frame-accurate trim editor** — scrub, set in/out points, and preview your selection in a modal that matches Discord's look.
- **Two trim engines:**
  - **FFmpeg** (recommended) — precise/lossless trimming via `ffmpeg.wasm`. The ~30MB core is fetched on first use from jsDelivr (allow-listed in Discord's CSP).
    - *Precise* — cuts at the exact frame (re-encodes to `.mp4`).
    - *Fast / lossless* — instant stream-copy, no quality loss, but the start snaps to the nearest keyframe.
  - **MediaRecorder** — fully offline fallback that re-encodes to `.webm` in real time.
- **Quality presets** — High / Medium / Low (CRF for FFmpeg precise, bitrate for MediaRecorder).
- **Configurable FPS** for frame-by-frame navigation.

## Keyboard shortcuts (editor)

| Key | Action |
| --- | --- |
| `Space` | Play / pause selection |
| `←` / `→` | Step 1 frame back / forward |
| `Shift` + `←` / `→` | Step 10 frames back / forward |
| `I` | Set selection start to current frame |
| `O` | Set selection end to current frame |
| `Home` | Jump to selection start |
| `End` | Jump to selection end |

## Settings

| Setting | Description |
| --- | --- |
| **Intercept uploads** | Ask before sending a video upload. |
| **Engine** | FFmpeg (precise/lossless) or MediaRecorder (offline). |
| **Trim mode** | FFmpeg only — *Precise* (exact frame) or *Fast* (lossless keyframe). |
| **Export quality** | High / Medium / Low. |
| **Frame rate** | Assumed FPS for frame-by-frame navigation. |

## Installation

This is a Vencord/Equicord **userplugin**. You need a dev build of the client.

1. Clone or copy this folder into `src/userplugins/Clipify` in your Vencord/Equicord source.
2. Rebuild and inject the client (`pnpm build && pnpm inject`).
3. Enable **Clipify** in Settings → Plugins.

> See the [Vencord plugin docs](https://docs.vencord.dev/installing/custom-plugins/) for details on setting up a custom-plugin dev environment.

## License

GPL-3.0-or-later
