const OWNER = 'trali9886-ux';
const REPO = 'trali9886-ux.github.io';
const BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

async function request(path, token, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || `GitHub returned HTTP ${response.status}`;
    const error = new Error(detail);
    error.status = response.status;
    throw error;
  }
  return data;
}

function decodeUtf8Base64(value) {
  const raw = atob(String(value).replace(/\s/g, ''));
  const bytes = Uint8Array.from(raw, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function getCatalog(token, refSha) {
  const path = `/contents/published-tests/catalog.json?ref=${encodeURIComponent(refSha)}`;
  try {
    const file = await request(path, token);
    const catalog = JSON.parse(decodeUtf8Base64(file.content || ''));
    if (catalog?.version !== 1 || !Array.isArray(catalog.tests)) throw new Error('The online test catalog has an unsupported format.');
    return catalog;
  } catch (error) {
    if (error.status === 404) return { version: 1, tests: [] };
    throw error;
  }
}

async function createBlob(token, content) {
  return request('/git/blobs', token, {
    method: 'POST',
    body: JSON.stringify({ content, encoding: 'utf-8' }),
  });
}

export async function publishTest(test, token, { includeQuestionPaper = false, onProgress = () => {} } = {}) {
  if (!token || !/^github_pat_[A-Za-z0-9_]+$/.test(token) && !/^gh[pousr]_[A-Za-z0-9_]+$/.test(token)) {
    throw new Error('Enter a fine-grained GitHub token with Contents read/write access for this repository.');
  }
  if (!test?.id || !Array.isArray(test.questions) || !test.questions.length) throw new Error('Select and validate a test before publishing.');
  const ref = await request(`/git/ref/heads/${BRANCH}`, token);
  const parentSha = ref.object?.sha;
  if (!parentSha) throw new Error('Could not find the Pages branch.');
  const parent = await request(`/git/commits/${parentSha}`, token);
  const catalog = await getCatalog(token, parentSha);
  const existingIndex = catalog.tests.findIndex(entry => entry.id === test.id);
  if (existingIndex >= 0 && !window.confirm(`“${catalog.tests[existingIndex].name || test.id}” is already published. Replace its test data?`)) {
    throw new Error('Publishing cancelled.');
  }

  const published = structuredClone(test);
  published.draft = false;
  published.paperData = includeQuestionPaper ? published.paperData || '' : '';
  delete published.answerKeyData;
  delete published.solutionPdfData;
  delete published.localOnly;
  const testPath = `published-tests/${test.id}.json`;
  const entry = {
    id: test.id,
    name: test.name,
    category: test.category,
    date: test.date || '',
    path: testPath,
    questions: test.questions.length,
    updatedAt: new Date().toISOString(),
  };
  if (existingIndex >= 0) catalog.tests[existingIndex] = entry;
  else catalog.tests.push(entry);
  const testText = JSON.stringify({ format: 'rks-jee-published-test', version: 1, test: published });
  const catalogText = JSON.stringify(catalog, null, 2);
  const totalBytes = new TextEncoder().encode(testText).byteLength + new TextEncoder().encode(catalogText).byteLength;
  if (totalBytes > 90 * 1024 * 1024) throw new Error('This test package is over the GitHub file limit. Reduce the embedded question/solution images.');

  onProgress('Uploading the test and catalog…');
  const [testBlob, catalogBlob] = await Promise.all([
    createBlob(token, testText),
    createBlob(token, catalogText),
  ]);
  onProgress('Preparing an atomic website update…');
  const tree = await request('/git/trees', token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: parent.tree.sha,
      tree: [
        { path: testPath, mode: '100644', type: 'blob', sha: testBlob.sha },
        { path: 'published-tests/catalog.json', mode: '100644', type: 'blob', sha: catalogBlob.sha },
      ],
    }),
  });
  const commit = await request('/git/commits', token, {
    method: 'POST',
    body: JSON.stringify({
      message: `Publish JEE test: ${String(test.name).slice(0, 100)}`,
      tree: tree.sha,
      parents: [parentSha],
    }),
  });
  onProgress('Updating the live student-site source…');
  await request(`/git/refs/heads/${BRANCH}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return {
    commit: commit.sha,
    url: `https://${OWNER}.github.io/rks-mango-alien-testseries/`,
    testUrl: `https://${OWNER}.github.io/${testPath}`,
    bytes: totalBytes,
  };
}
