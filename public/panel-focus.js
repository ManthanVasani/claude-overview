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

  window.OVPanelFocus = function (panel) {
    let opener = null;
    const holds = () => panel.contains(document.activeElement);
    function take() {
      const x = panel.querySelector('[data-close]');
      if (x) x.focus({ preventScroll: true });
    }
    // a held key repeats on Close once focus moves there
    panel.addEventListener('keydown', (e) => {
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
    });
    return {
      redraw(html) {
        const held = holds();
        const t = document.createElement('template');
        t.innerHTML = html;
        morph(panel, t.content);
        if (held && !holds()) take();
      },
      opened() {
        if (!byKeyboard()) { opener = null; return; }
        // the Enter that opened the panel would go on to press the Close button
        if (window.event.type === 'keydown') window.event.preventDefault();
        const from = document.activeElement;
        if (!panel.contains(from)) opener = from && from !== document.body ? finder(from) : null;
        // Close sits at the top
        panel.scrollTop = 0;
        take();
      },
      // its result runs after the panel hides, as a narrow window hides the alerts beside it
      closing(card) {
        if (!byKeyboard() || !holds()) return () => {};
        return () => {
          for (const el of [opener && opener(), card]) {
            if (!el) continue;
            el.focus({ preventScroll: true });
            if (document.activeElement === el) return;
          }
          if (holds()) document.activeElement.blur();
        };
      },
    };
  };
})();
