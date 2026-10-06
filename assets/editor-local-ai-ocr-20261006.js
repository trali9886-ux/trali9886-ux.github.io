/* On-device OCR assist: split raster-only JEE PDFs and match numbered solutions. */
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
    if (!lines.length) for (const block of data.blocks || []) for (const paragraph of block.paragraphs || []) lines.push(...(paragraph.lines || []));
    return lines.filter(line => String(line.text || '').trim()).map(line => ({
      text: String(line.text).replace(/[\u00a0\u2007\u202f]/g, ' ').trim(),
      x: Number(line.bbox?.x0 || 0), y: Number(line.bbox?.y0 || 0), bottom: Number(line.bbox?.y1 || 0),
      confidence: Number(line.confidence || 0)
    }));
  }

  async function scan(file, onProgress = () => {}, pageMode = '3') {
    progress = onProgress;
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('The PDF reader is not ready. Reload the editor and try again.');
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: pageMode });
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        progress(`Local AI scanning page ${number} of ${pdf.numPages}…`);
        const page = await pdf.getPage(number), viewport = page.getViewport({ scale: SCALE });
        const canvas = Object.assign(document.createElement('canvas'), { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height) });
        await page.render({ canvasContext: canvas.getContext('2d', { willReadFrequently: true }), viewport, canvas }).promise;
        const result = await worker.recognize(canvas, {}, { blocks: true });
        const rows = parseRows(result.data);
        const jpeg = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(`Could not render scanned PDF page ${number}.`)), 'image/jpeg', 0.86));
        pages.push({ page: number, width: canvas.width, height: canvas.height, rows, jpeg });
        canvas.width = canvas.height = 1;
      }
      return { pdf, pages };
    } catch (error) { await pdf.cleanup(); throw error; }
  }

  function marker(row, page) {
    const match = row.text.match(/^\s*(?:(?:Q(?:uestion)?\s*(?:No\.?\s*)?))?(\d{1,3})(?:\s*[).]\s*(.*)|\s+(.+))$/i);
    if (!match) return null;
    const number = Number(match[1]);
    return number > 0 && number <= 300 ? { ...row, number, page, rest: match[2] || match[3] || '' } : null;
  }

  function subjectPart(text) {
    const line = String(text || '').toUpperCase();
    if (/\bPHYSICS\b/.test(line) && /\b(?:PART|SECTION)\s*(?:1|I)\b/.test(line)) return 0;
    if (/\bCHEMISTRY\b/.test(line) && /\b(?:PART|SECTION)\s*(?:2|II)\b/.test(line)) return 1;
    if (/\b(?:MATHEMATICS|MATHS)\b/.test(line) && /\b(?:PART|SECTION)\s*(?:3|III)\b/.test(line)) return 2;
    if (/\bPHYSICS\b/.test(line) && /\bPART\b/.test(line)) return 0;
    if (/\bCHEMISTRY\b/.test(line) && /\bPART\b/.test(line)) return 1;
    if (/\b(?:MATHEMATICS|MATHS)\b/.test(line) && /\bPART\b/.test(line)) return 2;
    return null;
  }

  function numberedItems(pages, expected) {
    const result = []; let part = 0, lastLocal = 0, nextGlobal = 1;
    for (const page of pages) {
      const rows = [...page.rows].sort((a, b) => a.y - b.y);
      for (const row of rows) {
        const heading = subjectPart(row.text);
        if (heading !== null && heading !== part) { part = heading; lastLocal = 0; }
        let item = marker(row, page.page);
        if (!item) {
          const expectedLocal = lastLocal + 1;
          const fuzzy = row.text.match(/^\s*(2[DOIl])\s+(.{18,})$/i);
          if (expectedLocal === 21 && fuzzy && row.x < page.width * .18) item = { ...row, page: page.page, number: 21, rest: fuzzy[2] };
        }
        if (!item) continue;
        let globalNumber = item.number;
        if (item.number <= 25) {
          if (item.number === 1 && lastLocal >= 20 && part < 2) { part++; lastLocal = 0; }
          const expectedLocal = lastLocal + 1;
          const hasAnchorText = String(item.rest || '').length >= 18 && item.x < page.width * .18;
          const fuzzy22 = expectedLocal === 22 && item.number === 2 && hasAnchorText;
          const fuzzy24 = expectedLocal === 24 && item.number === 29 && hasAnchorText;
          const localNumber = item.number === expectedLocal ? item.number : (fuzzy22 || fuzzy24 ? expectedLocal : item.number);
          if (localNumber !== expectedLocal) continue;
          item = { ...item, number: localNumber };
          globalNumber = part * 25 + localNumber;
          lastLocal = localNumber;
        } else if (item.number >= 26 && item.number <= 75) {
          const expectedLocal = lastLocal + 1;
          const hasAnchorText = String(item.rest || '').length >= 18 && item.x < page.width * .18;
          if (item.number !== nextGlobal && !(part < 2 && expectedLocal <= 25 && hasAnchorText)) continue;
          if (item.number === nextGlobal) {
            part = Math.floor((item.number - 1) / 25);
            lastLocal = (item.number - 1) % 25 + 1;
          } else {
            item = { ...item, number: expectedLocal };
            globalNumber = part * 25 + expectedLocal;
            lastLocal = expectedLocal;
          }
        } else continue;
        if (globalNumber !== nextGlobal) continue;
        result.push({ ...item, number: globalNumber, localNumber: item.number });
        nextGlobal++;
        if (result.length === expected) return result;
      }
    }
    const found = new Set(result.map(item => item.number));
    const missing = Array.from({ length: expected }, (_, i) => i + 1).filter(number => !found.has(number)).slice(0, 8);
    throw new Error(`Local AI found ${result.length} of ${expected} numbered items. It maps PART 1/2/3 to Physics/Chemistry/Mathematics. Check the scan near question ${missing.join(', ') || 'numbers'}; use a clearer PDF or correct the numbering.`);
  }

  function orderedMarkers(pages, expected) { return numberedItems(pages, expected); }

  async function bitmap(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    try { const image = new Image(); image.src = url; await image.decode(); return image; }
    finally { URL.revokeObjectURL(url); }
  }

  async function imageCrops(file, expected, onProgress = () => {}) {
    let scanned = await scan(file, onProgress), { pdf, pages } = scanned;
    try {
      let starts;
      try { starts = orderedMarkers(pages, expected); }
      catch (firstError) {
        await pdf.cleanup();
        scanned = await scan(file, onProgress, '6'); ({ pdf, pages } = scanned);
        try { starts = orderedMarkers(pages, expected); }
        catch { throw firstError; }
      }
      const pageCache = new Map();
      async function getPage(number) {
        if (!pageCache.has(number)) pageCache.set(number, await bitmap(pages[number - 1].jpeg));
        return pageCache.get(number);
      }
      const output = [];
      for (let index = 0; index < starts.length; index++) {
        const start = starts[index], next = starts[index + 1], pieces = [];
        const endPage = next?.page || start.page;
        for (let pageNo = start.page; pageNo <= endPage; pageNo++) {
          const source = await getPage(pageNo), page = pages[pageNo - 1];
          const top = pageNo === start.page ? Math.max(0, Math.floor(start.y - 22)) : 0;
          const bottom = next?.page === pageNo ? Math.max(top + 30, Math.floor(next.y - 12)) : page.height;
          if (bottom > top) pieces.push({ source, top, bottom, width: page.width });
        }
        const height = pieces.reduce((sum, part) => sum + part.bottom - part.top, 0), width = pieces[0]?.width || 1;
        const canvas = Object.assign(document.createElement('canvas'), { width, height: Math.max(1, height) });
        const ctx = canvas.getContext('2d'); let y = 0;
        for (const part of pieces) { const h = part.bottom - part.top; ctx.drawImage(part.source, 0, part.top, part.width, h, 0, y, part.width, h); y += h; }
        output.push(await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error(`Could not crop question ${start.number}.`)), 'image/webp', 0.84)));
        canvas.width = canvas.height = 1;
        onProgress(`Local AI split question ${start.number} of ${expected}…`);
      }
      for (const value of pageCache.values()) value.close?.();
      return output;
    } finally { await pdf.cleanup(); }
  }

  async function answerMap(file, onProgress = () => {}) {
    const { pdf, pages } = await scan(file, onProgress);
    const answers = {};
    try {
      let question = 1;
      for (const page of pages) {
        const canvas = Object.assign(document.createElement('canvas'), { width: page.width, height: page.height });
        const image = await bitmap(page.jpeg), ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image, 0, 0); image.close?.();
        const horizontal = [];
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const x0 = Math.floor(canvas.width * .07), x1 = Math.ceil(canvas.width * .93), span = x1 - x0;
        for (let y = 0; y < canvas.height; y++) {
          let dark = 0;
          for (let x = x0; x < x1; x += 2) { const at = (y * canvas.width + x) * 4; if ((pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3 < 105) dark++; }
          if (dark > span * .34) horizontal.push(y);
        }
        const rules = [];
        for (const y of horizontal) { if (!rules.length || y > rules[rules.length - 1].at(-1) + 2) rules.push([y]); else rules.at(-1).push(y); }
        const centers = rules.map(rule => Math.round((rule[0] + rule.at(-1)) / 2));
        const tables = [];
        for (let i = 0; i + 2 < centers.length; i++) {
          const a = centers[i], b = centers[i + 1], c = centers[i + 2];
          if (b - a >= 12 && b - a <= 60 && c - b >= 12 && c - b <= 60) {
            if (!tables.some(t => Math.abs(t.top - a) < 8)) tables.push({ top: a, middle: b, bottom: c });
          }
        }
        for (const table of tables) {
          if (question > 75) break;
          const h = table.bottom - table.middle;
          if (h < 10 || h > 70) continue;
          const y0 = table.middle + 1, y1 = table.bottom - 1;
          const vertical = [];
          for (let x = x0; x < x1; x++) {
            let dark = 0;
            for (let y = table.top; y <= table.bottom; y += 1) { const at = (y * canvas.width + x) * 4; if ((pixels[at] + pixels[at + 1] + pixels[at + 2]) / 3 < 105) dark++; }
            if (dark > (table.bottom - table.top) * .68) vertical.push(x);
          }
          const bounds = [];
          for (const x of vertical) { if (!bounds.length || x > bounds.at(-1) + 2) bounds.push(x); }
          const cells = bounds.length - 2;
          if (cells !== 20 && cells !== 5) continue;
          const answerLeft = bounds[1], answerRight = bounds.at(-1);
          const row = Object.assign(document.createElement('canvas'), { width: Math.max(1, answerRight - answerLeft), height: Math.max(1, y1 - y0) });
          row.getContext('2d').drawImage(canvas, answerLeft, y0, row.width, row.height, 0, 0, row.width, row.height);
          if (cells === 20) {
            const wide = Object.assign(document.createElement('canvas'), { width: row.width * 4, height: row.height * 4 });
            wide.getContext('2d').drawImage(row, 0, 0, wide.width, wide.height);
            const data = await (await getWorker()).recognize(wide, { tessedit_pageseg_mode: '13', tessedit_char_whitelist: 'ABCD' });
            let letters = String(data.data.text || '').toUpperCase().replace(/[^A-D]/g, '');
            if (letters.length === 21 && letters[0] === 'A') letters = letters.slice(1);
            if (letters.length === 20) for (let index = 0; index < 20; index++) answers[question + index] = String(letters.charCodeAt(index) - 64);
            question += 20;
            wide.width = wide.height = 1;
          } else {
            const qStart = bounds[1], qEnd = bounds.at(-1);
            for (let i = 0; i < 5; i++) {
              const left = bounds[i + 1], right = bounds[i + 2], pad = Math.max(2, Math.round((right - left) * .13));
              const cell = Object.assign(document.createElement('canvas'), { width: (right - left - pad * 2) * 6, height: row.height * 6 });
              cell.getContext('2d').drawImage(canvas, left + pad, y0, right - left - pad * 2, row.height, 0, 0, cell.width, cell.height);
              const data = await (await getWorker()).recognize(cell, { tessedit_pageseg_mode: '13', tessedit_char_whitelist: '0123456789.-' });
              const value = String(data.data.text || '').match(/-?\d+(?:\.\d+)?/)?.[0];
              if (value) answers[question] = value;
              question++; cell.width = cell.height = 1;
            }
            void qStart; void qEnd;
          }
          row.width = row.height = 1;
          progress(`Local AI matched ${question - 1} scanned answer keys…`);
        }
        canvas.width = canvas.height = 1;
      }
      return answers;
    } finally { await pdf.cleanup(); }
  }

  async function solutionMap(file, onProgress = () => {}) {
    let scanned = await scan(file, onProgress), { pdf, pages } = scanned;
    try {
      let starts;
      try { starts = numberedItems(pages, 75); }
      catch (firstError) {
        await pdf.cleanup();
        scanned = await scan(file, onProgress, '6'); ({ pdf, pages } = scanned);
        try { starts = numberedItems(pages, 75); }
        catch { return new Map(); }
      }
      starts = starts.map(item => ({ ...item, width: pages[item.page - 1].width, height: pages[item.page - 1].height }));
      const output = new Map();
      const cache = new Map();
      async function pageImage(number) {
        if (!cache.has(number)) cache.set(number, await bitmap(pages[number - 1].jpeg));
        return cache.get(number);
      }
      for (let i = 0; i < starts.length; i++) {
        const start = starts[i], next = starts[i + 1], pieces = [];
        for (let pageNo = start.page; pageNo <= (next?.page || start.page); pageNo++) {
          const source = await pageImage(pageNo), page = pages[pageNo - 1];
          const top = pageNo === start.page ? Math.max(0, Math.floor(start.y - 18)) : 0;
          const bottom = next?.page === pageNo ? Math.max(top + 30, Math.floor(next.y - 10)) : source.height;
          if (bottom > top) pieces.push({ source, top, bottom, width: page.width });
        }
        const width = pieces[0]?.width || 1, height = pieces.reduce((sum, piece) => sum + piece.bottom - piece.top, 0);
        const crop = Object.assign(document.createElement('canvas'), { width, height: Math.max(1, height) });
        const ctx = crop.getContext('2d'); let y = 0;
        for (const piece of pieces) { const h = piece.bottom - piece.top; ctx.drawImage(piece.source, 0, piece.top, piece.width, h, 0, y, piece.width, h); y += h; }
        output.set(start.number, await new Promise((resolve, reject) => crop.toBlob(blob => blob ? resolve(blob) : reject(new Error(`Could not crop explanation ${start.number}.`)), 'image/webp', .86)));
        crop.width = crop.height = 1;
        onProgress(`Local AI matched explanation ${start.number}…`);
      }
      for (const value of cache.values()) value.close?.();
      return output;
    } finally { await pdf.cleanup(); }
  }

  window.JeeLocalAiPdfOcr = { extractQuestions: imageCrops, extractAnswers: answerMap, extractSolutions: solutionMap };
})();
