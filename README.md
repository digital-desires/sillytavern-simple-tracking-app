# Simple Stat Tracker

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that automatically tracks roleplay character stats from your chat, generates AI scene images when your location changes, and displays everything in clean floating windows that stay out of your way while you write.

---

<img width="2551" height="1030" alt="Capture d&#39;écran 2026-04-09 113319" src="https://github.com/user-attachments/assets/0d9460f2-d388-4626-a377-38b712ed3c01" />

## What it does

### Stat Tracking
After each AI reply, the extension sends your recent chat messages to an OpenRouter model of your choice. That model reads the conversation and extracts the current value of every stat you've defined — health, mood, clothing, arousal, inventory, relationship status, whatever you want — and updates the tracker window in real time.

You define stats one per line using plain text, with `{{char}}` and `{{user}}` macros:

```
{{char}} physical state
{{char}} clothing
{{user}} last position
{{user}} state of mind
Current location
Relationship tension
```
<img width="514" height="903" alt="Capture d&#39;écran 2026-04-09 113849" src="https://github.com/user-attachments/assets/05504736-74e0-40b9-9d80-c8eff43f988e" />
Stats are stored **per chat** inside SillyTavern's own metadata system, so each conversation has its own independent history. Switch to a different chat and you see that chat's stats. Come back and your values are exactly where you left them.

### Scene Image Generation (xAI)
When the tracker detects your **location stat** has changed, it triggers a two-step image generation pipeline:

1. **OpenRouter LLM** reads the recent chat messages and your location value, then writes a vivid visual scene description — picking up on the mood, lighting, and atmosphere from the actual story
2. **xAI (grok-2-image or similar)** receives that description and generates a landscape image

The scene appears in its own floating window. You choose the aspect ratio (16:9 is the default, much better for backgrounds), and the last 5 images are kept in a thumbnail history so you can browse back.

---

## Features

### Tracker Window
- Floating, draggable, resizable — sits on top of the chat without blocking it
- **Click any stat value to edit it inline** — useful for manual corrections or setting starting values
- **📋 Copy** button exports all current stats as plain text to clipboard
- **📷 Camera** button triggers a scene image generation on demand
- **Location override bar** — type any location and generate a scene image for it without waiting for the tracker to detect a change
- Profile name badge and last-updated timestamp in the footer
- Position remembered between sessions

### Scene Image Window
- Separate floating, draggable, resizable window
- **Aspect ratio selector** in the titlebar (16:9, 4:3, 1:1, 9:16, 3:2)
- **Image history** — thumbnail strip shows last 5 generated images, click to navigate
- **← → navigation** overlaid on the image
- **🐛 Debug panel** — toggle to see the exact location value, the LLM description sent to xAI, which model was used, and how many messages were passed to the LLM
- Auto-detects which xAI image models your account has access to (Detect button)
- Position remembered between sessions

<img width="594" height="719" alt="Capture d&#39;écran 2026-04-09 113945" src="https://github.com/user-attachments/assets/dd573ab4-9127-4ee3-a4e9-1d945b178fe4" />

### Profile System
- Create multiple named stat profiles (e.g. one per character type or genre)
- **Character → Profile binding** — link a character name to a profile and the tracker switches automatically when you load that character's chat
- Profiles are global settings, stat values are per-chat

<img width="623" height="487" alt="Capture d&#39;écran 2026-04-09 114109" src="https://github.com/user-attachments/assets/c778d314-7d34-45aa-9ada-0167f0b0e614" />

### Scene Prompt Templates
The full LLM instruction that generates scene descriptions is **fully editable** — it's a textarea in settings, not hardcoded. Use `{location}` and `{messages}` as placeholders. Save, load, and delete named templates so you can switch between a gritty noir style and a high fantasy style without rewriting the prompt each time.

### Other
- **Auto-refresh** after every AI reply (optional)
- **Inject tracked state** into the next prompt as a system message (so the AI stays consistent)
- Location change **toast notification** — `📍 Location: elevator` so you always know the tracker caught it
- Saved presets for OpenRouter model + temperature + token settings

---

## Requirements

- SillyTavern (recent version with extension support)
- An **OpenRouter** API key and a text model for stat tracking and scene description writing
- An **xAI** API key for image generation (optional — scene images only)

---

## Installation

1. In SillyTavern, go to **Extensions → Install extension**
2. Paste this repository URL
3. Reload SillyTavern

Or manually drop the `index.js`, `style.css`, and `manifest.json` files into a folder inside `SillyTavern/public/scripts/extensions/third-party/`.

---

## Setup

### Stat Tracking
1. Open **Extensions → Simple Stat Tracker**
2. Under **OpenRouter Backend**, paste your API key and click **Load** to fetch available models
3. Select a model — fast, cheap models like `x-ai/grok-4.1-fast` work well for tracking
4. Under **Profiles & Stats**, define the stats you want tracked (one per line)
5. Click **Save profile**
6. Enable **Auto-refresh after each reply**

### Scene Images
1. Under **Scene Image (xAI)**, paste your xAI API key
2. Click **Detect** to find which image models your account has access to
3. Make sure one of your tracked stats has "location" in its label (or change the keyword)
4. Enable **Auto-generate scene on location change**
5. Optionally edit the **Scene description prompt** to match your genre and visual style

### Character Binding
1. Load a character and start a chat
2. In settings, select the profile you want for that character
3. Click **Bind** next to the character's name
4. From now on, switching to any chat with that character auto-activates the bound profile

---

## How the scene description works

The scene description prompt is sent to your OpenRouter model with two variables filled in:

- `{location}` — the current value of your location stat (e.g. `"penthouse apartment"`)
- `{messages}` — the last N chat messages, so the LLM has story context

The model writes a visual description like:

> *A sleek Manhattan penthouse at dusk, floor-to-ceiling windows reflecting a bruised orange skyline. Expensive furniture sits in shadow. The air feels tense.*

That text is passed directly to xAI as the image prompt. The debug panel in the scene window shows you every step if something looks wrong.

---

## Tips

- **More recent messages = better images.** Increase the "Recent messages" count in Behaviour settings if your scenes feel generic.
- **The scene prompt matters.** The default is neutral. If you're writing dark fantasy, add that to the prompt template — tell the LLM to emphasize shadow, stone, candlelight.
- **Edit stats manually** when the AI gets something wrong. Click the value in the tracker window, type the correction, press Enter.
- **Use the location override bar** to test scene generation with any location string without needing to play through the story to get there.

---

## File structure

```
simple-stat-tracker/
├── manifest.json
├── index.js
└── style.css
```

---

## License

MIT
