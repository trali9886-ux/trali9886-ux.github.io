(() => {
  // Mobile Navigation
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

  // Reading / Scroll Progress Bar
  const scrollProgress = document.getElementById('scroll-progress');
  if (scrollProgress) {
    const updateProgress = () => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const docHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      if (docHeight > 0) {
        const percent = Math.min(100, Math.max(0, (scrollTop / docHeight) * 100));
        scrollProgress.style.width = `${percent}%`;
      }
    };
    window.addEventListener('scroll', updateProgress, { passive: true });
    updateProgress();
  }

  // Smooth Scroll Reveal with Staggering
  const revealItems = document.querySelectorAll('.reveal');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!('IntersectionObserver' in window) || reducedMotion) {
    revealItems.forEach(item => item.classList.add('is-visible'));
  } else {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -30px 0px' });
    revealItems.forEach(item => observer.observe(item));
  }

  // Interactive 3D Parallax on Hero Deck
  const hero = document.querySelector('.hero');
  const heroArt = document.querySelector('.hero-art');
  if (hero && heroArt && !reducedMotion) {
    const paper = heroArt.querySelector('.art-paper');
    const score = heroArt.querySelector('.art-score');
    const timer = heroArt.querySelector('.badge-timer');
    const subject = heroArt.querySelector('.badge-subject');
    const sparks = heroArt.querySelectorAll('.art-spark');

    let mouseX = 0;
    let mouseY = 0;
    let currentX = 0;
    let currentY = 0;
    let isInteracting = false;
    let rafId = null;

    const onPointerMove = (e) => {
      const rect = hero.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const x = (clientX - rect.left) / rect.width - 0.5;
      const y = (clientY - rect.top) / rect.height - 0.5;
      mouseX = Math.max(-1, Math.min(1, x * 2));
      mouseY = Math.max(-1, Math.min(1, y * 2));
      isInteracting = true;
      if (!rafId) rafId = requestAnimationFrame(animateDeck);
    };

    const onPointerLeave = () => {
      mouseX = 0;
      mouseY = 0;
      isInteracting = false;
    };

    const animateDeck = () => {
      currentX += (mouseX - currentX) * 0.08;
      currentY += (mouseY - currentY) * 0.08;

      if (paper) {
        paper.style.transform = `rotate(-5deg) translate3d(${currentX * -14}px, ${currentY * -12}px, 0)`;
      }
      if (score) {
        score.style.transform = `rotate(4deg) translate3d(${currentX * 16}px, ${currentY * 14}px, 0)`;
      }
      if (timer) {
        timer.style.transform = `translate3d(${currentX * 20}px, ${currentY * -10}px, 0)`;
      }
      if (subject) {
        subject.style.transform = `translate3d(${currentX * -18}px, ${currentY * 16}px, 0)`;
      }
      sparks.forEach((spark, index) => {
        const factor = (index + 1) * 8;
        spark.style.transform = `translate3d(${currentX * factor}px, ${currentY * factor}px, 0)`;
      });

      if (Math.abs(mouseX - currentX) > 0.001 || Math.abs(mouseY - currentY) > 0.001 || isInteracting) {
        rafId = requestAnimationFrame(animateDeck);
      } else {
        rafId = null;
        if (paper) paper.style.transform = '';
        if (score) score.style.transform = '';
        if (timer) timer.style.transform = '';
        if (subject) subject.style.transform = '';
        sparks.forEach(s => s.style.transform = '');
      }
    };

    hero.addEventListener('mousemove', onPointerMove, { passive: true });
    hero.addEventListener('mouseleave', onPointerLeave, { passive: true });
    hero.addEventListener('touchmove', onPointerMove, { passive: true });
    hero.addEventListener('touchend', onPointerLeave, { passive: true });
  }

  // 3D Card Hover Tilt Micro-Interactions
  if (!reducedMotion && window.matchMedia('(hover: hover)').matches) {
    const tiltCards = document.querySelectorAll('.feature-card, .series-card, .contact-card');
    tiltCards.forEach(card => {
      card.addEventListener('mousemove', (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const rotateX = ((y - centerY) / centerY) * -4;
        const rotateY = ((x - centerX) / centerX) * 4;
        card.style.transform = `perspective(900px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-6px)`;
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = '';
      });
    });
  }

  // Catalog loading and stat count-up animation
  loadPublishedTests().then(animateCatalogStats);

  function animateCatalogStats() {
    const stats = ['live-test-count', 'live-question-count', 'live-subject-count']
      .map(id => document.getElementById(id))
      .filter(Boolean);
    if (!stats.length) return;

    if (reducedMotion || !('IntersectionObserver' in window)) {
      stats.forEach(node => node.classList.add('counted'));
      return;
    }

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const node = entry.target;
        const target = Number(node.textContent) || 0;
        const started = performance.now();
        const duration = 1100;

        const tick = now => {
          const progress = Math.min(1, (now - started) / duration);
          // Smooth cubic-out easing with subtle bounce
          const eased = 1 - Math.pow(1 - progress, 3);
          node.textContent = String(Math.round(target * eased));
          if (progress < 1) {
            requestAnimationFrame(tick);
          } else {
            node.textContent = String(target);
            node.classList.add('counted');
          }
        };
        requestAnimationFrame(tick);
        observer.unobserve(node);
      });
    }, { threshold: 0.5 });

    stats.forEach(node => observer.observe(node));
  }

  async function loadPublishedTests() {
    const root = document.getElementById('published-test-list');
    if (!root) return;
    try {
      const response = await fetch('/published-tests/catalog.json', { cache: 'no-store' });
      if (!response.ok) return;
      const catalog = await response.json();
      const tests = Array.isArray(catalog?.tests) ? catalog.tests : [];
      if (!tests.length) return;

      const totalQuestions = tests.reduce((sum, test) => sum + (Number(test.questions) || 0), 0);
      const count = document.getElementById('live-test-count');
      const questions = document.getElementById('live-question-count');
      if (count) count.textContent = String((Number(count.textContent) || 0) + tests.length);
      if (questions) questions.textContent = String((Number(questions.textContent) || 0) + totalQuestions);

      root.innerHTML = '<h3 class="published-heading">Newly published tests</h3><div class="published-cards"></div>';
      const cards = root.querySelector('.published-cards');
      for (let i = 0; i < tests.length; i++) {
        const test = tests[i];
        if (!test || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(String(test.id || ''))) continue;

        const card = document.createElement('a');
        card.className = 'published-card reveal is-visible';
        card.style.animationDelay = `${(i % 6) * 0.08}s`;
        const testCat = encodeURIComponent(test.category || 'practice');
        const testId = encodeURIComponent(test.id);
        card.href = `/?category=${testCat}&test=${testId}`;

        const label = document.createElement('span');
        label.className = 'series-label';
        label.textContent = String(test.category || 'PRACTICE').replace(/[-_]/g, ' ').toUpperCase();

        const title = document.createElement('h3');
        title.textContent = test.name || test.id;

        const description = document.createElement('p');
        description.textContent = `${Number(test.questions) || 0} questions${test.date ? ` · ${test.date}` : ''}`;

        const action = document.createElement('span');
        action.className = 'published-action';
        action.textContent = 'Open test ↗';

        card.append(label, title, description, action);
        cards.append(card);
      }
    } catch (_) {
      // Graceful fallback if catalog is unavailable
    }
  }
})();
