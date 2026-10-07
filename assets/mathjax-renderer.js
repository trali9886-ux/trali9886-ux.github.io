(() => {
  const mathPattern = /\\\(|\\\[|\\begin\{|\$\$?/;
  const inFlight = new WeakSet();
  let scheduled = false;

  function typesetVisibleMath() {
    const mathJax = window.MathJax;
    if (!mathJax || typeof mathJax.typesetPromise !== "function") return;
    const targets = Array.from(document.querySelectorAll(
      ".inline-question-text, .pdf-question .text-version, .options, .answer-solution-content"
    )).filter((element) => mathPattern.test(element.textContent || "") && !inFlight.has(element));
    if (!targets.length) return;

    targets.forEach((element) => inFlight.add(element));
    mathJax.typesetPromise(targets)
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
