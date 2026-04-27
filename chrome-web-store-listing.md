# Chrome Web Store Listing

## Product name

`nuntius`

## Category

`Productivity`

## Language

`English`

## Short description

Draft Slack and Microsoft Teams replies with Claude or a local Ollama model, right inside each app.

## Detailed description

`nuntius` is a side-panel assistant for Slack and Microsoft Teams that helps you draft replies without leaving the conversation you are already in.

Open a thread, channel, DM, or Teams chat, then generate a suggested reply directly from the page context. The extension reads the recent conversation, lets you choose a tone, and inserts a draft into the correct composer so you can review and send it yourself.

Why teams use nuntius:

- Works inside Slack and Microsoft Teams in one extension.
- Drafts replies in context instead of making you copy and paste chats into another tool.
- Supports Claude through a local native host setup.
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

1. Open Slack or Microsoft Teams in Chrome.
2. Open the nuntius side panel.
3. Choose your provider, tone, and optional instruction.
4. Generate a draft.
5. Review the inserted message before sending.

Important notes:

- `nuntius` only works on Slack and Microsoft Teams web apps.
- Claude support requires a one-time local native host installation.
- Ollama support requires a local Ollama instance and installed model.
- You stay in control of the final message. Drafts are inserted for review, not auto-sent.

## Store tags / keywords

- Slack AI assistant
- Microsoft Teams AI assistant
- Slack reply generator
- Teams reply generator
- Slack writing assistant
- Teams writing assistant
- Claude Chrome extension
- Ollama Chrome extension
- AI message drafting
- workplace communication assistant
- side panel productivity tool
- response generator for Slack
- response generator for Teams

## Promo copy ideas

### Promotional sentence

Write faster in Slack and Teams without leaving the conversation.

### Alternative hooks

- Draft better replies in Slack and Teams with Claude or Ollama.
- Your AI side panel for workplace messaging.
- Turn long threads into clear replies in a click.
- Stay in flow while drafting polished responses.

## Permission explanations

### `storage`

Used to save your settings, selected provider, voice samples, theme, and recent instructions locally in Chrome storage.

### `sidePanel`

Used to show the nuntius interface in Chrome's side panel beside Slack and Teams.

### `tabs` and `activeTab`

Used to detect whether the current tab is Slack or Teams and to target the correct tab when inserting a draft.

### `scripting`

Used to coordinate content scripts that read conversation context and place drafts into the page composer.

### `nativeMessaging`

Used only for optional Claude CLI support through a local native host installed by the user.

### `declarativeNetRequest`

Used to make local Ollama requests work cleanly by stripping the `Origin` header for localhost calls.

### Host permissions

Used only on:

- `https://app.slack.com/*`
- `https://teams.microsoft.com/*`
- `https://teams.cloud.microsoft/*`
- `http://localhost/*`
- `http://127.0.0.1/*`

These permissions are required to read message context from supported chat apps and connect to a local Ollama server when enabled.

## Privacy disclosure draft

`nuntius` runs inside Slack and Microsoft Teams pages to collect the visible conversation context needed to draft a reply. Settings and saved voice samples are stored locally in Chrome storage on the user's machine.

If the user selects Ollama, prompts are sent only to the user's configured local Ollama server. If the user selects Claude, prompts are sent through the user's locally installed Claude CLI via a native host. The extension does not auto-send messages; it inserts a draft for the user to review before sending.

## Submission checklist

- Confirm the extension name, version, and icon are final.
- Upload `dist/nuntius-<version>-chrome-web-store.zip`.
- Add at least one Chrome Web Store screenshot.
- Provide a public privacy policy URL if the dashboard requires one for your selected disclosures.
- Verify the permission justifications match the final submission form answers.
