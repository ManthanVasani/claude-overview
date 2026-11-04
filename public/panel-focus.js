(function () {
  'use strict';

  // a key press on a button reaches its handler as a click that counts no mouse presses
  function byKeyboard() {
    const e = window.event;
    return !!e && (e.type === 'keydown' || (e.type === 'click' && e.detail === 0));
  }

  // replacing a node loses the focus inside it
  function morph(el, next) {
    const have = Array.from(el.childNodes);
    const want = Array.from(next.childNodes);
    want.forEach((w, i) => {
      const h = have[i];
      if (!h) el.appendChild(w);
      else if (h.nodeName !== w.nodeName) el.replaceChild(w, h);
      else if (w.nodeType !== 1) {
        if (h.nodeValue !== w.nodeValue) h.nodeValue = w.nodeValue;
      } else {
        for (const a of Array.from(h.attributes)) if (!w.hasAttribute(a.name)) h.removeAttribute(a.name);
        for (const a of Array.from(w.attributes)) if (h.getAttribute(a.name) !== a.value) h.setAttribute(a.name, a.value);
        morph(h, w);
      }
    });
    have.slice(want.length).forEach((h) => el.removeChild(h));
  }

  // the side lists rebuild their rows while the panel is open
  function finder(el) {
    const scope = el.parentElement && el.parentElement.closest('[id]');
    const data = Array.from(el.attributes).filter((a) => a.name.indexOf('data-') === 0).map((a) => [a.name, a.value]);
    return () => {
      if (el.isConnected) return el;
      if (!scope || !data.length) return null;
      return Array.from(scope.querySelectorAll(el.nodeName)).find((c) => data.every(([k, v]) => c.getAttribute(k) === v)) || null;
    };
  }

  window.OVPanelFocus = function (panel, board) {
    let opener = null;
    let moved = false;
    const holds = () => panel.contains(document.activeElement);
    function take() {
      // Close sits at the top
      panel.scrollTop = 0;
      const x = panel.querySelector('[data-close]');
      if (x) x.focus({ preventScroll: true });
      moved = true;
    }
    // a held key repeats on wherever focus moved: Close, or the card or row that reopens the panel
    document.addEventListener('keydown', (e) => {
      if (!e.repeat) moved = false;
      else if (moved && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);
    return {
      redraw(html) {
        const held = holds();
        const t = document.createElement('template');
        t.innerHTML = html;
        morph(panel, t.content);
        if (!held || holds()) return false;
        take();
        // the caller must not scroll back to where the removed control was
        return true;
      },
      opened() {
        if (!byKeyboard()) { opener = null; return; }
        // the Enter that opened the panel would go on to press the Close button
        if (window.event.type === 'keydown') window.event.preventDefault();
        const from = document.activeElement;
        if (!panel.contains(from)) opener = from && from !== document.body ? finder(from) : null;
        take();
      },
      // its result runs after the panel hides, as a narrow window hides the alerts beside it
      closing(card) {
        const from = opener;
        opener = null;
        if (!byKeyboard() || !holds()) return () => {};
        return () => {
          moved = true;
          for (const el of [from && from(), card]) {
            if (!el) continue;
            // the board pans by transform, so focus must not scroll it
            el.focus({ preventScroll: board.contains(el) });
            if (document.activeElement === el) return;
          }
          if (holds()) document.activeElement.blur();
        };
      },
    };
  };
})();
