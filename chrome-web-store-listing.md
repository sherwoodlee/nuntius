# Chrome Web Store Listing

## Product name

`nuntius`

## Category

`Productivity`

## Language

`English`

## Short description

Draft replies in Slack, Teams, Instagram DMs, and Messenger with Claude, Gemini CLI, Codex CLI, or Ollama.

## Detailed description

`nuntius` is a side-panel assistant for Slack, Microsoft Teams, Instagram DMs, and Facebook Messenger that helps you draft replies without leaving the conversation you are already in.

Open a Slack thread, channel, or DM; a Teams chat; an Instagram DM; or a Messenger conversation, then generate a suggested reply directly from the page context. The extension reads the recent conversation, lets you choose a tone, and inserts a draft into the correct composer so you can review and send it yourself.

Why teams use nuntius:

- Works inside Slack, Microsoft Teams, Instagram DMs, and Facebook Messenger in one extension.
- Drafts replies in context instead of making you copy and paste chats into another tool.
- Supports Claude, Gemini CLI, and ChatGPT / Codex CLI through a local native host setup.
- Supports local Ollama models for private, on-device workflows.
- Lets you steer tone with moods like professional, direct, empathetic, playful, technical, or one-liner.
- Saves personal voice samples and optional profile details to better match your writing style.
- Includes a side panel that stays docked while you work.
- Supports light and dark theme syncing.

Typical use cases:

- Catch up on a long thread and draft a polished response quickly.
- Rewrite a message to be more concise, warmer, firmer, or more executive-friendly.
- Answer internal questions in your own style with less typing.
- Keep sensitive workflows local by using Ollama on your machine.

How it works:

1. Open Slack, Microsoft Teams, Instagram DMs, or Facebook Messenger in Chrome.
2. Open the nuntius side panel.
3. Choose your provider, tone, and optional instruction.
4. Generate a draft.
5. Review the inserted message before sending.

Important notes:

- `nuntius` only works on the supported Slack, Microsoft Teams, Instagram DM, and Facebook Messenger web apps.
- Claude, Gemini CLI, and ChatGPT / Codex CLI support require a one-time local native host installation.
- Ollama support requires a local Ollama instance and installed model.
- You stay in control of the final message. Drafts are inserted for review, not auto-sent.

## Store tags / keywords

- Slack AI assistant
- Microsoft Teams AI assistant
- Slack reply generator
- Teams reply generator
- Instagram DM reply generator
- Messenger reply generator
- Slack writing assistant
- Teams writing assistant
- Claude Chrome extension
- Gemini CLI Chrome extension
- Codex CLI Chrome extension
- Ollama Chrome extension
- AI message drafting
- workplace communication assistant
- side panel productivity tool
- response generator for Slack
- response generator for Teams

## Promo copy ideas

### Promotional sentence

Write faster in Slack, Teams, Instagram DMs, and Messenger without leaving the conversation.

### Alternative hooks

- Draft better replies in Slack, Teams, Instagram, and Messenger with Claude, Gemini CLI, Codex CLI, or Ollama.
- Your AI side panel for workplace messaging.
- Turn long chats into clear replies in a click.
- Stay in flow while drafting polished responses.

## Permission explanations

### `storage`

Used to save your settings, selected provider, voice samples, theme, and recent instructions locally in Chrome storage.

### `sidePanel`

Used to show the nuntius interface in Chrome's side panel beside supported chat apps.

### `tabs` and `activeTab`

Used to detect whether the current tab is a supported chat app and to target the correct tab when inserting a draft.

### `scripting`

Used to coordinate content scripts that read conversation context and place drafts into the page composer.

### `nativeMessaging`

Used only for optional Claude, Gemini CLI, and ChatGPT / Codex CLI support through a local native host installed by the user.

### `declarativeNetRequest`

Used to make local Ollama requests work cleanly by stripping the `Origin` header for localhost calls.

### Host permissions

Used only on:

- `https://app.slack.com/*`
- `https://teams.microsoft.com/*`
- `https://teams.cloud.microsoft/*`
- `https://www.instagram.com/direct/*`
- `https://www.facebook.com/messages/*`
- `http://localhost/*`
- `http://127.0.0.1/*`

These permissions are required to read message context from supported chat apps and connect to a local Ollama server when enabled.

## Privacy disclosure draft

`nuntius` runs inside supported Slack, Microsoft Teams, Instagram DM, and Facebook Messenger pages to collect the visible conversation context needed to draft a reply. Settings and saved voice samples are stored locally in Chrome storage on the user's machine.

If the user selects Ollama, prompts are sent only to the user's configured local Ollama server. If the user selects Claude, Gemini CLI, or ChatGPT / Codex CLI, prompts are sent through the user's locally installed CLI via a native host. The extension does not auto-send messages; it inserts a draft for the user to review before sending.

## Submission checklist

- Confirm the extension name, version, and icon are final.
- Upload `dist/nuntius-<version>-chrome-web-store.zip`.
- Add at least one Chrome Web Store screenshot.
- Provide a public privacy policy URL if the dashboard requires one for your selected disclosures.
- Verify the permission justifications match the final submission form answers.
