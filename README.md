# nuntius

Chrome side-panel extension that drafts **Slack**, **Microsoft Teams**, **Instagram**, and **Facebook Messenger** replies with Claude, Gemini CLI, ChatGPT / Codex CLI, or a local Ollama model, right inside the web app.

A merged successor to [pontis-chrome](https://github.com/shilee_LinkedIn/pontis-chrome) (Slack) and [nuntius](https://github.com/shilee_LinkedIn/nuntius) (Teams), now with Instagram DM and Messenger support too. One install, one native-host setup, one panel that adapts to whichever app you're looking at.

## Install — the fast path (Ollama only, no native host)

1. Clone or download this repo.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
3. Pin the nuntius icon.
4. Open Slack, Teams, Instagram DMs (`https://www.instagram.com/direct/inbox/`), or Messenger (`https://www.facebook.com/messages`), click the icon, and the side panel docks on the right. The header badge flips to the active app automatically.
5. In settings, set **Provider** = Ollama and pick a model (e.g. `qwen3:8b`). Make sure Ollama is running locally.

Ollama works out of the box — no CORS shenanigans, no separate installer.

## Install — adding Claude (CLI) as a provider

Native messaging needs a separate setup because Chrome doesn't let extensions write files outside their sandbox. One-time:

1. Make sure the `claude` CLI is on your PATH (`which claude` should return something).
2. Copy the extension ID from `chrome://extensions` (the 32-char string on the nuntius card — Developer mode must be on).
3. Run:

   ```sh
   bash <(curl -fsSL https://raw.githubusercontent.com/sherwoodlee/nuntius-installer/main/install.sh)
   ```

   The installer will prompt for the extension ID from `chrome://extensions`.

4. Reload the extension.
5. In settings, set **Provider** = Claude and pick a model + effort level.

## Install — adding Gemini CLI or ChatGPT / Codex CLI

The same native-host bridge used for Claude also lets nuntius invoke Gemini CLI and Codex CLI from the side panel.

1. Finish the native-host install above.
2. Install the CLI you want:

   ```sh
   npm install -g @google/gemini-cli
   npm install -g @openai/codex
   ```

3. Authenticate once in Terminal:

   ```sh
   gemini
   codex --login
   ```

   For Gemini, you can also set `GEMINI_API_KEY`. For Codex, you can also set `OPENAI_API_KEY`.

4. In settings, set **Provider** = Gemini CLI or ChatGPT / Codex CLI. Leave the model blank to use each CLI's default, or type a model name if you want to force one.

If you already have the repo checked out locally, this still works too:

```sh
./native-host/install.sh <extension-id>
```

### Why the extension ID matters

Chrome derives the extension ID from the **install path** when you load-unpacked, so every checkout (or move) produces a different ID. That's why the installer still needs it even when you run it from the public GitHub helper repo — the native-host manifest pins it in `allowed_origins`.

If you want a stable ID across machines and installs, add a `key` field to `manifest.json` (public half of a key pair you generate once). Then `install.sh` can bake the ID in.

## Usage

1. Open Slack (`https://app.slack.com/`), Teams, Instagram DMs (`https://www.instagram.com/direct/inbox/`), or Messenger (`https://www.facebook.com/messages`).
2. Click the nuntius toolbar icon → side panel opens. The badge shows which app it's talking to.
3. **Slack**: open a thread (click a message → "Reply in thread"), a channel, or a DM. **Teams**: open a chat. **Instagram**: open a DM thread. **Messenger**: open a conversation.
4. The panel auto-refreshes every 2 s; click ↻ to force.
5. Pick a mood, optionally a voice, optionally type an instruction.
6. Press **Enter** in the instruction box (or click **Draft reply**). Claude/Ollama drafts a reply and nuntius pastes it into the right composer.
7. Review in the app, press Enter to send.

Shift+Enter in the instruction box inserts a newline instead of drafting.

## Settings (⚙ in header)

- **You** — Your name/alias and an optional bio. Helps the model know when someone is addressing or @mentioning you.
- **Theme** — Light / Dark. nuntius spoofs `prefers-color-scheme` in the host page where needed. Slack caches the initial value, so nuntius reloads the Slack tab when you flip the theme; Teams follows live if you enable Teams → Settings → Appearance → Follow system.
- **Provider** — Claude, Gemini CLI, ChatGPT / Codex CLI (all via native host), or Ollama (local).
- **Claude model / Effort** — Opus / Sonnet / Haiku, plus `--effort` level.
- **Gemini / ChatGPT model** — optional free-form model override; leave blank to use the CLI default.
- **Ollama host / model** — point at your Ollama install and pick from its installed models.
- **Messages to load** — how many recent messages to scrape (1–200). In Slack, threads always load in full.
- **Voices** — per-handle samples for impersonation. Paste messages, or on Slack click **↓ Pull from search**:
  1. In Slack, run a search like `from:@rogautam`.
  2. In nuntius, click **↓ Pull from search** on that voice's card. The script scrolls Slack's results list to expand the virtualized list, harvests up to 30 unique messages, and appends them (deduped).

  The Pull-from-search button is hidden on Teams, Instagram, and Messenger (their search surfaces don't expose a stable enough structure to scrape reliably).

## Host switching

nuntius figures out which app you're talking to by inspecting the most-recently-active Slack, Teams, Instagram, or Messenger tab. If you switch tabs, the panel auto-adapts within a refresh cycle (2 s).

If multiple supported apps are open, the most recently focused tab wins. Force-refresh with ↻ to re-evaluate.

## Ollama notes

Ollama ships with an origin check that blocks browser-origin requests (403 Forbidden). nuntius strips the `Origin` header on `localhost:11434` requests via a `declarativeNetRequest` rule, so you don't need to set `OLLAMA_ORIGINS`. Just run Ollama normally.

If you use a non-default host/port, update the rule in `rules/ollama.json`.

## Files

- `manifest.json` — MV3. Host-specific content-script blocks for Slack, Teams, Instagram, and Messenger; `content-main.js` runs in MAIN world on Slack and Teams.
- `background.js` — service worker; host-agnostic LLM routing + per-tab side-panel enablement.
- `content-slack.js` — isolated-world content script for Slack. DOM scrape, voice-sample harvest from search, paste into Slack's Quill composer.
- `content-teams.js` — isolated-world content script for Teams. DOM scrape, paste into CKEditor 5.
- `content-instagram.js` — isolated-world content script for Instagram web DMs. DOM scrape + paste into Instagram's contenteditable composer.
- `content-facebook.js` — isolated-world content script for Facebook Messenger. Scrapes message `article`s from the live conversation log and pastes into the Messenger composer.
- `content-main.js` — MAIN-world script shared across both hosts. Patches `window.matchMedia` so "Sync with OS" / "Follow system" theme honors nuntius's toggle.
- `sidepanel/` — unified UI. Detects current host, adapts labels and affordances, shows host badge in header.
- `rules/ollama.json` — `declarativeNetRequest` rule that strips `Origin` on Ollama requests.
- `native-host/` — Node-based native-messaging host for local AI CLIs (Claude / Gemini / Codex) + installer script. Host ID: `com.nuntius.claude`.
