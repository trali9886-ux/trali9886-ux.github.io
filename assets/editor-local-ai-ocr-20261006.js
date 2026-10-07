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
    if (!raw) return null;

    // Filter out obvious non-question lines:
    // 1. Dates: e.g. 19-07-2026, 19/07/2026
    if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/.test(raw)) return null;
    // 2. Barcodes / long numeric codes (e.g. 0999DJM...)
    if (/^\d{4,}/.test(raw) || /^[0-9]+[A-Z0-9]{5,}/i.test(raw)) return null;
    // 3. Option labels: (A), (B), (C), (D), (1), (2), (3), (4)
    if (/^\([A-D1-4]\)/i.test(raw)) return null;
    // 4. Section headings alone: "PART 1 : PHYSICS", "PART 2 : CHEMISTRY", etc.
    if (/^(?:PART|SECTION)\s*[-:–—]?\s*(?:[1-3]|[I|V|X]+|[A-C])\s*[:–—\-]?\s*(?:PHYSICS|CHEMISTRY|MATHEMATICS|MATHS)?\s*$/i.test(raw)) return null;
    // 5. Answers / Solutions:
    if (/^(?:Ans(?:wer)?|Sol(?:ution)?|Hints?)/i.test(raw)) return null;

    const clean = raw.replace(/^[|Il!i:._\s\-]+/, '').trim();
    if (!clean) return null;

    // 1. Delimited question marker: "1)", "1.", "1]", "1:"
    // Delimiter is REQUIRED so plain numbers like "80m" or "60" never match.
    const delimMatch = clean.match(/^(\d{1,2})\s*([.):\]])\s*(.*)$/);
    if (delimMatch) {
      const num = Number(delimMatch[1]);
      const rest = (delimMatch[3] || '').trim();
      if (num >= 1 && num <= 75) {
        // Exclude lines where the number is followed by physical units (e.g. "80m", "10 m/s")
        if (!/^(?:m\/s|m\b|cm\b|kg\b|s\b|km\b|rad\b|V\b|A\b|N\b|J\b)/i.test(rest)) {
          return {
            ...row,
            number: num,
            page: pageNo,
            rest,
            column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0,
            isExplicit: true
          };
        }
      }
    }

    // 2. Explicit Q-prefix: "Q.1", "Q1", "Question 1", "Que. 1", "Q1)"
    const qMatch = clean.match(/^(?:(?:SECTION|PART)\s*[-A-Z0-9]+\s+)?(?:Q(?:uestion|ue)?\.?\s*(?:No\.?\s*)?[:\-]?\s*)(\d{1,2})(?:[.):\]\-]\s*|\s+)(.*)$/i);
    if (qMatch) {
      const num = Number(qMatch[1]);
      if (num >= 1 && num <= 75) {
        return {
          ...row,
          number: num,
          page: pageNo,
          rest: (qMatch[2] || '').trim(),
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0,
          isExplicit: true
        };
      }
    }

    // 3. Hyphen delimiter: "1 - If a..." or "1- The..."
    const hyphenMatch = clean.match(/^(\d{1,2})\s*[-–—]\s+([A-Z].*)$/);
    if (hyphenMatch) {
      const num = Number(hyphenMatch[1]);
      if (num >= 1 && num <= 75) {
        return {
          ...row,
          number: num,
          page: pageNo,
          rest: hyphenMatch[2].trim(),
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0,
          isExplicit: true
        };
      }
    }

    // 4. Number directly followed by standard question starting words (no punctuation):
    // "1 If a particle...", "2 Consider two spheres..."
    const wordMatch = clean.match(/^(\d{1,2})\s+([A-Z][a-zA-Z]{1,}\b.*)$/);
    if (wordMatch) {
      const num = Number(wordMatch[1]);
      const rest = wordMatch[2].trim();
      if (num >= 1 && num <= 75 && /(?:If\b|Let\b|The\b|In\b|A\b|An\b|Two\b|Three\b|Four\b|Consider\b|Which\b|What\b|Find\b|Given\b|Potential\b|Initially\b|When\b|Under\b|Select\b|Position\b|Charges?\b|Particle\b)/i.test(rest)) {
        return {
          ...row,
          number: num,
          page: pageNo,
          rest,
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0,
          isExplicit: false
        };
      }
    }

    // 5. Embedded question marker inside line:
    const embeddedMatch = clean.match(/(?:^|\s)(?:Q(?:uestion|ue)?\.?\s*)?(\d{1,2})[.)]\s+([A-Z][a-zA-Z]{1,}|If\b|Let\b|The\b|In\b|A\b|An\b|Two\b|Three\b|Four\b|Consider\b|Which\b|What\b|Find\b|Given\b|Potential\b|Initially\b|When\b|Under\b|Select\b|Position\b|Charges?\b|Particle\b)/);
    if (embeddedMatch) {
      const num = Number(embeddedMatch[1]);
      if (num >= 1 && num <= 75) {
        const idx = clean.indexOf(embeddedMatch[0]);
        return {
          ...row,
          number: num,
          page: pageNo,
          rest: clean.slice(idx + embeddedMatch[0].length).trim(),
          column: isTwoColumn ? (row.x < gutterX ? 0 : 1) : 0,
          isExplicit: false
        };
      }
    }

    return null;
  }

  function detectSubjectHeadings(pages) {
    const headings = [];
    for (const p of pages) {
      for (const r of p.rows) {
        const txt = String(r.text || '').trim();
        if (!txt || txt.length > 55) continue;
        const upper = txt.toUpperCase();
        let sub = null;
        if (/\bPHYSICS\b/.test(upper)) sub = 'Physics';
        else if (/\bCHEMISTRY\b/.test(upper)) sub = 'Chemistry';
        else if (/\b(?:MATHEMATICS|MATHS)\b/.test(upper)) sub = 'Mathematics';
        else {
          const partM = upper.match(/\bPART\s*[:\-]?\s*([123]|I|II|III)\b/);
          if (partM) {
            const val = partM[1];
            if (val === '1' || val === 'I') sub = 'Physics';
            else if (val === '2' || val === 'II') sub = 'Chemistry';
            else if (val === '3' || val === 'III') sub = 'Mathematics';
          }
        }
        if (sub) {
          const isHeading = /\b(?:PART|SECTION)\b/.test(upper) ||
            upper.replace(/[^A-Z]/g, '') === sub.toUpperCase() ||
            txt.length < 28;
          if (isHeading) {
            if (!headings.some(h => h.subject === sub)) {
              headings.push({ page: p.page, y: r.y, subject: sub, text: txt });
            }
          }
        }
      }
    }
    headings.sort((a, b) => a.page - b.page || a.y - b.y);
    return headings;
  }

  function isCandidateInSection(c, startBound, endBound) {
    if (startBound) {
      if (c.page < startBound.page) return false;
      if (c.page === startBound.page && c.y < startBound.y) return false;
    }
    if (endBound) {
      if (c.page > endBound.page) return false;
      if (c.page === endBound.page && c.y >= endBound.y) return false;
    }
    return true;
  }

  function scoreQuestionMarker(m, targetNum, prevMarker, secStart) {
    let score = 50;
    const rest = String(m.rest || '');
    if (m.isExplicit) score += 40;
    if (rest.length >= 8) score += 30;
    if (/^[A-Za-z]/.test(rest)) score += 20;
    if (/(?:Let|If|The|Find|Which|What|Consider|Given|In\b|A\b|Two|Three|When|Select|Position|Charges?|Particle)\s+[A-Za-z]/i.test(rest)) score += 30;
    if (/(?:Ans|Solution|Sol\.)/i.test(m.text)) score -= 150;
    if (m.confidence) score += Math.min(20, m.confidence / 5);

    if (prevMarker) {
      if (m.page < prevMarker.page) return -9999;
      if (m.page === prevMarker.page) {
        if (m.column < prevMarker.column) return -9999;
        if (m.column === prevMarker.column) {
          if (m.y <= prevMarker.y) return -9999;
          score += 60; // Same page, same column below previous
        } else {
          score += 50; // Same page, next column
        }
      } else if (m.page === prevMarker.page + 1) {
        score += 40; // Next page
      } else if (m.page === prevMarker.page + 2) {
        score += 15;
      } else {
        score -= (m.page - prevMarker.page) * 25;
      }
    } else if (secStart) {
      const pageDiff = Math.abs(m.page - secStart.page);
      score += Math.max(0, 40 - pageDiff * 15);
    }
    return score;
  }

  function extractNumberedMarkers(pages, expected) {
    const headings = detectSubjectHeadings(pages);
    const allCandidates = [];

    for (const p of pages) {
      for (const r of p.rows) {
        const m = matchQuestionMarker(r, p.page, p.isTwoColumn, p.gutterX);
        if (m) allCandidates.push(m);
      }
    }

    const pHeading = headings.find(h => h.subject === 'Physics');
    const cHeading = headings.find(h => h.subject === 'Chemistry');
    const mHeading = headings.find(h => h.subject === 'Mathematics');

    const totalPages = pages.length;
    const third1 = Math.max(1, Math.floor(totalPages / 3));
    const third2 = Math.max(2, Math.floor((totalPages * 2) / 3));

    const pStart = pHeading ? { page: pHeading.page, y: pHeading.y } : { page: 1, y: 0 };
    const pEnd = cHeading ? { page: cHeading.page, y: cHeading.y } : (mHeading ? { page: mHeading.page, y: mHeading.y } : { page: third1 + 1, y: 0 });

    const cStart = cHeading ? { page: cHeading.page, y: cHeading.y } : { page: third1 + 1, y: 0 };
    const cEnd = mHeading ? { page: mHeading.page, y: mHeading.y } : { page: third2 + 1, y: 0 };

    const mStart = mHeading ? { page: mHeading.page, y: mHeading.y } : { page: third2 + 1, y: 0 };
    const mEnd = { page: totalPages + 1, y: 0 };

    const sections = [
      { subject: 'Physics', firstId: 1, lastId: 25, start: pStart, end: pEnd },
      { subject: 'Chemistry', firstId: 26, lastId: 50, start: cStart, end: cEnd },
      { subject: 'Mathematics', firstId: 51, lastId: 75, start: mStart, end: mEnd }
    ];

    if (expected === 48) {
      sections[0].firstId = 1; sections[0].lastId = 16;
      sections[1].firstId = 17; sections[1].lastId = 32;
      sections[2].firstId = 33; sections[2].lastId = 48;
    }

    // Determine whether paper is partitioned (1..25 per subject) or continuous (1..75)
    const chemCandidates = allCandidates.filter(c => isCandidateInSection(c, cStart, cEnd));
    const mathCandidates = allCandidates.filter(c => isCandidateInSection(c, mStart, mEnd));

    const chemHasLow = chemCandidates.some(c => c.number >= 1 && c.number <= 15);
    const mathHasLow = mathCandidates.some(c => c.number >= 1 && c.number <= 15);
    const chemHasHigh = chemCandidates.some(c => c.number >= 26 && c.number <= 50);

    const isPartitioned = (chemHasLow || mathHasLow) || !chemHasHigh;

    const chosen = new Map();

    if (!isPartitioned) {
      for (const sec of sections) {
        const secCandidates = allCandidates.filter(c => isCandidateInSection(c, sec.start, sec.end));
        for (let g = sec.firstId; g <= sec.lastId && g <= expected; g++) {
          const candidates = secCandidates.filter(c => c.number === g);
          if (!candidates.length) continue;
          const prev = chosen.get(g - 1);
          candidates.sort((a, b) => scoreQuestionMarker(b, g, prev, sec.start) - scoreQuestionMarker(a, g, prev, sec.start));
          if (scoreQuestionMarker(candidates[0], g, prev, sec.start) > -5000) {
            chosen.set(g, { ...candidates[0], number: g, subject: sec.subject });
          }
        }
      }
    } else {
      for (const sec of sections) {
        const secCandidates = allCandidates.filter(c => isCandidateInSection(c, sec.start, sec.end));
        const countInSubject = sec.lastId - sec.firstId + 1;
        for (let local = 1; local <= countInSubject; local++) {
          const globalId = sec.firstId + local - 1;
          if (globalId > expected) break;
          const candidates = secCandidates.filter(c => c.number === local);
          if (!candidates.length) continue;
          const prev = chosen.get(globalId - 1);
          candidates.sort((a, b) => scoreQuestionMarker(b, local, prev, sec.start) - scoreQuestionMarker(a, local, prev, sec.start));
          if (scoreQuestionMarker(candidates[0], local, prev, sec.start) > -5000) {
            chosen.set(globalId, { ...candidates[0], number: globalId, localNumber: local, subject: sec.subject });
          }
        }
      }
    }

    const result = [];
    for (let q = 1; q <= expected; q++) {
      if (chosen.has(q)) result.push(chosen.get(q));
    }
    return { starts: result, allCandidates, sections };
  }

  async function bitmap(blob) {
    if (window.createImageBitmap) return createImageBitmap(blob);
    const url = URL.createObjectURL(blob);
    try { const image = new Image(); image.src = url; await image.decode(); return image; }
    finally { URL.revokeObjectURL(url); }
  }

  function getCropPieces(pages, startMarker, nextMarker, nextCandOnPage = null, secEnd = null) {
    const startPage = pages[startMarker.page - 1];
    const pieces = [];

    const topY = Math.max(0, Math.floor(startMarker.y - 18));
    let endY = startPage.height - 15;

    // 1. Next marker on same page and column:
    if (nextMarker && nextMarker.page === startMarker.page && nextMarker.column === startMarker.column && nextMarker.y > startMarker.y) {
      endY = Math.max(topY + 30, Math.floor(nextMarker.y - 10));
    }
    // 2. Next marker not on same page, but another candidate exists on same page below:
    else if (nextCandOnPage && nextCandOnPage.y > startMarker.y + 35) {
      endY = Math.max(topY + 30, Math.floor(nextCandOnPage.y - 10));
    }

    // 3. Section boundary on startPage:
    if (secEnd && secEnd.page === startMarker.page && secEnd.y > startMarker.y) {
      endY = Math.min(endY, Math.max(topY + 30, Math.floor(secEnd.y - 10)));
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

    // Continuation onto following column or page ONLY IF immediately consecutive question (nextMarker.number === startMarker.number + 1)
    if (nextMarker && nextMarker.number === startMarker.number + 1) {
      // Case A: Next marker is in the next column on the SAME page
      if (startPage.isTwoColumn && nextMarker.page === startMarker.page && startMarker.column === 0 && nextMarker.column === 1) {
        const nextColEndY = Math.max(20, Math.floor(nextMarker.y - 10));
        const cx0 = Math.max(0, Math.floor(startPage.gutterX - 15));
        const cx1 = startPage.width;
        if (nextColEndY > 35) {
          pieces.push({
            pageNo: startMarker.page,
            x0: cx0, y0: 20,
            w: Math.max(1, cx1 - cx0),
            h: Math.max(1, nextColEndY - 20)
          });
        }
      }
      // Case B: Next marker is on the immediately NEXT page (startMarker.page + 1)
      else if (nextMarker.page === startMarker.page + 1) {
        const contPage = pages[nextMarker.page - 1];
        let contEndY = Math.max(20, Math.floor(nextMarker.y - 10));
        if (secEnd && secEnd.page === contPage.page && secEnd.y < contEndY) {
          contEndY = Math.max(20, Math.floor(secEnd.y - 10));
        }
        let cx0 = 0, cx1 = contPage.width;
        if (contPage.isTwoColumn) {
          if (nextMarker.column === 0) {
            cx0 = 0; cx1 = Math.ceil(contPage.gutterX + 15);
          } else {
            cx0 = Math.max(0, Math.floor(contPage.gutterX - 15)); cx1 = contPage.width;
          }
        }
        if (contEndY > 35) {
          pieces.push({
            pageNo: nextMarker.page,
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
      let allCandidates = [];
      let sections = [];

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
        const extracted = extractNumberedMarkers(pages, expected);
        starts = extracted.starts;
        allCandidates = extracted.allCandidates;
        sections = extracted.sections;
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

        const sec = sections.find(s => q >= s.firstId && q <= s.lastId);
        const secEnd = sec ? sec.end : null;

        let next = null;
        const maxSearch = sec ? Math.min(expected, sec.lastId + 1) : expected;
        for (let nextQ = q + 1; nextQ <= maxSearch; nextQ++) {
          if (markerMap.has(nextQ)) { next = markerMap.get(nextQ); break; }
        }

        const candidatesOnPage = allCandidates.filter(c =>
          c.page === start.page &&
          c.column === start.column &&
          c.y > start.y + 35 &&
          (!sec || isCandidateInSection(c, sec.start, sec.end))
        );
        candidatesOnPage.sort((a, b) => a.y - b.y);
        const nextCandOnPage = candidatesOnPage[0] || null;

        const pieces = getCropPieces(pages, start, next, nextCandOnPage, secEnd);
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
    let currentSubjectOffset = 0;

    for (const p of pages) {
      for (const r of p.rows) {
        const line = String(r.text || '').trim();
        const upper = line.toUpperCase();

        if (/\b(?:PART\s*1|SECTION\s*1|PHYSICS)\b/.test(upper)) {
          currentSubjectOffset = 0;
        } else if (/\b(?:PART\s*2|SECTION\s*2|CHEMISTRY)\b/.test(upper)) {
          currentSubjectOffset = 25;
        } else if (/\b(?:PART\s*3|SECTION\s*3|MATHEMATICS|MATHS)\b/.test(upper)) {
          currentSubjectOffset = 50;
        }

        // 1. Q1 (A) or Q1: 4
        const qMatch = line.match(/\bQ\s*(\d{1,2})\b\s*(?:[:\-.]|\s+)\s*(?:\(?\s*([A-D1-4](?:\s*,\s*[A-D1-4]){0,3}|-?\d+(?:\.\d+)?)\s*\)?)/i);
        if (qMatch) {
          const num = Number(qMatch[1]);
          let ans = qMatch[2].trim().toUpperCase();
          if (/^[A-D]$/.test(ans)) ans = String(ans.charCodeAt(0) - 64);
          const globalQ = (num <= 25 && currentSubjectOffset > 0) ? num + currentSubjectOffset : num;
          if (globalQ >= 1 && globalQ <= 75) answers[globalQ] = ans;
        }

        // 2. 1. (A) or 1. A or 1. (4)
        const dotMatch = line.match(/^(\d{1,2})[.)]\s+\(?([A-D1-4]|-?\d+(?:\.\d+)?)\)?(?:\s|$)/);
        if (dotMatch) {
          const num = Number(dotMatch[1]);
          let ans = dotMatch[2].trim().toUpperCase();
          if (/^[A-D]$/.test(ans)) ans = String(ans.charCodeAt(0) - 64);
          const globalQ = (num <= 25 && currentSubjectOffset > 0) ? num + currentSubjectOffset : num;
          if (globalQ >= 1 && globalQ <= 75 && !answers[globalQ]) answers[globalQ] = ans;
        }

        // 3. Inline Ans: (2)
        const ansMatch = line.match(/(?:Ans(?:wer)?\.?\s*[:\-]?\s*\(?([A-D1-4]|-?\d+(?:\.\d+)?)\)?|Correct\s+Option\s*[:\-]?\s*([1-4]))/i);
        if (ansMatch) {
          const val = (ansMatch[1] || ansMatch[2]).trim().toUpperCase();
          const cleanAns = /^[A-D]$/.test(val) ? String(val.charCodeAt(0) - 64) : val;
          const nearQ = line.match(/\bQ(?:uestion)?\s*(\d{1,2})\b/i);
          if (nearQ) {
            const num = Number(nearQ[1]);
            const globalQ = (num <= 25 && currentSubjectOffset > 0) ? num + currentSubjectOffset : num;
            if (globalQ >= 1 && globalQ <= 75 && !answers[globalQ]) answers[globalQ] = cleanAns;
          }
        }
      }
    }

    // Fallback: Global token stream matching for tables
    const fullText = pages.map(p => `${p.nativeText || ''}\n${p.rows.map(r => r.text).join('\n')}`).join('\n');
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

    return answers;
  }

  async function answerMap(file, onProgress = () => {}) {
    const { pdf, pages } = await scan(file, onProgress, '3');
    const answers = parseTextAnswersFromPages(pages);

    try {
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
            if (answers[question + index]) continue;
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
      let allCandidates = [];
      let sections = [];

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
        const headings = detectSubjectHeadings(pages);
        for (const p of pages) {
          for (const r of p.rows) {
            const m = matchSolutionMarker(r, p.page, p.isTwoColumn, p.gutterX);
            if (m) allCandidates.push(m);
          }
        }

        const pHeading = headings.find(h => h.subject === 'Physics');
        const cHeading = headings.find(h => h.subject === 'Chemistry');
        const mHeading = headings.find(h => h.subject === 'Mathematics');

        const totalPages = pages.length;
        const third1 = Math.max(1, Math.floor(totalPages / 3));
        const third2 = Math.max(2, Math.floor((totalPages * 2) / 3));

        const pStart = pHeading ? { page: pHeading.page, y: pHeading.y } : { page: 1, y: 0 };
        const pEnd = cHeading ? { page: cHeading.page, y: cHeading.y } : (mHeading ? { page: mHeading.page, y: mHeading.y } : { page: third1 + 1, y: 0 });

        const cStart = cHeading ? { page: cHeading.page, y: cHeading.y } : { page: third1 + 1, y: 0 };
        const cEnd = mHeading ? { page: mHeading.page, y: mHeading.y } : { page: third2 + 1, y: 0 };

        const mStart = mHeading ? { page: mHeading.page, y: mHeading.y } : { page: third2 + 1, y: 0 };
        const mEnd = { page: totalPages + 1, y: 0 };

        sections = [
          { subject: 'Physics', firstId: 1, lastId: 25, start: pStart, end: pEnd },
          { subject: 'Chemistry', firstId: 26, lastId: 50, start: cStart, end: cEnd },
          { subject: 'Mathematics', firstId: 51, lastId: 75, start: mStart, end: mEnd }
        ];

        const chemCandidates = allCandidates.filter(c => isCandidateInSection(c, cStart, cEnd));
        const mathCandidates = allCandidates.filter(c => isCandidateInSection(c, mStart, mEnd));

        const isPartitioned = (chemCandidates.some(c => c.number >= 1 && c.number <= 15) || mathCandidates.some(c => c.number >= 1 && c.number <= 15)) || !chemCandidates.some(c => c.number >= 26 && c.number <= 50);

        const chosen = new Map();

        if (!isPartitioned) {
          for (const sec of sections) {
            const secCandidates = allCandidates.filter(c => isCandidateInSection(c, sec.start, sec.end));
            for (let g = sec.firstId; g <= sec.lastId; g++) {
              const forQ = secCandidates.filter(c => c.number === g);
              if (forQ.length) {
                forQ.sort((a, b) => (b.isExplicit ? 50 : 0) - (a.isExplicit ? 50 : 0));
                chosen.set(g, { ...forQ[0], number: g });
              }
            }
          }
        } else {
          for (const sec of sections) {
            const secCandidates = allCandidates.filter(c => isCandidateInSection(c, sec.start, sec.end));
            for (let local = 1; local <= 25; local++) {
              const globalId = sec.firstId + local - 1;
              const forQ = secCandidates.filter(c => c.number === local);
              if (forQ.length) {
                forQ.sort((a, b) => (b.isExplicit ? 50 : 0) - (a.isExplicit ? 50 : 0));
                chosen.set(globalId, { ...forQ[0], number: globalId });
              }
            }
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

        const sec = sections.find(s => q >= s.firstId && q <= s.lastId);
        const secEnd = sec ? sec.end : null;

        let next = null;
        const maxSearch = sec ? Math.min(75, sec.lastId + 1) : 75;
        for (let nextQ = q + 1; nextQ <= maxSearch; nextQ++) {
          if (markerMap.has(nextQ)) { next = markerMap.get(nextQ); break; }
        }

        const candidatesOnPage = allCandidates.filter(c =>
          c.page === start.page &&
          c.column === start.column &&
          c.y > start.y + 35 &&
          (!sec || isCandidateInSection(c, sec.start, sec.end))
        );
        candidatesOnPage.sort((a, b) => a.y - b.y);
        const nextCandOnPage = candidatesOnPage[0] || null;

        const pieces = getCropPieces(pages, start, next, nextCandOnPage, secEnd);
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
    extractQuestions: async (...args) => {
      const [file, expected, onProgress] = args;
      if (window.JeeShiftPdfDetector && await window.JeeShiftPdfDetector.detect(file)) {
        const res = await window.JeeShiftPdfDetector.process(file, { onProgress });
        return res.questionBlobs;
      }
      return imageCrops(...args);
    },
    extractAnswers: async (...args) => {
      const [file, onProgress] = args;
      if (window.JeeShiftPdfDetector && await window.JeeShiftPdfDetector.detect(file)) {
        const res = await window.JeeShiftPdfDetector.process(file, { onProgress });
        return res.answers;
      }
      return answerMap(...args);
    },
    extractSolutions: async (...args) => {
      const [file, onProgress] = args;
      if (window.JeeShiftPdfDetector && await window.JeeShiftPdfDetector.detect(file)) {
        const res = await window.JeeShiftPdfDetector.process(file, { onProgress });
        const map = new Map();
        res.solutionBlobs.forEach((b, idx) => { if (b) map.set(idx + 1, b); });
        return map;
      }
      return solutionMap(...args);
    }
  };
})();
