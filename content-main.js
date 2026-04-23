// MAIN-world content script: runs inside the host page's own JS context so
// our matchMedia patch is visible to Slack/Teams' theme-detection code.
//
// Trick: we override `window.matchMedia` for prefers-color-scheme queries so
// they honor `<html data-nuntius-theme>`. The isolated content script writes
// that attribute based on the user's Nuntius Ultimate setting. When the host
// app is set to "Sync with OS" / "Follow system" theme, it will track the
// attribute as if the OS flipped.

(() => {
  const origMatchMedia = window.matchMedia.bind(window);
  const tracked = new Set();

  function override() {
    const v = document.documentElement.getAttribute('data-nuntius-theme');
    if (v === 'dark' || v === 'light') return v;
    return null;
  }

  function resolveMatches(query, real) {
    const o = override();
    if (!o) return real.matches;
    // Match the override against the query's intent.
    if (/prefers-color-scheme:\s*dark/i.test(query)) return o === 'dark';
    if (/prefers-color-scheme:\s*light/i.test(query)) return o === 'light';
    return real.matches;
  }

  window.matchMedia = function (query) {
    const real = origMatchMedia(query);
    if (!/prefers-color-scheme/i.test(query)) return real;

    const wrapped = Object.create(MediaQueryList.prototype);
    const listeners = new Set();
    let onchangeFn = null;

    Object.defineProperty(wrapped, 'matches', {
      configurable: true,
      get() { return resolveMatches(query, real); },
    });
    Object.defineProperty(wrapped, 'media', {
      configurable: true,
      get() { return query; },
    });
    wrapped.addEventListener = (type, fn) => {
      if (type === 'change' && typeof fn === 'function') listeners.add(fn);
      else real.addEventListener?.(type, fn);
    };
    wrapped.removeEventListener = (type, fn) => {
      listeners.delete(fn);
      real.removeEventListener?.(type, fn);
    };
    Object.defineProperty(wrapped, 'onchange', {
      configurable: true,
      get() { return onchangeFn; },
      set(fn) { onchangeFn = typeof fn === 'function' ? fn : null; },
    });
    wrapped.dispatchEvent = (ev) => real.dispatchEvent?.(ev);

    tracked.add({
      notify() {
        const ev = { matches: resolveMatches(query, real), media: query };
        for (const l of listeners) { try { l(ev); } catch {} }
        if (onchangeFn) { try { onchangeFn(ev); } catch {} }
      },
    });
    return wrapped;
  };

  // Fire synthetic change events whenever the Nuntius theme attribute flips.
  const obs = new MutationObserver(() => {
    for (const t of tracked) t.notify();
  });
  obs.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-nuntius-theme'],
  });
})();
