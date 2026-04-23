// Content script: lives inside app.slack.com and handles DOM scraping, composer
// focus, paste, and voice-sample harvesting on request from the side panel.
// Also mirrors the user's Nuntius Ultimate theme choice to a DOM attribute so
// the MAIN-world matchMedia patch can spoof prefers-color-scheme for Slack.

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

  // ---------- slackToMarkdown: Slack rich-text → markdown ----------
  function slackToMarkdown(el) {
    if (!el) return '';
    const root = el.cloneNode(true);

    // Fenced code blocks first — preserve their content verbatim and detach
    // them before other handlers can mangle their contents.
    root.querySelectorAll('pre, .p-rich_text_preformatted, .c-mrkdwn__pre').forEach((n) => {
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
    root.querySelectorAll('blockquote').forEach((n) => {
      if (!n.parentNode) return;
      const body = (n.textContent || '').trim().split('\n').map((l) => '> ' + l).join('\n');
      n.replaceWith(document.createTextNode('\n' + body + '\n'));
    });
    root.querySelectorAll('ol').forEach((ol) => {
      ol.querySelectorAll(':scope > li').forEach((li, i) => {
        li.insertBefore(document.createTextNode(`${i + 1}. `), li.firstChild);
      });
    });
    root.querySelectorAll('ul > li').forEach((li) => {
      li.insertBefore(document.createTextNode('- '), li.firstChild);
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
    // Emoji / inline images — keep alt text so the model sees ":smile:" etc.
    root.querySelectorAll('img[alt]').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode(n.getAttribute('alt') || ''));
    });

    return (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------- pane finders ----------
  function findThreadPane() {
    return (
      document.querySelector('[data-qa="threads_flexpane"]') ||
      document.querySelector('.p-threads_flexpane') ||
      document.querySelector('[aria-label="Thread"]')
    );
  }

  function findChatPane() {
    return (
      document.querySelector('[data-qa="message_pane"]') ||
      document.querySelector('.p-message_pane')
    );
  }

  function itemsIn(pane) {
    if (!pane) return [];
    const listItems = pane.querySelectorAll('[role="listitem"]');
    if (listItems.length > 0) return listItems;
    return pane.querySelectorAll('.c-virtual_list__item');
  }

  // ---------- identity: what's currently active, and has it changed? ----------
  function currentIdentity() {
    const urlMatch = location.pathname.match(/\/thread\/([^/?#]+)/);
    const threadPane = findThreadPane();
    if (urlMatch || threadPane) {
      const items = threadPane ? itemsIn(threadPane) : [];
      const last = items[items.length - 1];
      return {
        mode: 'thread',
        id: urlMatch ? urlMatch[1] : 'pane-only',
        count: items.length,
        lastTs: last?.getAttribute('data-item-key') || last?.id || '',
      };
    }
    const chatMatch = location.pathname.match(/\/client\/[^/]+\/([^/?#]+)/);
    const messagePane = findChatPane();
    if (chatMatch && messagePane) {
      const items = itemsIn(messagePane);
      const last = items[items.length - 1];
      return {
        mode: 'chat',
        id: chatMatch[1],
        count: items.length,
        lastTs: last?.getAttribute('data-item-key') || last?.id || '',
      };
    }
    return null;
  }

  // ---------- scrapers ----------
  function scrapeItems(pane) {
    const messages = [];
    let lastAuthor = '';
    for (const item of itemsIn(pane)) {
      const authorEl =
        item.querySelector('[data-qa="message_sender_name"]') ||
        item.querySelector('.c-message_kit__sender') ||
        item.querySelector('[data-qa="message_sender"]');

      const bodyEl =
        item.querySelector('[data-qa="message-text"]') ||
        item.querySelector('.c-message_kit__blocks') ||
        item.querySelector('.p-rich_text_section');

      const tsEl =
        item.querySelector('.c-timestamp') ||
        item.querySelector('[data-qa="timestamp"]');

      if (!bodyEl) continue;

      const author = (authorEl?.innerText || '').trim();
      if (author) lastAuthor = author;

      messages.push({
        author: author || lastAuthor,
        ts:
          tsEl?.getAttribute('data-ts') ||
          tsEl?.getAttribute('aria-label') ||
          (tsEl?.innerText || '').trim(),
        text: slackToMarkdown(bodyEl),
      });
    }
    return messages;
  }

  function channelLabel() {
    const labelEl =
      document.querySelector('[data-qa="channel_name_header"]') ||
      document.querySelector('[data-qa="channel_name"]') ||
      document.querySelector('.p-view_header__channel_title') ||
      document.querySelector('.p-view_header__text');
    return (labelEl?.innerText || '').trim() || 'Chat';
  }

  function scrapeThread() {
    const pane = findThreadPane();
    if (!pane) {
      return {
        error:
          'No thread pane open. In Slack, click a message and choose "Reply in thread" so the thread pane is visible.',
      };
    }
    const messages = scrapeItems(pane);
    if (messages.length === 0) {
      return { error: 'Thread pane is open but no messages were extracted. Selectors may need updating.' };
    }
    const id = currentIdentity();
    return {
      mode: 'thread',
      id: id?.id || 'pane-only',
      label: 'Thread',
      messages,
      count: messages.length,
    };
  }

  function scrapeChat(maxMessages) {
    const pane = findChatPane();
    if (!pane) {
      return { error: 'Channel/DM message pane not found.' };
    }
    const messages = scrapeItems(pane);
    if (messages.length === 0) {
      return { error: 'Message pane open but no messages extracted.' };
    }
    const cap = Math.max(1, Math.min(200, maxMessages || 20));
    const tail = messages.slice(-cap);
    const id = currentIdentity();
    return {
      mode: 'chat',
      id: id?.id || '',
      label: channelLabel(),
      messages: tail,
      count: tail.length,
    };
  }

  // Dispatch: pick thread scrape if a thread pane is open, otherwise channel/DM.
  function scrape(maxMessages) {
    const id = currentIdentity();
    if (!id) {
      return { error: 'No Slack thread, channel, or DM open.' };
    }
    return id.mode === 'thread' ? scrapeThread() : scrapeChat(maxMessages);
  }

  // ---------- composer focus + paste ----------
  function findReplyBox() {
    const pane = findThreadPane();
    if (!pane) return null;
    return (
      pane.querySelector('div[role="textbox"][aria-label^="Reply" i]') ||
      pane.querySelector('div[role="textbox"]') ||
      pane.querySelector('.ql-editor')
    );
  }

  function findChannelBox() {
    const threadPane = findThreadPane();
    const boxes = document.querySelectorAll('div[role="textbox"]');
    // Prefer a textbox whose aria-label starts with "Message " (Slack's convention
    // for channel/DM composers: "Message #general", "Message Alice", etc.).
    for (const box of boxes) {
      if (threadPane && threadPane.contains(box)) continue;
      if (box.offsetParent === null) continue;
      const aria = (box.getAttribute('aria-label') || '').toLowerCase();
      if (aria.startsWith('message ')) return box;
    }
    for (const box of boxes) {
      if (threadPane && threadPane.contains(box)) continue;
      if (box.offsetParent === null) continue;
      return box;
    }
    return null;
  }

  function findComposer(mode) {
    if (mode === 'thread') return findReplyBox();
    if (mode === 'chat') return findChannelBox();
    // Auto: whichever the current identity says.
    const id = currentIdentity();
    if (!id) return null;
    return id.mode === 'thread' ? findReplyBox() : findChannelBox();
  }

  async function pasteDraft(text, mode) {
    const box = findComposer(mode);
    if (!box) {
      return {
        error:
          mode === 'thread'
            ? 'Thread reply box not found — open a thread in Slack first.'
            : 'Slack composer not found. Make sure a channel, DM, or thread is open.',
      };
    }
    box.focus();

    // Slack's composer is Quill-based. Synthesized ClipboardEvents work in most
    // cases; fall back to beforeinput if not.
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
    // on the system clipboard so the user can Cmd+V it themselves.
    const settled = (box.innerText || '').trim();
    if (!settled.includes(text.slice(0, 20))) {
      try {
        await navigator.clipboard.writeText(text);
        return { error: 'Slack rejected the synthetic paste — text copied to your clipboard. Press Cmd+V in the composer.' };
      } catch {
        return { error: 'Slack rejected the synthetic paste. Open the side panel console to grab the draft text.' };
      }
    }
    return { ok: true };
  }

  // ---------- voice sample harvest (from Slack search results) ----------
  async function scrapeSearchResults() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const MAX_ITERATIONS = 12;
    const MAX_SAMPLES = 30;

    function items() {
      return document.querySelectorAll('[data-qa="search_result"], .c-search_message');
    }

    if (items().length === 0) {
      return {
        error:
          'No search results visible. In Slack, run a search (e.g., `from:@handle`) first, then try again.',
      };
    }

    function getScrollParent(el) {
      let p = el.parentElement;
      while (p) {
        const ov = getComputedStyle(p).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && p.scrollHeight > p.clientHeight) return p;
        p = p.parentElement;
      }
      return null;
    }

    const scrollContainer = getScrollParent(items()[0]) || document.scrollingElement || document.documentElement;
    const samples = [];
    const seen = new Set();

    function harvest() {
      for (const item of items()) {
        const bodyEl =
          item.querySelector('[data-qa="message-text"]') ||
          item.querySelector('.c-message_kit__blocks') ||
          item.querySelector('.p-rich_text_section');
        if (!bodyEl) continue;
        const text = (bodyEl.innerText || '').trim();
        if (text.length < 3) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        samples.push(text);
        if (samples.length >= MAX_SAMPLES) return;
      }
    }

    harvest();

    for (let i = 0; i < MAX_ITERATIONS && samples.length < MAX_SAMPLES; i++) {
      const before = samples.length;
      scrollContainer.scrollBy({ top: 1200 });
      await sleep(500);
      harvest();
      if (samples.length === before) break;
    }

    if (samples.length === 0) {
      return { error: 'Search results visible but no text extracted. Selectors may need updating.' };
    }
    return { samples, count: samples.length };
  }

  // ---------- message bus ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'host:probe') {
      sendResponse({ host: 'slack' });
      return;
    }
    if (msg?.type === 'scrape') {
      sendResponse(scrape(msg.maxMessages));
      return;
    }
    if (msg?.type === 'identity') {
      sendResponse(currentIdentity());
      return;
    }
    if (msg?.type === 'paste') {
      pasteDraft(msg.text || '', msg.mode).then(sendResponse);
      return true;
    }
    if (msg?.type === 'voice:scrape') {
      scrapeSearchResults().then(sendResponse);
      return true;
    }
  });
})();
