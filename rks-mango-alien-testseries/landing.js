(() => {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.primary-nav');
  if (toggle && nav) {
    const close = () => {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
      nav.classList.remove('is-open');
    };
    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
      nav.classList.toggle('is-open', open);
    });
    nav.addEventListener('click', event => { if (event.target.closest('a')) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    document.addEventListener('click', event => {
      if (!nav.contains(event.target) && !toggle.contains(event.target)) close();
    });
  }
  const items = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    items.forEach(item => item.classList.add('is-visible'));
  } else {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
    }), { threshold: 0.12, rootMargin: '0px 0px -24px 0px' });
    items.forEach(item => observer.observe(item));
  }
  loadPublishedTests();
  async function loadPublishedTests() {
    const root = document.getElementById('published-test-list');
    if (!root) return;
    try {
      // Published JSON is kept at the student app's shared catalog path. This
      // landing page and the CBT therefore display the same live test list.
      const response = await fetch('/published-tests/catalog.json', { cache: 'no-store' });
      if (!response.ok) return;
      const catalog = await response.json();
      const tests = Array.isArray(catalog?.tests) ? catalog.tests : [];
      if (!tests.length) return;
      const totalQuestions = tests.reduce((sum, test) => sum + (Number(test.questions) || 0), 0);
      const count = document.getElementById('live-test-count');
      const questions = document.getElementById('live-question-count');
      if (count) count.textContent = String(7 + tests.length);
      if (questions) questions.textContent = String(498 + totalQuestions);
      root.innerHTML = '<h3 class="published-heading">Newly published tests</h3><div class="published-cards"></div>';
      const cards = root.querySelector('.published-cards');
      for (const test of tests) {
        if (!test || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(String(test.id || ''))) continue;
        const card = document.createElement('a');
        card.className = 'published-card';
        card.href = '/';
        const label = document.createElement('span');
        label.className = 'series-label';
        label.textContent = String(test.category || 'PRACTICE').replace(/[-_]/g, ' ').toUpperCase();
        const title = document.createElement('h3');
        title.textContent = test.name || test.id;
        const description = document.createElement('p');
        description.textContent = `${Number(test.questions) || 0} questions${test.date ? ` · ${test.date}` : ''}`;
        const action = document.createElement('span');
        action.className = 'published-action';
        action.textContent = 'Open test series ↗';
        card.append(label, title, description, action);
        cards.append(card);
      }
    } catch (_) {
      // Keep the curated landing page usable if the catalog is unavailable.
    }
  }
})();
