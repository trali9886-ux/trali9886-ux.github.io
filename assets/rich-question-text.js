/* Render question text that carries markup (SVG diagrams, HTML tables, LaTeX).
 *
 * The question bundle renders a question's `text` as a plain string, so any
 * `<svg>` or `<table>` it contains would show up as literal markup.  This
 * addon upgrades such a paragraph in place: the original text node is kept
 * (hidden) so React still owns it and can update it on the next question, and
 * a sibling element holds the parsed markup.  MathJax then typesets both.
 *
 * Content comes from the site's own published test files, so it is trusted;
 * scripts and event-handler attributes are stripped regardless, so a stray
 * one can never execute.
 */
(() => {
  const MARKUP = /<\s*(svg|table|br|b|i|u|strong|em|sub|sup|span|div|p|ul|ol|li|img)\b/i;
  const TEXT_SELECTOR = ".inline-question-text .question-text";
  const RICH_CLASS = "question-rich";
  const DONE = new WeakMap();
  const inFlight = new WeakSet();
  let scheduled = false;

  function sanitize(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    tpl.content.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((n) => n.remove());
    tpl.content.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on") || name === "srcdoc") el.removeAttribute(attr.name);
        else if ((name === "href" || name === "src") && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      }
    });
    return tpl.innerHTML;
  }

  function dropRich(p) {
    const host = p.parentElement;
    if (host) host.querySelectorAll(":scope > ." + RICH_CLASS).forEach((n) => n.remove());
    p.style.removeProperty("display");
    DONE.delete(p);
  }

  function enhance(p) {
    const html = p.textContent || "";
    const host = p.parentElement;
    if (!MARKUP.test(html)) {
      dropRich(p);
      return;
    }
    // The rich block lives as the last child of the React-managed wrapper,
    // past everything React itself renders, so React's reconciliation never
    // touches it.  It is rebuilt whenever the text changed or a re-render
    // removed it, and hidden text is re-checked so a stale block cannot linger.
    let rich = host && host.querySelector(":scope > ." + RICH_CLASS);
    if (DONE.get(p) === html && rich) return;
    DONE.set(p, html);
    p.style.display = "none";
    if (!host) return;
    if (!rich) {
      rich = document.createElement("div");
      rich.className = RICH_CLASS;
      host.appendChild(rich);
    }
    rich.innerHTML = sanitize(html);
  }

  function scan() {
    document.querySelectorAll(TEXT_SELECTOR).forEach((p) => {
      if (inFlight.has(p)) return;
      inFlight.add(p);
      try { enhance(p); } finally { inFlight.delete(p); }
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; scan(); });
  }

  function start() {
    const root = document.getElementById("root") || document.body;
    if (!root) return;
    new MutationObserver(schedule).observe(root, {
      childList: true, characterData: true, subtree: true,
    });
    schedule();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
