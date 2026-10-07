// GitHub Pages publishing bridge for the former Netlify editor workflow.
(() => {
  const owner = 'trali9886-ux', repo = 'trali9886-ux.github.io', branch = 'main';
  const api = 'https://api.github.com/repos/' + owner + '/' + repo;
  let token = '';
  const drafts = new Map();
  async function request(path, options = {}) {
    const response = await fetch(api + path, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'GitHub returned HTTP ' + response.status);
    return data;
  }
  function decode(value) {
    const binary = atob(String(value || '').replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
  }
  function encode(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  }
  function slug(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 58) || 'jee-test-' + Date.now();
  }
  async function branchState() {
    const ref = await request('/git/ref/heads/' + branch), sha = ref.object && ref.object.sha;
    if (!sha) throw new Error('Could not find the ' + branch + ' branch.');
    const commit = await request('/git/commits/' + sha);
    return { sha, tree: commit.tree && commit.tree.sha };
  }
  async function getCatalog(ref) {
    try {
      const file = await request('/contents/published-tests/catalog.json?ref=' + encodeURIComponent(ref));
      const catalog = JSON.parse(decode(file.content));
      if (catalog.version !== 1 || !Array.isArray(catalog.tests)) throw new Error('The online test catalog has an unsupported format.');
      return catalog;
    } catch (error) {
      if (/HTTP 404|Not Found/i.test(error.message)) return { version: 1, tests: [] };
      throw error;
    }
  }
  async function onlineCatalog() {
    const state = await branchState();
    return { state, catalog: await getCatalog(state.sha) };
  }
  async function readTest(entry, ref) {
    const path = entry.path || 'published-tests/' + entry.id + '.json';
    const file = await request('/contents/' + path + '?ref=' + encodeURIComponent(ref));
    let encoded = file.content || '';
    if (!encoded && file.sha) {
      const blob = await request('/git/blobs/' + file.sha);
      encoded = blob.content || '';
    }
    if (!encoded) throw new Error('GitHub returned no test data for ' + entry.id + '.');
    const wrapper = JSON.parse(decode(encoded));
    return wrapper.format === 'rks-jee-published-test' ? wrapper.test : wrapper;
  }
  async function blob(content, encoding) {
    return request('/git/blobs', { method: 'POST', body: JSON.stringify({ content, encoding: encoding || 'utf-8' }) });
  }
  async function commitFiles(message, files) {
    const state = await branchState();
    const entries = await Promise.all(files.map(async file => {
      const item = await blob(file.content, file.encoding);
      return { path: file.path, mode: '100644', type: 'blob', sha: item.sha };
    }));
    const tree = await request('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: state.tree, tree: entries }) });
    const commit = await request('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [state.sha] }) });
    await request('/git/refs/heads/' + branch, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) });
    return commit.sha;
  }
  function params(extra) { return new URLSearchParams(String(extra || '').replace(/^&/, '')); }
  async function publish(payload, id) {
    const draft = drafts.get(id);
    if (!draft) throw new Error('This upload expired. Start the test upload again.');
    const stateAndCatalog = await onlineCatalog(), catalog = stateAndCatalog.catalog;
    const oldIndex = catalog.tests.findIndex(item => item.id === id);
    if (oldIndex >= 0 && !window.confirm('Replace the already published test “' + (catalog.tests[oldIndex].name || id) + '”?')) throw new Error('Publishing cancelled.');
    const files = [], imageByQuestion = new Map();
    for (const [number, image] of draft.questions) {
      const path = 'tests/' + id + '/questions/' + number + '.webp';
      imageByQuestion.set(Number(number), '/' + path);
      files.push({ path, content: encode(new Uint8Array(await image.arrayBuffer())), encoding: 'base64' });
    }
    const solutionByQuestion = new Map();
    for (const [number, image] of draft.solutions) {
      const path = 'tests/' + id + '/solutions/' + number + '.webp';
      solutionByQuestion.set(Number(number), '/' + path);
      files.push({ path, content: encode(new Uint8Array(await image.arrayBuffer())), encoding: 'base64' });
    }
    const questions = (payload.questions || []).map((q, index) => {
      const number = Number(q.id || index + 1), image = imageByQuestion.get(number) || '';
      const solutionImage = solutionByQuestion.get(number) || '';
      const type = ['mcq', 'multi', 'integer', 'decimal'].includes(q.type) ? q.type : 'mcq';
      return {
        id: number, sourceQuestionNo: number, subject: q.subject, type,
        section: q.section || (type === 'integer' || type === 'decimal' ? 'Numerical' : 'MCQ'),
        text: 'Question ' + number + '. Read the complete question and options in the supplied question image.',
        ...(type === 'mcq' || type === 'multi' ? { options: ['A', 'B', 'C', 'D'] } : {}),
        answer: String(q.answer == null ? '' : q.answer),
        solution: solutionImage ? 'Worked explanation from the uploaded solution PDF.' : String(q.solution || 'No worked explanation was supplied with this editor upload.'),
        ...(solutionImage ? { solutionImage } : {}),
        image, maxMarks: Number(q.maxMarks) || 4, negativeMarks: Number(q.negativeMarks) || 0,
        unansweredMarks: 0, chapter: q.chapter || '', topic: q.topic || '',
      };
    });
    if (!questions.length || questions.some(q => !q.image)) throw new Error('A question image is missing. Re-import the PDF and review every question image.');
    const paper = draft.assets.get('paper');
    const test = {
      id, slug: slug(payload.name || draft.name), name: String(payload.name || draft.name || id),
      category: draft.category || 'rts', ...(draft.phase ? { phase: draft.phase } : {}), exam: draft.advanced ? 'JEE Advanced' : 'JEE Main',
      date: String(payload.date || draft.date || ''), durationSeconds: 10800,
      expectedQuestionCount: questions.length, maxMarks: questions.reduce((sum, q) => sum + q.maxMarks, 0),
      defaultMarks: { correct: 4, incorrect: 1, unanswered: 0 },
      instructions: 'Read each question and its options in the supplied question image. Correct and negative marks are shown for each question.',
      syllabus: payload.syllabus || {},
      paperData: paper ? 'data:application/pdf;base64,' + encode(new Uint8Array(await paper.arrayBuffer())) : '',
      questions, ownerFormat: 1, revision: 1, draft: false,
    };
    const entry = { id, name: test.name, category: test.category, ...(test.phase ? { phase: test.phase } : {}), date: test.date, path: 'published-tests/' + id + '.json', questions: questions.length, updatedAt: new Date().toISOString() };
    if (oldIndex >= 0) catalog.tests[oldIndex] = entry; else catalog.tests.push(entry);
    const afterId = draft.afterId;
    if (afterId === 'first' || (afterId && afterId !== 'end')) {
      const index = catalog.tests.findIndex(item => item.id === id), item = catalog.tests.splice(index, 1)[0];
      const after = afterId === 'first' ? -1 : catalog.tests.findIndex(other => other.id === afterId);
      catalog.tests.splice(after < 0 ? 0 : after + 1, 0, item);
    }
    files.push({ path: entry.path, content: JSON.stringify({ format: 'rks-jee-published-test', version: 1, test }) });
    files.push({ path: 'published-tests/catalog.json', content: JSON.stringify(catalog, null, 2) });
    if (files.reduce((sum, file) => sum + file.content.length, 0) > 90 * 1024 * 1024) throw new Error('This test upload exceeds GitHub’s file size limit.');
    const sha = await commitFiles('Publish JEE test: ' + test.name.slice(0, 100), files);
    drafts.delete(id);
    return { id, name: test.name, commit: sha };
  }
  async function arrange(payload) {
    const { state, catalog } = await onlineCatalog(), entry = catalog.tests.find(item => item.id === payload.id);
    if (!entry) throw new Error('The selected test is not in the online catalog.');
    const test = await readTest(entry, state.sha);
    test.name = String(payload.name || test.name);
    const phase = payload.category === 'rts-phase-1' ? 'phase1' : payload.category === 'rts-phase-2' ? 'phase2' : '';
    test.category = phase ? 'rts' : (payload.category || test.category);
    if (phase) test.phase = phase; else delete test.phase;
    test.syllabus = payload.syllabus || test.syllabus || {};
    const index = catalog.tests.findIndex(item => item.id === payload.id), item = catalog.tests.splice(index, 1)[0];
    item.name = test.name; item.category = test.category; if (test.phase) item.phase = test.phase; else delete item.phase;
    let position;
    if (payload.afterId === 'first') { position = catalog.tests.findIndex(other => other.category === item.category); if (position < 0) position = 0; }
    else if (payload.afterId === 'end') { position = catalog.tests.map((other, i) => other.category === item.category ? i : -1).filter(i => i >= 0).at(-1); position = position < 0 ? catalog.tests.length : position + 1; }
    else { const after = catalog.tests.findIndex(other => other.id === payload.afterId); position = after < 0 ? catalog.tests.length : after + 1; }
    catalog.tests.splice(position, 0, item);
    const path = entry.path || 'published-tests/' + entry.id + '.json';
    const sha = await commitFiles('Update JEE test listing: ' + test.name.slice(0, 100), [
      { path, content: JSON.stringify({ format: 'rks-jee-published-test', version: 1, test }) },
      { path: 'published-tests/catalog.json', content: JSON.stringify(catalog, null, 2) },
    ]);
    return { catalog: catalog.tests, commit: sha };
  }
  window.LegacyGithubEditorTransport = async (action, options = {}, extra = '') => {
    if (action === 'status') return { authenticated: !!token, configured: true };
    if (action === 'login') {
      let body = {}; try { body = JSON.parse(options.body || '{}'); } catch {}
      const candidate = String(body.password || '').trim();
      if (!/^github_pat_[A-Za-z0-9_]+$/.test(candidate) && !/^gh[pousr]_[A-Za-z0-9_]+$/.test(candidate)) throw new Error('Enter a GitHub token with Contents read/write access to this repository.');
      token = candidate;
      try { await branchState(); } catch (error) { token = ''; throw new Error('GitHub token could not read this repository: ' + error.message); }
      return { authenticated: true };
    }
    if (action === 'logout') { token = ''; drafts.clear(); return { ok: true }; }
    if (!token) throw new Error('Sign in with your GitHub repository token first.');
    if (action === 'catalog') return (await onlineCatalog()).catalog.tests;
    if (action === 'start') {
      const body = JSON.parse(options.body || '{}'), phase = body.category === 'rts-phase-1' ? 'phase1' : body.category === 'rts-phase-2' ? 'phase2' : '', name = String(body.name || (phase ? 'RTS ' + (phase === 'phase1' ? 'Phase 1' : 'Phase 2') + ' ' + (body.paperNumber || 'Test') : body.category === 'rts' ? 'RTS ' + (body.paperNumber || 'Test') : 'JEE Main ' + (body.date || 'Practice Test'))).trim();
      let id = slug(name), { catalog } = await onlineCatalog();
      if (catalog.tests.some(item => item.id === id)) id = id.slice(0, 52) + '-' + Date.now().toString(36);
      drafts.set(id, { id, name, category: phase ? 'rts' : (body.category || 'rts'), ...(phase ? { phase } : {}), date: body.date || '', advanced: !!body.advanced, afterId: body.afterId || 'end', assets: new Map(), questions: new Map(), solutions: new Map() });
      return { id, name };
    }
    if (action === 'asset') {
      const query = params(extra), draft = drafts.get(query.get('id')), kind = query.get('kind'), number = Number(query.get('number') || 0);
      if (!draft) throw new Error('The test upload expired. Start the upload again.');
      const file = options.body;
      if (!file || !(file instanceof Blob)) {
        if (kind === 'key' || kind === 'paper') return { ok: true };
        throw new Error('The uploaded file could not be read.');
      }
      if (kind === 'question' && number > 0) draft.questions.set(number, file);
      else if (kind === 'solution' && number > 0) draft.solutions.set(number, file);
      else if (kind === 'paper' || kind === 'key') draft.assets.set(kind, file);
      else throw new Error('Unsupported upload type.');
      return { ok: true };
    }
    if (action === 'publish') return publish(JSON.parse(options.body || '{}'), params(extra).get('id'));
    if (action === 'arrange') return arrange(JSON.parse(options.body || '{}'));
    throw new Error('Unsupported editor action: ' + action);
  };
})();
