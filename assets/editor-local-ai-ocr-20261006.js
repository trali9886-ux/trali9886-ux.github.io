/* On-device OCR assist: split raster/scanned JEE PDFs and match numbered questions, answers, and solutions. */
(function () {
  let engine;
  let progress = () => {};
  const SCALE = 1.55;

  async function getWorker() {
    if (!engine) engine = (async () => {
      const mod = await import('/assets/tesseract/tesseract.esm.min.js');
      const createWorker = mod.createWorker || mod.default?.createWorker;
      if (!createWorker) throw new Error('On-device OCR could not start.');
      const worker = await createWorker('eng', 1, {
        workerPath: '/assets/tesseract/worker.min.js',
        corePath: '/assets/tesseract/core/',
        langPath: '/assets/tesseract/lang',
        gzip: true,
        logger: item => { if (item.status === 'recognizing text') progress(`Local AI OCR: ${Math.round((item.progress || 0) * 100)}%`); }
      });
      await worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })();
    try { return await engine; } catch (error) { engine = null; throw error; }
  }

  function parseRows(data) {
    let lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length) {
      for (const block of data.blocks || []) {
        for (const paragraph of block.paragraphs || []) {
          lines.push(...(paragraph.lines || []));
        }
      }
    }
    return lines.filter(line => String(line.text || '').trim()).map(line => {
      const bbox = line.bbox || {};
      const words = Array.isArray(line.words) ? line.words.map(w => ({
        text: String(w.text || '').trim(),
        x0: Number(w.bbox?.x0 || 0),
        y0: Number(w.bbox?.y0 || 0),
        x1: Number(w.bbox?.x1 || 0),
        y1: Number(w.bbox?.y1 || 0),
        confidence: Number(w.confidence || 0)
      })).filter(w => w.text) : [];
      return {
        text: String(line.text).replace(/[\u00a0\u2007\u202f]/g, ' ').trim(),
        x: Number(bbox.x0 || 0),
        y: Number(bbox.y0 || 0),
        right: Number(bbox.x1 || 0),
        bottom: Number(bbox.y1 || 0),
        confidence: Number(line.confidence || 0),
        words
      };
    });
  }

  async function scan(file, onProgress = () => {}, pageMode = '3', skipOcr = false) {
    progress = onProgress;
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('The PDF reader is not ready. Reload the editor and try again.');
    const worker = skipOcr ? null : await getWorker();
    if (worker) await worker.setParameters({ tessedit_pageseg_mode: pageMode });
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        progress(`Local AI scanning page ${number} of ${pdf.numPages}…`);
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: SCALE });
        const canvas = Object.assign(document.createElement('canvas'), {
          width: Math.ceil(viewport.width),
          height: Math.ceil(viewport.height)
        });
        await page.render({
          canvasContext: canvas.getContext('2d', { willReadFrequently: true }),
          viewport,
          canvas
        }).promise;

        let nativeText = '';
        try {
          const tc = await page.getTextContent();
          if (tc && tc.items && tc.items.length) {
            nativeText = tc.items.map(it => it.str).join(' ');
          }
        } catch (_) {}

        const result = worker ? await worker.recognize(canvas, {}, { blocks: true }) : null;
        let rows = result ? parseRows(result.data) : [];

        const W = canvas.width;
        const H = canvas.height;
        const gutterX = W * 0.5;

        // Filter out extreme page-edge border line noise (vertical borders at left/right edges)
        rows = rows.filter(r => !(r.x < W * 0.035 && r.right < W * 0.045 && (r.bottom - r.y) > 25 && /^[|Il!1:.]+$/.test(r.text)));
        rows = rows.filter(r => !(r.x > W * 0.955 && (r.bottom - r.y) > 25 && /^[|Il!1:.]+$/.test(r.text)));

        // Detect two-column layout
        const leftCount = rows.filter(r => r.x < gutterX - 40).length;
        const rightCount = rows.filter(r => r.right > gutterX + 40).length;
        const isTwoColumn = leftCount >= 4 && rightCount >= 4;

        // On two-column pages, split any lines spanning across the gutter
        const processedRows = [];
        for (const row of rows) {
          if (isTwoColumn && row.x < gutterX - 50 && row.right > gutterX + 50 && row.words.length >= 2) {
            const leftWords = row.words.filter(w => w.x1 < gutterX + 25);
            const rightWords = row.words.filter(w => w.x0 > gutterX - 25);
            if (leftWords.length) {
              processedRows.push({
                text: leftWords.map(w => w.text).join(' '),
                x: leftWords[0].x0,
                y: Math.min(...leftWords.map(w => w.y0)),
                right: leftWords[leftWords.length - 1].x1,
                bottom: Math.max(...leftWords.map(w => w.y1)),
                confidence: row.confidence,
                column: 0,
                words: leftWords
              });
            }
            if (rightWords.length) {
              processedRows.push({
                text: rightWords.map(w => w.text).join(' '),
                x: rightWords[0].x0,
                y: Math.min(...rightWords.map(w => w.y0)),
                right: rightWords[rightWords.length - 1].x1,
                bottom: Math.max(...rightWords.map(w => w.y1)),
                confidence: row.confidence,
                column: 1,
                words: rightWords
              });
            }
          } else {
            processedRows.push({
              ...row,
              column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0
            });
          }
        }

        const jpeg = await new Promise((resolve, reject) =>
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(`Could not render scanned PDF page ${number}.`)), 'image/jpeg', 0.86)
        );

        pages.push({
          page: number,
          width: canvas.width,
          height: canvas.height,
          rows: processedRows,
          isTwoColumn,
          gutterX,
          nativeText,
          jpeg
        });
        canvas.width = canvas.height = 1;
      }
      return { pdf, pages };
    } catch (error) {
      await pdf.cleanup();
      throw error;
    }
  }

  function matchQuestionMarker(row, pageNo, isTwoColumn, gutterX) {
    const raw = String(row.text || '').trim();
    const clean = raw.replace(/^[|Il!i:._\s\-]+/, '');

    // 1. Line starts with Q-prefix or Question number
    const startMatch = clean.match(/^(?:(?:SECTION\s*[-A-Z0-9]+\s+)|(?:PART\s*[-A-Z0-9]+\s+))?(?:Q(?:uestion|ue)?\.?\s*(?:No\.?\s*)?[:\-]?\s*)?(\d{1,3})[.):\]\-]?\s*(.*)$/i);
    if (startMatch) {
      const num = Number(startMatch[1]);
      if (num >= 1 && num <= 100) {
        return {
          ...row,
          number: num,
          page: pageNo,
          rest: (startMatch[2] || '').trim(),
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0
        };
      }
    }

    // 2. Embedded question marker inside line
    const embeddedMatch = clean.match(/(?:^|\s)(?:Q(?:uestion|ue)?\.?\s*)?(\d{1,2})[.)]\s+([A-Z][a-zA-Z]{1,}|If\b|Let\b|The\b|In\b|A\b|An\b|Two\b|Three\b|Four\b|Consider\b|Which\b|What\b|Find\b|Given\b|Potential\b|Initially\b|When\b|Under\b)/);
    if (embeddedMatch) {
      const num = Number(embeddedMatch[1]);
      if (num >= 1 && num <= 75) {
        const idx = clean.indexOf(embeddedMatch[0]);
        return {
          ...row,
          number: num,
          page: pageNo,
          rest: clean.slice(idx + embeddedMatch[0].length).trim(),
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0
        };
      }
    }

    return null;
  }

  function detectSubjectHeadings(pages) {
    const headings = [];
    for (const p of pages) {
      for (const r of p.rows) {
        const txt = String(r.text || '').toUpperCase();
        let sub = null;
        if (/\bPHYSICS\b/.test(txt)) sub = 'Physics';
        else if (/\bCHEMISTRY\b/.test(txt)) sub = 'Chemistry';
        else if (/\b(?:MATHEMATICS|MATHS)\b/.test(txt)) sub = 'Mathematics';
        if (sub) headings.push({ page: p.page, y: r.y, subject: sub });
      }
    }
    return headings;
  }

  function scoreQuestionMarker(m, targetNum, prevMarker, nextMarker) {
    let score = 50;
    const rest = String(m.rest || '');
    if (rest.length >= 10) score += 40;
    if (/(?:Let|If|The|Find|Which|What|Consider|Given|In\b|A\b|Two|Three)\s+[A-Za-z]/i.test(rest)) score += 30;
    if (/(?:Ans|Solution|Sol\.)/i.test(m.text)) score -= 60;
    if (m.confidence) score += Math.min(30, m.confidence / 3);

    // Sequence bonus
    if (prevMarker) {
      if (m.page > prevMarker.page) score += 30;
      else if (m.page === prevMarker.page) {
        if (m.column > prevMarker.column) score += 20;
        else if (m.column === prevMarker.column && m.y > prevMarker.y) score += 25;
      }
    }
    if (nextMarker) {
      if (m.page < nextMarker.page) score += 20;
      else if (m.page === nextMarker.page && m.y < nextMarker.y) score += 20;
    }
    return score;
  }

  function extractNumberedMarkers(pages, expected) {
    const subjects = detectSubjectHeadings(pages);
    const allCandidates = [];

    for (const p of pages) {
      for (const r of p.rows) {
        const m = matchQuestionMarker(r, p.page, p.isTwoColumn, p.gutterX);
        if (m) allCandidates.push(m);
      }
    }

    // Determine if numbering is continuous 1..75 or partitioned 1..25 per subject
    const maxNum = Math.max(0, ...allCandidates.map(c => c.number));
    const isContinuous = maxNum > 30;

    const chosen = new Map();

    if (isContinuous) {
      // Direct global matching 1..expected
      for (let q = 1; q <= expected; q++) {
        const candidates = allCandidates.filter(c => c.number === q);
        if (!candidates.length) continue;
        const prev = chosen.get(q - 1);
        candidates.sort((a, b) => scoreQuestionMarker(b, q, prev, null) - scoreQuestionMarker(a, q, prev, null));
        chosen.set(q, candidates[0]);
      }
    } else {
      // Partitioned matching: Subject 1 (1-25), Subject 2 (26-50), Subject 3 (51-75)
      // Check subject ranges by detected subject headings
      const partBounds = [
        { subject: 'Physics', firstId: 1, lastId: 25 },
        { subject: 'Chemistry', firstId: 26, lastId: 50 },
        { subject: 'Mathematics', firstId: 51, lastId: 75 }
      ];

      // If subject headings were found in a specific page order (e.g. Maths, Physics, Chemistry), map properly
      const detectedOrder = [];
      for (const h of subjects) {
        if (!detectedOrder.some(d => d.subject === h.subject)) detectedOrder.push(h);
      }

      for (let pIdx = 0; pIdx < partBounds.length; pIdx++) {
        const bound = partBounds[pIdx];
        const assignedSubject = detectedOrder.find(d => d.subject === bound.subject);
        const nextSubject = detectedOrder.find((d, idx) => idx > detectedOrder.indexOf(assignedSubject));

        const minPage = assignedSubject ? assignedSubject.page : Math.floor(pages.length * pIdx / 3) + 1;
        const maxPage = nextSubject ? nextSubject.page : (pIdx < 2 ? Math.floor(pages.length * (pIdx + 1) / 3) + 2 : pages.length);

        for (let local = 1; local <= 25; local++) {
          const globalId = bound.firstId + local - 1;
          if (globalId > expected) break;
          const candidates = allCandidates.filter(c => c.number === local && c.page >= minPage && c.page <= maxPage);
          if (!candidates.length) continue;
          const prev = chosen.get(globalId - 1);
          candidates.sort((a, b) => scoreQuestionMarker(b, local, prev, null) - scoreQuestionMarker(a, local, prev, null));
          chosen.set(globalId, { ...candidates[0], number: globalId, localNumber: local });
        }
      }
    }

    const result = [];
    for (let q = 1; q <= expected; q++) {
      if (chosen.has(q)) result.push(chosen.get(q));
    }
    return result;
  }

  async function bitmap(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    try { const image = new Image(); image.src = url; await image.decode(); return image; }
    finally { URL.revokeObjectURL(url); }
  }

  function getCropPieces(pages, startMarker, nextMarker) {
    const startPage = pages[startMarker.page - 1];
    const pieces = [];

    const topY = Math.max(0, Math.floor(startMarker.y - 18));
    let endY = startPage.height - 15;

    if (nextMarker && nextMarker.page === startMarker.page && nextMarker.column === startMarker.column && nextMarker.y > startMarker.y) {
      endY = Math.max(topY + 30, Math.floor(nextMarker.y - 10));
    }

    let x0 = 0, x1 = startPage.width;
    if (startPage.isTwoColumn) {
      if (startMarker.column === 0) {
        x0 = 0;
        x1 = Math.ceil(startPage.gutterX + 15);
      } else {
        x0 = Math.max(0, Math.floor(startPage.gutterX - 15));
        x1 = startPage.width;
      }
    }

    pieces.push({
      pageNo: startMarker.page,
      x0, y0: topY,
      w: Math.max(1, x1 - x0),
      h: Math.max(1, endY - topY)
    });

    // Continuation onto following pages if next marker starts later
    if (nextMarker && nextMarker.page > startMarker.page) {
      for (let pNo = startMarker.page + 1; pNo <= nextMarker.page; pNo++) {
        const contPage = pages[pNo - 1];
        const contEndY = pNo === nextMarker.page ? Math.max(20, Math.floor(nextMarker.y - 10)) : contPage.height - 20;
        let cx0 = 0, cx1 = contPage.width;
        if (contPage.isTwoColumn) {
          if (startMarker.column === 0) { cx0 = 0; cx1 = Math.ceil(contPage.gutterX + 15); }
          else { cx0 = Math.max(0, Math.floor(contPage.gutterX - 15)); cx1 = contPage.width; }
        }
        if (contEndY > 35) {
          pieces.push({
            pageNo: pNo,
            x0: cx0, y0: 20,
            w: Math.max(1, cx1 - cx0),
            h: Math.max(1, contEndY - 20)
          });
        }
      }
    }

    return pieces;
  }

  async function imageCrops(file, expected, onProgress = () => {}, aiMarkers = null) {
    let scanned = await scan(file, onProgress, '3', Boolean(aiMarkers?.length));
    const { pdf, pages } = scanned;

    try {
      let starts = [];
      if (Array.isArray(aiMarkers) && aiMarkers.length) {
        const seen = new Set();
        starts = aiMarkers
          .filter(item => item.confidence >= .65 && item.id <= expected && item.page <= pages.length && !seen.has(item.id) && seen.add(item.id))
          .map(item => {
            const p = pages[item.page - 1];
            const y = Math.round(item.y * p.height / 1000);
            return { page: item.page, y, x: 0, number: item.id, column: p.isTwoColumn ? (item.x < 500 ? 0 : 1) : 0 };
          })
          .sort((a, b) => a.number - b.number);
      }

      if (!starts.length) {
        starts = extractNumberedMarkers(pages, expected);
      }

      const pageCache = new Map();
      async function getPage(number) {
        if (!pageCache.has(number)) pageCache.set(number, await bitmap(pages[number - 1].jpeg));
        return pageCache.get(number);
      }

      const output = new Array(expected).fill(null);
      const markerMap = new Map(starts.map(s => [s.number, s]));

      for (let q = 1; q <= expected; q++) {
        const start = markerMap.get(q);
        if (!start) continue;

        // Find the closest next marker on the paper
        let next = null;
        for (let nextQ = q + 1; nextQ <= expected + 5; nextQ++) {
          if (markerMap.has(nextQ)) { next = markerMap.get(nextQ); break; }
        }

        const pieces = getCropPieces(pages, start, next);
        const canvasW = Math.max(...pieces.map(p => p.w));
        const canvasH = pieces.reduce((sum, p) => sum + p.h, 0);

        const canvas = Object.assign(document.createElement('canvas'), { width: canvasW, height: Math.max(1, canvasH) });
        const ctx = canvas.getContext('2d');
        let currentY = 0;

        for (const piece of pieces) {
          const srcImg = await getPage(piece.pageNo);
          ctx.drawImage(srcImg, piece.x0, piece.y0, piece.w, piece.h, 0, currentY, piece.w, piece.h);
          currentY += piece.h;
        }

        output[q - 1] = await new Promise((resolve, reject) =>
          canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(`Could not crop question ${q}.`)), 'image/webp', 0.84)
        );
        canvas.width = canvas.height = 1;
        onProgress(q, expected);
      }

      for (const val of pageCache.values()) val.close?.();
      return output;
    } finally {
      await pdf.cleanup();
    }
  }

  function parseTextAnswersFromPages(pages) {
    const answers = {};
    const fullText = pages.map(p => `${p.nativeText || ''}\n${p.rows.map(r => r.text).join('\n')}`).join('\n');

    // 1. Regex for "Q1 (A)" or "Q1: 4" or "Q1 Text Solution: ... Ans: 2"
    const qAnsRegex = /\bQ\s*(\d{1,2})\b\s*(?:[:\-.]|\s+)\s*(?:\(?\s*([A-D1-4](?:\s*,\s*[A-D1-4]){0,3}|-?\d+(?:\.\d+)?)\s*\)?)/gi;
    for (const m of fullText.matchAll(qAnsRegex)) {
      const q = Number(m[1]);
      let ans = m[2].trim().toUpperCase();
      if (/^[A-D]$/.test(ans)) ans = String(ans.charCodeAt(0) - 64);
      if (q >= 1 && q <= 75) answers[q] = ans;
    }

    // 2. Regex for "1. (A)" or "1. A" or "1. (4)"
    const dotAnsRegex = /(?:^|\s)(\d{1,2})[.)]\s+\(?([A-D1-4]|-?\d+(?:\.\d+)?)\)?(?=\s|$)/g;
    for (const m of fullText.matchAll(dotAnsRegex)) {
      const q = Number(m[1]);
      let ans = m[2].trim().toUpperCase();
      if (/^[A-D]$/.test(ans)) ans = String(ans.charCodeAt(0) - 64);
      if (q >= 1 && q <= 75 && !answers[q]) answers[q] = ans;
    }

    // 3. Paired tokens in table grids (e.g. Allen Q Answer columns: "1 4 16 3 31 2 ...")
    const cleanTokens = fullText.replace(/Answer\s+Key/gi, '').split(/\s+/).filter(Boolean);
    for (let i = 0; i < cleanTokens.length - 1; i++) {
      const t = cleanTokens[i];
      const n = Number(t);
      if (/^\d{1,2}$/.test(t) && n >= 1 && n <= 75 && !answers[n]) {
        const next = cleanTokens[i + 1];
        if (/^[A-D1-4]$|^-?\d+(?:\.\d+)?$/.test(next)) {
          let ans = next.toUpperCase();
          if (/^[A-D]$/.test(ans)) ans = String(ans.charCodeAt(0) - 64);
          answers[n] = ans;
        }
      }
    }

    // 4. Inline answers: "Ans. (2)" or "Ans: B" or "Correct Option : 1"
    for (const p of pages) {
      for (const r of p.rows) {
        const m = r.text.match(/(?:Ans(?:wer)?\.?\s*[:\-]?\s*\(?([A-D1-4]|-?\d+(?:\.\d+)?)\)?|Correct\s+Option\s*[:\-]?\s*([1-4]))/i);
        if (m) {
          const val = (m[1] || m[2]).trim().toUpperCase();
          const cleanAns = /^[A-D]$/.test(val) ? String(val.charCodeAt(0) - 64) : val;
          // Associate with nearby question number on page
          const qMatch = r.text.match(/\bQ(?:uestion)?\s*(\d{1,2})\b/i);
          if (qMatch) {
            const q = Number(qMatch[1]);
            if (q >= 1 && q <= 75 && !answers[q]) answers[q] = cleanAns;
          }
        }
      }
    }

    return answers;
  }

  async function answerMap(file, onProgress = () => {}) {
    const { pdf, pages } = await scan(file, onProgress, '3');
    const answers = parseTextAnswersFromPages(pages);

    try {
      // Pixel-based table detection for scanned sheets with solid black grid borders
      let question = 1;
      for (const page of pages) {
        const canvas = Object.assign(document.createElement('canvas'), { width: page.width, height: page.height });
        const image = await bitmap(page.jpeg);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0);
        image.close?.();

        const horizontal = [];
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const x0 = Math.floor(canvas.width * .07), x1 = Math.ceil(canvas.width * .93), span = x1 - x0;
        for (let y = 0; y < canvas.height; y++) {
          let dark = 0;
          for (let x = x0; x < x1; x += 2) {
            const at = (y * canvas.width + x) * 4;
            if ((pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3 < 105) dark++;
          }
          if (dark > span * .30) horizontal.push(y);
        }

        const rules = [];
        for (const y of horizontal) {
          if (!rules.length || y > rules[rules.length - 1].at(-1) + 2) rules.push([y]);
          else rules.at(-1).push(y);
        }
        const centers = rules.map(rule => Math.round((rule[0] + rule.at(-1)) / 2));
        const tables = [];
        for (let i = 0; i + 2 < centers.length; i++) {
          const a = centers[i], b = centers[i + 1], c = centers[i + 2];
          if (b - a >= 10 && b - a <= 70 && c - b >= 10 && c - b <= 70) {
            if (!tables.some(t => Math.abs(t.top - a) < 8)) tables.push({ top: a, middle: b, bottom: c });
          }
        }

        for (const table of tables) {
          if (question > 75) break;
          const h = table.bottom - table.middle;
          if (h < 10 || h > 75) continue;
          const y0 = table.middle + 1, y1 = table.bottom - 1;
          const vertical = [];
          for (let x = x0; x < x1; x++) {
            let dark = 0;
            for (let y = table.top; y <= table.bottom; y += 1) {
              const at = (y * canvas.width + x) * 4;
              if ((pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3 < 105) dark++;
            }
            if (dark > (table.bottom - table.top) * .65) vertical.push(x);
          }
          const bounds = [];
          for (const x of vertical) { if (!bounds.length || x > bounds.at(-1) + 2) bounds.push(x); }
          const cells = bounds.length - 2;
          if (cells < 4 || cells > 26) continue;

          const worker = await getWorker();
          for (let index = 0; index < cells && question + index <= 75; index++) {
            if (answers[question + index]) continue; // keep text-extracted answer if already known
            const left = bounds[index + 1], right = bounds[index + 2];
            const pad = Math.max(1, Math.round((right - left) * .10));
            const sourceWidth = right - left - pad * 2;
            const cell = Object.assign(document.createElement('canvas'), {
              width: Math.max(1, sourceWidth) * 6,
              height: Math.max(1, y1 - y0) * 6
            });
            cell.getContext('2d').drawImage(canvas, left + pad, y0, sourceWidth, y1 - y0, 0, 0, cell.width, cell.height);

            const isMcq = (question + index) <= 20 || ((question + index) >= 26 && (question + index) <= 45) || ((question + index) >= 51 && (question + index) <= 70);
            const whitelist = isMcq ? 'ABCD1234' : '0123456789.-';
            const data = await worker.recognize(cell, { tessedit_pageseg_mode: '10', tessedit_char_whitelist: whitelist });
            const cellText = String(data.data.text || '').toUpperCase().trim();
            if (isMcq) {
              const letter = cellText.match(/[A-D1-4]/)?.[0];
              if (letter) answers[question + index] = /^[A-D]$/.test(letter) ? String(letter.charCodeAt(0) - 64) : letter;
            } else {
              const num = cellText.match(/-?\d+(?:\.\d+)?/)?.[0];
              if (num) answers[question + index] = num;
            }
            cell.width = cell.height = 1;
          }
          question += cells;
        }
        canvas.width = canvas.height = 1;
      }
      return answers;
    } finally {
      await pdf.cleanup();
    }
  }

  function matchSolutionMarker(row, pageNo, isTwoColumn, gutterX) {
    const raw = String(row.text || '').trim();
    const clean = raw.replace(/^[|Il!i:._\s\-]+/, '');

    // Explicit solution marker
    const solMatch = clean.match(/^(?:(?:Hints?\s*&\s*Solutions?|Text\s+Solution|Solution|Sol)\s*[:\-.]?\s*|Q\s*(\d{1,2})\s*Text\s+Solution|Ans(?:wer)?\.?\s*\([A-D1-4]\)\s*Sol\.?\s*)(\d{1,2})?[.):\]\-]?\s*(.*)$/i);
    if (solMatch) {
      const num = Number(solMatch[1] || solMatch[2]);
      if (num >= 1 && num <= 75) {
        return {
          ...row,
          number: num,
          page: pageNo,
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0,
          isExplicit: true
        };
      }
    }

    // Numbered item in solutions
    const qMatch = clean.match(/^(?:Q\s*)?(\d{1,2})[.):\]\-]\s*(.*)$/i);
    if (qMatch) {
      const num = Number(qMatch[1]);
      if (num >= 1 && num <= 75) {
        return {
          ...row,
          number: num,
          page: pageNo,
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0,
          isExplicit: false
        };
      }
    }

    return null;
  }

  async function solutionMap(file, onProgress = () => {}, aiMarkers = null) {
    const scanned = await scan(file, onProgress, '3', Boolean(aiMarkers?.length));
    const { pdf, pages } = scanned;

    try {
      const output = new Map();
      let starts = [];

      if (Array.isArray(aiMarkers) && aiMarkers.length) {
        const seen = new Set();
        starts = aiMarkers
          .filter(item => item.confidence >= .65 && item.id <= 75 && item.page <= pages.length && !seen.has(item.id) && seen.add(item.id))
          .map(item => {
            const p = pages[item.page - 1];
            const y = Math.round(item.y * p.height / 1000);
            return { page: item.page, y, x: 0, number: item.id, column: p.isTwoColumn ? (item.x < 500 ? 0 : 1) : 0 };
          })
          .sort((a, b) => a.number - b.number);
      }

      if (!starts.length) {
        const candidates = [];
        for (const p of pages) {
          for (const r of p.rows) {
            const m = matchSolutionMarker(r, p.page, p.isTwoColumn, p.gutterX);
            if (m) candidates.push(m);
          }
        }

        const chosen = new Map();
        for (let q = 1; q <= 75; q++) {
          const forQ = candidates.filter(c => c.number === q);
          if (forQ.length) {
            forQ.sort((a, b) => (b.isExplicit ? 50 : 0) - (a.isExplicit ? 50 : 0));
            chosen.set(q, forQ[0]);
          }
        }
        starts = Array.from(chosen.values()).sort((a, b) => a.number - b.number);
      }

      const pageCache = new Map();
      async function getPage(number) {
        if (!pageCache.has(number)) pageCache.set(number, await bitmap(pages[number - 1].jpeg));
        return pageCache.get(number);
      }

      const markerMap = new Map(starts.map(s => [s.number, s]));

      for (let q = 1; q <= 75; q++) {
        const start = markerMap.get(q);
        if (!start) continue;

        let next = null;
        for (let nextQ = q + 1; nextQ <= 80; nextQ++) {
          if (markerMap.has(nextQ)) { next = markerMap.get(nextQ); break; }
        }

        const pieces = getCropPieces(pages, start, next);
        const canvasW = Math.max(...pieces.map(p => p.w));
        const canvasH = pieces.reduce((sum, p) => sum + p.h, 0);

        const canvas = Object.assign(document.createElement('canvas'), { width: canvasW, height: Math.max(1, canvasH) });
        const ctx = canvas.getContext('2d');
        let currentY = 0;

        for (const piece of pieces) {
          const srcImg = await getPage(piece.pageNo);
          ctx.drawImage(srcImg, piece.x0, piece.y0, piece.w, piece.h, 0, currentY, piece.w, piece.h);
          currentY += piece.h;
        }

        const blob = await new Promise((resolve, reject) =>
          canvas.toBlob(b => b ? resolve(b) : reject(new Error(`Could not crop solution ${q}.`)), 'image/webp', 0.86)
        );
        output.set(q, blob);
        canvas.width = canvas.height = 1;
        onProgress(`Local AI matched explanation ${q}…`);
      }

      for (const val of pageCache.values()) val.close?.();
      return output;
    } finally {
      await pdf.cleanup();
    }
  }

  window.JeeLocalAiPdfOcr = {
    extractQuestions: imageCrops,
    extractAnswers: answerMap,
    extractSolutions: solutionMap
  };
})();
