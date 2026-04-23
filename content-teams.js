// Content script: lives inside teams.microsoft.com / teams.cloud.microsoft and
// handles DOM scraping + draft paste on request from the side panel. Also
// mirrors the user's Nuntius Ultimate theme choice to a DOM attribute so the
// MAIN-world matchMedia patch can spoof prefers-color-scheme for Teams' theme
// engine.

(function () {
  // ---------- theme mirroring (feeds content-main.js) ----------
  function applyThemeAttr(theme) {
    const el = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      el.setAttribute('data-nuntius-theme', theme);
    } else {
      el.removeAttribute('data-nuntius-theme');
    }
  }
  chrome.storage.local.get('nuntius_ultimate', ({ nuntius_ultimate: s }) => {
    applyThemeAttr(s?.theme);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.nuntius_ultimate) return;
    applyThemeAttr(changes.nuntius_ultimate.newValue?.theme);
  });

  // ---------- teamsToMarkdown: convert a message body element to markdown ----------
  // Teams doesn't use <blockquote> for quote-replies — it renders a custom
  // card keyed by data-tid/class. Match those patterns too so quoted content
  // in the panel actually looks like a quote.
  const TEAMS_QUOTE_SEL = [
    'blockquote',
    '[data-tid="reply-preview"]',
    '[data-tid="quoted-message"]',
    '[data-tid="chat-pane-quote"]',
    '[data-tid*="quote" i]',
    '[class*="QuotedMessage"]',
    '[class*="MessageQuote"]',
    '[class*="ReplyCard"]',
  ].join(', ');

  function teamsToMarkdown(el) {
    if (!el) return '';
    const root = el.cloneNode(true);

    // Inline replacements first so that links/code/emphasis nested inside a
    // quote are already markdown text by the time we collapse the quote.
    root.querySelectorAll('pre').forEach((n) => {
      if (!n.parentNode) return;
      const code = (n.textContent || '').replace(/\s+$/, '');
      n.replaceWith(document.createTextNode('\n```\n' + code + '\n```\n'));
    });
    root.querySelectorAll('code').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('`' + (n.textContent || '') + '`'));
    });
    root.querySelectorAll('a[href]').forEach((n) => {
      if (!n.parentNode) return;
      const href = n.getAttribute('href') || '';
      const text = (n.textContent || '').trim();
      const md = !text || text === href ? href : `[${text}](${href})`;
      n.replaceWith(document.createTextNode(md));
    });
    root.querySelectorAll('b, strong').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('**' + (n.textContent || '') + '**'));
    });
    root.querySelectorAll('i, em').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('_' + (n.textContent || '') + '_'));
    });
    root.querySelectorAll('s, del').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('~~' + (n.textContent || '') + '~~'));
    });
    root.querySelectorAll('img[alt]').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode(n.getAttribute('alt') || ''));
    });
    root.querySelectorAll('ol').forEach((ol) => {
      ol.querySelectorAll(':scope > li').forEach((li, i) => {
        li.insertBefore(document.createTextNode(`${i + 1}. `), li.firstChild);
      });
    });
    root.querySelectorAll('ul > li').forEach((li) => {
      li.insertBefore(document.createTextNode('- '), li.firstChild);
    });

    // Quote blocks last — by now their children are already markdown text.
    root.querySelectorAll(TEAMS_QUOTE_SEL).forEach((n) => {
      if (!n.parentNode) return;
      const raw = (n.textContent || '').trim();
      if (!raw) { n.remove(); return; }
      const quoted = raw.split(/\r?\n/).map((l) => '> ' + l.trim()).filter((l) => l !== '> ').join('\n');
      n.replaceWith(document.createTextNode('\n' + quoted + '\n'));
    });

    return (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- findChatPane / scrapeChat: read the current Teams chat ----------
  function findChatPane() {
    // Real Teams DOM: the scrollable wrapper is message-pane-list-viewport,
    // which contains message-pane-list-runway, which contains chat-pane-item
    // entries (one per message — some nested as inner wrappers, filter by the
    // fui-unstable-ChatItem class to get just the outer ones).
    return (
      document.querySelector('[data-tid="message-pane-list-runway"]') ||
      document.querySelector('[data-tid="message-pane-list-viewport"]') ||
      document.querySelector('[role="log"]')
    );
  }

  function findChatItems(pane) {
    return Array.from(pane.querySelectorAll('[data-tid="chat-pane-item"]'))
      .filter((el) => el.classList.contains('fui-unstable-ChatItem'));
  }

  function findChatLabel() {
    const labelEl =
      document.querySelector('[data-tid="chat-title"]') ||
      document.querySelector('[data-tid="chat-title-name-group-chat"]') ||
      document.querySelector('[role="heading"][aria-level="1"]');
    return (labelEl?.innerText || '').trim() || 'Chat';
  }

  function scrapeChat(maxMessages) {
    const pane = findChatPane();
    if (!pane) {
      return { error: 'Teams chat pane not found. Open a chat in Teams first.' };
    }
    const items = findChatItems(pane);
    const messages = [];
    let lastAuthor = '';
    for (const item of items) {
      const authorEl = item.querySelector('[data-tid="message-author-name"]');
      const bodyEl = item.querySelector('[data-tid="chat-pane-message"]');
      const tsEl =
        item.querySelector('[data-tid="message-timestamp"]') ||
        item.querySelector('time');
      if (!bodyEl) continue;

      const author = (authorEl?.innerText || '').trim();
      if (author) lastAuthor = author;

      // Teams renders "You" / "Me" for the signed-in user's messages using the
      // fui-ChatMyMessage__body class — use that as a hint when the author
      // element is missing.
      const isSelf = bodyEl.classList.contains('fui-ChatMyMessage__body') ||
                     !!bodyEl.closest('.fui-ChatMyMessage__body');
      const resolvedAuthor = author || (isSelf ? 'Me' : lastAuthor) || 'unknown';

      const ts =
        tsEl?.getAttribute('datetime') ||
        tsEl?.getAttribute('title') ||
        tsEl?.getAttribute('aria-label') ||
        (tsEl?.innerText || '').trim();

      messages.push({
        author: resolvedAuthor,
        ts,
        text: teamsToMarkdown(bodyEl),
      });
    }
    if (messages.length === 0) {
      return { error: 'Chat pane open but no messages extracted. Selectors may need updating.' };
    }
    const tail = messages.slice(-(maxMessages || 20));
    return {
      mode: 'chat',
      id: location.hash || location.pathname,
      label: findChatLabel(),
      messages: tail,
      count: tail.length,
    };
  }

  // ---------- pasteDraft: drop generated text into the CKEditor composer ----------
  function findComposer() {
    // Teams' composer is CKEditor 5 — target the ckeditor data-tid first so we
    // don't accidentally match search boxes or other contenteditables.
    const selectors = ['[data-tid="ckeditor"]', 'div[role="textbox"][contenteditable="true"]'];
    for (const sel of selectors) {
      for (const box of document.querySelectorAll(sel)) {
        if (box.offsetParent !== null) return box;
      }
    }
    return null;
  }

  async function pasteDraft(text) {
    const box = findComposer();
    if (!box) return { error: 'Teams composer not found. Make sure a chat is open.' };
    box.focus();

    // CKEditor 5 ignores execCommand('insertText'); its paste pipeline listens
    // for real ClipboardEvents with a DataTransfer payload. Synthesize that.
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      box.dispatchEvent(ev);
      if (ev.defaultPrevented) return { ok: true };
    } catch (e) {
      console.warn('[nuntius-ultimate] paste event failed:', e);
    }

    // Fallback: beforeinput + input events. Works with most contenteditable
    // editors that respect the Input Events Level 2 spec.
    try {
      const before = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
      });
      box.dispatchEvent(before);
      if (!before.defaultPrevented) {
        box.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: text,
          bubbles: true,
        }));
      }
    } catch (e) {
      return { error: `Paste failed: ${e.message}` };
    }

    // Verify something actually landed. If the editor is empty, drop the text
    // on the real system clipboard so the user can Cmd+V it themselves.
    const settled = (box.innerText || '').trim();
    if (!settled.includes(text.slice(0, 20))) {
      try {
        await navigator.clipboard.writeText(text);
        return { error: 'Teams rejected the synthetic paste — text copied to your clipboard instead. Press Cmd+V in the composer.' };
      } catch {
        return { error: 'Teams rejected the synthetic paste. Open the side panel console to grab the draft text.' };
      }
    }
    return { ok: true };
  }

  // ---------- message bus ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'host:probe') {
      sendResponse({ host: 'teams' });
      return;
    }
    if (msg?.type === 'scrape') {
      sendResponse(scrapeChat(msg.maxMessages));
      return;
    }
    if (msg?.type === 'paste') {
      pasteDraft(msg.text || '').then(sendResponse);
      return true;
    }
  });
})();
