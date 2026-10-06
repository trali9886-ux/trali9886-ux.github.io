/* Extract one embedded worked-solution image for each numbered question in a solution PDF. */
window.JeeSolutionPdfFallback = async function (file) {
  if (!file) return new Map();
  const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const solutions = new Map();
  const OPS = { save: 10, restore: 11, transform: 12, paintImageXObject: 85 };
  function multiply(m, n) {
    return [m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];
  }
  try {
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const text = (await page.getTextContent()).items.map(item => item.str).join(" ");
      if (!/\bEXPLANATIONS\b/i.test(text)) continue;
      const labels = [...text.matchAll(/\bQ\s*(\d{1,2})\s*[—–-]\s*Explanation\b/gi)].map(match => Number(match[1]));
      if (!labels.length) continue;
      const viewport = page.getViewport({ scale: 1.6 });
      const list = await page.getOperatorList(), images = [];
      let ctm = [1,0,0,1,0,0]; const stack = [];
      for (let i=0;i<list.fnArray.length;i++) {
        const op=list.fnArray[i], args=list.argsArray[i]||[];
        if (op===OPS.save) stack.push(ctm);
        else if (op===OPS.restore) ctm=stack.pop()||[1,0,0,1,0,0];
        else if (op===OPS.transform) {
          const matrix=args.length>=6&&args.slice(0,6).every(Number.isFinite)?args:args[0];
          if(matrix?.length>=6) ctm=multiply(ctm,matrix);
        } else if (op===OPS.paintImageXObject) {
          const pts=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>viewport.convertToViewportPoint(ctm[0]*x+ctm[2]*y+ctm[4],ctm[1]*x+ctm[3]*y+ctm[5]));
          const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]);
          const left=Math.max(0,Math.floor(Math.min(...xs))), top=Math.max(0,Math.floor(Math.min(...ys)));
          const right=Math.min(Math.ceil(viewport.width),Math.ceil(Math.max(...xs))), bottom=Math.min(Math.ceil(viewport.height),Math.ceil(Math.max(...ys)));
          if(right-left>12&&bottom-top>12) images.push({left,top,right,bottom});
        }
      }
      if (images.length !== labels.length) throw new Error(`Could not match the ${labels.length} explanation labels on answer-key page ${pageNo} to its ${images.length} images.`);
      // The solution sheets use two columns; read down the left column before the right.
      images.sort((a,b)=>a.left-b.left||a.top-b.top);
      const canvas=Object.assign(document.createElement("canvas"),{width:Math.ceil(viewport.width),height:Math.ceil(viewport.height)});
      await page.render({canvasContext:canvas.getContext("2d"),viewport,canvas}).promise;
      for(let i=0;i<labels.length;i++) {
        const number=labels[i];
        if(solutions.has(number)) throw new Error(`Question ${number} has duplicate explanations in the uploaded PDF.`);
        const image=images[i], crop=Object.assign(document.createElement("canvas"),{width:image.right-image.left,height:image.bottom-image.top});
        crop.getContext("2d").drawImage(canvas,image.left,image.top,crop.width,crop.height,0,0,crop.width,crop.height);
        const blob=await new Promise((resolve,reject)=>crop.toBlob(value=>value?resolve(value):reject(new Error(`Could not render explanation ${number}.`)),"image/webp",0.9));
        solutions.set(number,blob);
      }
    }
    if (solutions.size && solutions.size !== 75) throw new Error(`Found ${solutions.size} of 75 worked explanations in the uploaded answer-key PDF.`);
    return solutions;
  } finally { await pdf.cleanup(); }
};
