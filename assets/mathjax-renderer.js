(() => {
  const mathPattern = /\\\(|\\\[|\\begin\{|\$\$?/;
  const targetsSelector =
    ".inline-question-text, .pdf-question .text-version, .options, .answer-solution-content";
  const inFlight = new WeakSet();
  // The text each target held when MathJax last typeset it.
  const typesetText = new WeakMap();
  let scheduled = false;

  // Everything outside the <mjx-container> nodes, i.e. the text React owns.
  // Read from the DOM rather than from MathJax's own bookkeeping so it stays
  // true even after a re-render.
  function liveText(element) {
    let text = "";
    (function walk(nodes) {
      for (const node of nodes) {
        if (node.nodeType === 3) text += node.nodeValue;
        else if (node.nodeType === 1 && node.tagName.toLowerCase() !== "mjx-container") {
          walk(node.childNodes);
        }
      }
    })(element.childNodes);
    return text;
  }

  // React owns these containers, but the <mjx-container> nodes MathJax injects
  // are invisible to React's reconciler: it rewrites the text and leaves the
  // previous formula sitting next to it.  That is how the answer line comes to
  // read "C — 5.06 J2 tan ϕ ½" — the question's own answer plus a formula from
  // whatever question was on screen before.  A target whose text no longer
  // matches what we typeset has stale output, and it has to go first, or the
  // re-typeset would run alongside it and compound the mess.
  function dropStaleOutput(element) {
    if (typesetText.get(element) === liveText(element)) return;
    for (const node of element.querySelectorAll("mjx-container")) node.remove();
  }

  function typesetVisibleMath() {
    const mathJax = window.MathJax;
    if (!mathJax || typeof mathJax.typesetPromise !== "function") return;
    const candidates = Array.from(document.querySelectorAll(targetsSelector));
    for (const element of candidates) {
      if (!inFlight.has(element)) dropStaleOutput(element);
    }
    const targets = candidates.filter(
      (element) => mathPattern.test(element.textContent || "") && !inFlight.has(element)
    );
    if (!targets.length) return;

    targets.forEach((element) => inFlight.add(element));
    mathJax.typesetPromise(targets)
      .then(() => {
        for (const element of targets) typesetText.set(element, liveText(element));
      })
      .catch(() => {})
      .finally(() => targets.forEach((element) => inFlight.delete(element)));
  }

  function scheduleTypeset() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      typesetVisibleMath();
    });
  }

  function start() {
    const root = document.getElementById("root") || document.body;
    if (!root) return;
    new MutationObserver(scheduleTypeset).observe(root, {
      childList: true,
      characterData: true,
      subtree: true
    });
    scheduleTypeset();
    document.getElementById("mathjax-library")?.addEventListener("load", scheduleTypeset);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
