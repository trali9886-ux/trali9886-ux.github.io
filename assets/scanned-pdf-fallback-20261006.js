/* Additive support for JEE PDFs whose questions are embedded as one image per question. */
window.JeeScannedPdfFallback = async function (pdf, expected, onProgress = () => {}) {
  if (expected !== 75) return null;
  const pageGroups = new Map();
  const supported = new Set(["1-25", "26-50", "51-75"]);
  const ops = { save: 10, restore: 11, transform: 12, paintImageXObject: 85 };

  function multiply(m, n) {
    return [
      m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }

  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const text = (await page.getTextContent()).items.map(item => item.str).join(" ");
      const match = text.match(/Questions\s*(\d{1,2})\s*[-–—]\s*(\d{1,2})/i);
      if (!match) continue;
      const key = `${Number(match[1])}-${Number(match[2])}`;
      if (!supported.has(key)) return null;

      const viewport = page.getViewport({ scale: 1.6 });
      const list = await page.getOperatorList();
      const images = [];
      let ctm = [1, 0, 0, 1, 0, 0];
      const stack = [];
      for (let i = 0; i < list.fnArray.length; i++) {
        const op = list.fnArray[i], args = list.argsArray[i] || [];
        if (op === ops.save) stack.push(ctm);
        else if (op === ops.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        else if (op === ops.transform && args[0]?.length >= 6) ctm = multiply(ctm, args[0]);
        else if (op === ops.paintImageXObject) {
          const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) =>
            viewport.convertToViewportPoint(ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]));
          const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
          const left = Math.max(0, Math.floor(Math.min(...xs))), top = Math.max(0, Math.floor(Math.min(...ys)));
          const right = Math.min(Math.ceil(viewport.width), Math.ceil(Math.max(...xs)));
          const bottom = Math.min(Math.ceil(viewport.height), Math.ceil(Math.max(...ys)));
          if (right - left > 12 && bottom - top > 12) images.push({ left, top, right, bottom });
        }
      }
      if (!images.length) return null;
      // These papers use two columns. Read down each column, left column first.
      images.sort((a, b) => a.left - b.left || a.top - b.top);
      const pages = pageGroups.get(key) || [];
      pages.push({ page, viewport, images });
      pageGroups.set(key, pages);
    }

    if (["1-25", "26-50", "51-75"].some(key => !pageGroups.has(key))) return null;
    const counts = Object.fromEntries([...pageGroups].map(([key, pages]) => [key, pages.reduce((sum, page) => sum + page.images.length, 0)]));
    if (["1-25", "26-50", "51-75"].some(key => counts[key] !== 25)) return null;

    const questionImages = new Array(75);
    const progressOrder = ["1-25", "26-50", "51-75"];
    for (const key of progressOrder) {
      const [first] = key.split("-").map(Number);
      let questionNo = first;
      for (const { page, viewport, images } of pageGroups.get(key)) {
        const canvas = Object.assign(document.createElement("canvas"), {
          width: Math.ceil(viewport.width), height: Math.ceil(viewport.height)
        });
        await page.render({ canvasContext: canvas.getContext("2d"), viewport, canvas }).promise;
        for (const image of images) {
          const crop = Object.assign(document.createElement("canvas"), {
            width: image.right - image.left, height: image.bottom - image.top
          });
          crop.getContext("2d").drawImage(canvas, image.left, image.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
          questionImages[questionNo - 1] = await new Promise((resolve, reject) =>
            crop.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not render scanned question image")), "image/webp", 0.77));
          onProgress(questionNo, expected);
          questionNo++;
        }
      }
      if (questionNo !== Number(key.split("-")[1]) + 1) return null;
    }
    return questionImages.every(Boolean) ? questionImages : null;
  } catch (error) {
    console.warn("Scanned PDF fallback could not parse this document", error);
    return null;
  }
};
