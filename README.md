# Nuntius Ultimate

Chrome side-panel extension that drafts both **Slack** and **Microsoft Teams** replies with Claude or a local Ollama model, right inside the web app.

A merged successor to [pontis-chrome](https://github.com/shilee_LinkedIn/pontis-chrome) (Slack) and [nuntius](https://github.com/shilee_LinkedIn/nuntius) (Teams). One install, one native-host setup, one panel that adapts to whichever app you're looking at.

## Install — the fast path (Ollama only, no native host)

1. Clone or download this repo.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
3. Pin the Nuntius icon.
4. Open either `https://app.slack.com/` or a Teams tab, click the icon, and the side panel docks on the right. The header badge flips between **SLACK** and **TEAMS** automatically.
5. In settings, set **Provider** = Ollama and pick a model (e.g. `qwen3:8b`). Make sure Ollama is running locally.

Ollama works out of the box — no CORS shenanigans, no separate installer.

## Install — adding Claude (CLI) as a provider

Native messaging needs a separate setup because Chrome doesn't let extensions write files outside their sandbox. One-time:

1. Make sure the `claude` CLI is on your PATH (`which claude` should return something).
2. Copy the extension ID from `chrome://extensions` (the 32-char string on the Nuntius Ultimate card — Developer mode must be on).
3. Run:

   ```sh
   ./native-host/install.sh <extension-id>
   ```

4. Reload the extension.
5. In settings, set **Provider** = Claude and pick a model + effort level.

### Why the extension ID matters

Chrome derives the extension ID from the **install path** when you load-unpacked, so every checkout (or move) produces a different ID. That's why `install.sh` takes it as an argument — the native-host manifest pins it in `allowed_origins`.

If you want a stable ID across machines and installs, add a `key` field to `manifest.json` (public half of a key pair you generate once). Then `install.sh` can bake the ID in.

## Usage

1. Open Slack (`https://app.slack.com/`) or a Teams tab.
2. Click the Nuntius toolbar icon → side panel opens. The badge shows which app it's talking to.
3. **Slack**: open a thread (click a message → "Reply in thread"), a channel, or a DM. **Teams**: open a chat.
4. The panel auto-refreshes every 2 s; click ↻ to force.
5. Pick a mood, optionally a voice, optionally type an instruction.
6. Press **Enter** in the instruction box (or click **Draft reply**). Claude/Ollama drafts a reply and Nuntius pastes it into the right composer.
7. Review in the app, press Enter to send.

Shift+Enter in the instruction box inserts a newline instead of drafting.

## Settings (⚙ in header)

- **You** — Your name/alias and an optional bio. Helps the model know when someone is addressing or @mentioning you.
- **Theme** — Light / Dark. Nuntius spoofs `prefers-color-scheme` in the host page. Slack caches the initial value, so Nuntius reloads the Slack tab when you flip the theme; Teams follows live if you enable Teams → Settings → Appearance → Follow system.
- **Provider** — Claude (CLI via native host) or Ollama (local).
- **Claude model / Effort** — Opus / Sonnet / Haiku, plus `--effort` level.
- **Ollama host / model** — point at your Ollama install and pick from its installed models.
- **Messages to load** — how many recent messages to scrape (1–200). In Slack, threads always load in full.
- **Voices** — per-handle samples for impersonation. Paste messages, or on Slack click **↓ Pull from search**:
  1. In Slack, run a search like `from:@rogautam`.
  2. In Nuntius, click **↓ Pull from search** on that voice's card. The script scrolls Slack's results list to expand the virtualized list, harvests up to 30 unique messages, and appends them (deduped).

  The Pull-from-search button is hidden on Teams (Teams search doesn't expose a stable enough surface to scrape).

## Host switching

Nuntius figures out which app you're talking to by inspecting the most-recently-active Slack or Teams tab. If you switch tabs, the panel auto-adapts within a refresh cycle (2 s).

If both Slack and Teams are open, the most recently focused tab wins. Force-refresh with ↻ to re-evaluate.

## Ollama notes

Ollama ships with an origin check that blocks browser-origin requests (403 Forbidden). Nuntius strips the `Origin` header on `localhost:11434` requests via a `declarativeNetRequest` rule, so you don't need to set `OLLAMA_ORIGINS`. Just run Ollama normally.

If you use a non-default host/port, update the rule in `rules/ollama.json`.

## Files

- `manifest.json` — MV3. Two content-script blocks (Slack match, Teams match); `content-main.js` runs in MAIN world on both.
- `background.js` — service worker; host-agnostic LLM routing + per-tab side-panel enablement.
- `content-slack.js` — isolated-world content script for Slack. DOM scrape, voice-sample harvest from search, paste into Slack's Quill composer.
- `content-teams.js` — isolated-world content script for Teams. DOM scrape, paste into CKEditor 5.
- `content-main.js` — MAIN-world script shared across both hosts. Patches `window.matchMedia` so "Sync with OS" / "Follow system" theme honors Nuntius's toggle.
- `sidepanel/` — unified UI. Detects current host, adapts labels and affordances, shows host badge in header.
- `rules/ollama.json` — `declarativeNetRequest` rule that strips `Origin` on Ollama requests.
- `native-host/` — Node-based native-messaging host for the Claude CLI + installer script. Host ID: `com.nuntius_ultimate.claude`.

## Coexistence with old installs

Nuntius Ultimate uses its own:
- Chrome storage key (`nuntius_ultimate`), so your pontis-chrome and nuntius settings/voices are untouched.
- Native-host name (`com.nuntius_ultimate.claude`), so the old `com.pontis_chrome.claude` and `com.nuntius.claude` hosts can stay installed side-by-side.

When you're happy with Ultimate, uninstall the two old extensions in `chrome://extensions`. The leftover native-host manifests (in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`) are harmless but you can delete `com.pontis_chrome.claude.json` and `com.nuntius.claude.json` to tidy up.
