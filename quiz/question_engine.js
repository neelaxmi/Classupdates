const RENDER_SCALE = 3.0;
const isProcessingAnswers = false;
let pdfDoc = null, pdfDocAnswers = null;
const aConfig = {startPage:1,endPage:1,topMargin:0,bottomMargin:1};
let currentExercise = '';
let extractedImages = [];
let globalLayoutState = {columns:[],pageLayouts:{}};
let qConfig = {startPage:1,endPage:1,topMargin:0,bottomMargin:1,margins:{top:0,bottom:0}};
function getActiveConfig(){return qConfig;}

function classifyQuestionType(qText) {
    if (!qText || !qText.trim()) return 'Numerical/Subjective';

    if (
        /match\s+the\s+(column|list|following)/i.test(qText) ||
        (/column\s*[-_]?\s*i/i.test(qText) && /column\s*[-_]?\s*ii/i.test(qText)) ||
        (/list\s*[-_]?\s*i/i.test(qText) && /list\s*[-_]?\s*ii/i.test(qText))
    ) {
        return 'Match the Column';
    }

    const mcqPattern1 = /\([a-d]\)/gi;
    const mcqPattern2 = /\([1-4]\)/g;
    const mcqPattern3 = /(?:^|\s)[a-d]\.\s/gi;
    const mcqPattern4 = /(?:^|\s)[1-4]\.\s/g;
    const mcqPattern5 = /\([A-D]\)/g;
    const mcqPattern6 = /(?:^|\s)[A-D]\.\s/g;
    const m1 = (qText.match(mcqPattern1) || []).length;
    const m2 = (qText.match(mcqPattern2) || []).length;
    const m3 = (qText.match(mcqPattern3) || []).length;
    const m4 = (qText.match(mcqPattern4) || []).length;
    const m5 = (qText.match(mcqPattern5) || []).length;
    const m6 = (qText.match(mcqPattern6) || []).length;

    if (m1 >= 2 || m2 >= 2 || m3 >= 2 || m4 >= 2 || m5 >= 2 || m6 >= 2) {
        return 'MCQ';
    }

    return 'Numerical/Subjective';
}

async function detectBulletsFromTextLayer(page, viewport, xMin, xMax, coarseTop, coarseBottom, isPreScan = false) {
    const scale       = viewport.scale;
    const colLeft     = xMin;  
    const colRight    = xMax;
    const colW        = colRight - colLeft;
    const marginRight = colLeft + colW * 0.22; 
    let textContent;
    try {
        textContent = await page.getTextContent();
    } catch (_) {
        return [];
    }
    
    if (!isProcessingAnswers) {
        for (const item of textContent.items) {
            if (item.str && item.str.match(/answer\s*key|answers|hints?\s*&?\s*solutions?/i)) {
                const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
                const itemY = tx[5] - (item.height * scale);
                if (itemY > coarseTop && itemY < coarseBottom) {
                    console.log(`[ANSWER KEY DETECTED] Truncating page at y=${itemY}`);
                    coarseBottom = itemY - 20;
                    break;
                }
            }
        }
    }

    const lineMap = new Map();
    const THRESHOLD = 6;
    const allTextItems = [];
    textContent.items.forEach(item => {
        if (!item.str || !item.str.trim()) return;

        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const canvasX = tx[4];
        const canvasY = tx[5] - (item.height * scale); 
        const itemWidth = (item.width || 0) * scale;
        allTextItems.push({ str: item.str, x: canvasX, y: canvasY, w: itemWidth });
        if (canvasX < xMin || canvasX > xMax) return;   
        if (canvasY < coarseTop - 30 || canvasY > coarseBottom + 30) return;
        let found = null;
        for (const [key, line] of lineMap) {
            if (Math.abs(key - canvasY) < THRESHOLD) { found = key; break; }
        }
        const bucket = found !== null ? lineMap.get(found) : null;
        if (bucket) {
            bucket.items.push({ str: item.str, x: canvasX, y: canvasY, w: itemWidth });
        } else {
            lineMap.set(canvasY, { y: canvasY, items: [{ str: item.str, x: canvasX, y: canvasY, w: itemWidth }] });
        }
    });

    const lines = [...lineMap.values()].sort((a, b) => a.y - b.y);
    lines.forEach(line => line.items.sort((a, b) => a.x - b.x));
    const bullets = [];
    lines.forEach(line => {
        const BULLET_RE = /(?:^|\s)(?:Q\.?\s*)?(\d{1,3}(?:\.\d{1,2})?)(?:\s*[\.\)]|\s+(?=[A-Z\(]))/ig;
        let lineText = "";
        let textSegments = [];
        const gapThreshold = 2.0 * scale; 
        for (let i = 0; i < line.items.length; i++) {
            const item = line.items[i];
            if (i > 0) {
                const prev = line.items[i - 1];
                const gap = item.x - (prev.x + prev.w);
                if (gap >= gapThreshold) {
                    lineText += " ";
                }
            }
            textSegments.push({ startIndex: lineText.length, x: item.x });
            lineText += item.str;
        }
        
        let match;
        const matches = [];
        while ((match = BULLET_RE.exec(lineText)) !== null) {
            const matchIndex = match.index;
                        if (!isProcessingAnswers && matchIndex > 2) {
                continue;
            }
            
            const numberOffset = match[0].indexOf(match[1]);
            const charIndex = matchIndex + numberOffset;
            let matchX = line.items[0].x;
            for (let i = textSegments.length - 1; i >= 0; i--) {
                if (charIndex >= textSegments[i].startIndex) {
                    const localIndex = charIndex - textSegments[i].startIndex;
                    const item = line.items[i];
                    const charLen = item.str.length || 1;
                    matchX = item.x + (localIndex / charLen) * item.w;
                    break;
                }
            }
            
            if (!isProcessingAnswers && !isPreScan && matchX > marginRight) {
                continue;
            }
            
            matches.push({ y: Math.floor(line.y), text: match[1], x: matchX });
        if (!isProcessingAnswers) break;
        }
        
        if (matches.length > 0) {
            if (isProcessingAnswers) {
                bullets.push(...matches);
                console.log(`[ANSWERS] Row detected with ${matches.length} bullets:`, matches.map(m => m.text));
            } else {
                bullets.push(matches[0]);
            }
        }
    });

    if (!isProcessingAnswers && !isPreScan && bullets.length > 0) {
        const bins = new Map();
        bullets.forEach(b => {
            let foundBin = null;
            for (const [binX, count] of bins.entries()) {
                if (Math.abs(binX - b.x) < 15) {
                    foundBin = binX;
                    break;
                }
            }
            if (foundBin !== null) {
                bins.set(foundBin, bins.get(foundBin) + 1);
            } else {
                bins.set(b.x, 1);
            }
        });

        const sortedBins = [...bins.entries()].sort((a, b) => b[1] - a[1]);
        const validColumns = [sortedBins[0][0]];
        const maxCount = sortedBins[0][1];
                for (let i = 1; i < sortedBins.length; i++) {
            const [binX, count] = sortedBins[i];
            if (Math.abs(binX - validColumns[0]) > viewport.width * 0.25) {
                if (count >= 2 || count >= maxCount * 0.2) {
                    validColumns.push(binX);
                    break;
                }
            }
        }
        
        const filteredBullets = bullets.filter(b => {
            return validColumns.some(colX => Math.abs(colX - b.x) < 20); // 20px tolerance
        });
        
        validColumns.sort((a, b) => a - b);
        console.log(`[Q-FILTER] Retained ${filteredBullets.length} out of ${bullets.length} bullets based on column margins:`, validColumns);
        return {
            bullets: filteredBullets,
            newCoarseBottom: coarseBottom,
            validColumns: validColumns,
            textItems: allTextItems
        };
    }

    return {
        bullets: Object.values(bullets),
        newCoarseBottom: coarseBottom,
        validColumns: [],
        textItems: allTextItems
    };
}

function romanToArabic(str) {
    const roman = str.toUpperCase().trim();
    const map = {
        'I': '1', 'II': '2', 'III': '3', 'IV': '4', 'V': '5',
        'VI': '6', 'VII': '7', 'VIII': '8', 'IX': '9', 'X': '10'
    };
    return map[roman] || str;
}

async function detectExerciseHeadersFromPage(page, viewport) {
    let textContent;
    try {
        textContent = await page.getTextContent();
    } catch (_) {
        return [];
    }

    const scale = viewport.scale;
    const lineMap = new Map();
    const THRESHOLD = 6;

    textContent.items.forEach(item => {
        if (!item.str || !item.str.trim()) return;
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        const canvasY = tx[5] - (item.height * scale);
        
        let found = null;
        for (const [key, line] of lineMap) {
            if (Math.abs(key - canvasY) < THRESHOLD) { found = key; break; }
        }
        const itemWidth = (item.width || 0) * scale;
        if (found !== null) {
            lineMap.get(found).items.push({ str: item.str, x: tx[4], w: itemWidth });
        } else {
            lineMap.set(canvasY, { y: canvasY, items: [{ str: item.str, x: tx[4], w: itemWidth }] });
        }
    });

    const headers = [];
    for (const [y, line] of lineMap) {
        line.items.sort((a, b) => a.x - b.x);
        const lineText = line.items.map(it => it.str).join(" ")
            .replace(/[\u2013\u2014\u2212]/g, '-'); 
        const match = lineText.match(/(?:EXERCISE|DPP|SHEET|SECTION|SELF ASSESSMENT|PRACTICE SHEET|TEST)\s*[-:\s]*\s*([0-9IVXivx\.]+)/i);
        if (match) {
            const type = match[0].match(/EXERCISE|DPP|SHEET|SECTION|SELF ASSESSMENT|PRACTICE SHEET|TEST/i)[0];
            const num = match[1];
            const normalizedNum = romanToArabic(num);
            const capitalized = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
            const headerName = `${capitalized} ${normalizedNum}`;
            console.log(`[HEADER] Detected: "${headerName}" at y=${Math.floor(y)}`);
            headers.push({ y: Math.floor(y), name: headerName, x: line.items[0].x });
        }
    }
    headers.sort((a, b) => a.y - b.y);
    return headers;
}

async function preScanDocument(doc, config) {
    if (isProcessingAnswers) return;

    globalLayoutState = { columns: [], pageLayouts: {} };
    
    const globalBins = new Map();
    const pageBulletsMap = {};
    const numPages = config.endPage ? Math.min(config.endPage, doc.numPages) : doc.numPages;
    for (let pageNum = config.startPage; pageNum <= numPages; pageNum++) {
        const page = await doc.getPage(pageNum);
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        
        let topPx = 0, botPx = viewport.height;
        if (config.margins) {
            topPx = (config.margins.top / 100) * viewport.height;
            botPx = viewport.height - ((config.margins.bottom / 100) * viewport.height);
        }
        
        const result = await detectBulletsFromTextLayer(page, viewport, 0, viewport.width, topPx, botPx, true);
        const bullets = result.bullets;
        
        pageBulletsMap[pageNum] = bullets;
        
        bullets.forEach(b => {
            let foundBin = null;
            for (const [binX, count] of globalBins.entries()) {
                if (Math.abs(binX - b.x) < 15) {
                    foundBin = binX;
                    break;
                }
            }
            if (foundBin !== null) {
                globalBins.set(foundBin, globalBins.get(foundBin) + 1);
            } else {
                globalBins.set(b.x, 1);
            }
        });
    }
    
    if (globalBins.size > 0) {
        const sortedBins = [...globalBins.entries()].sort((a, b) => b[1] - a[1]);
        const validColumns = [sortedBins[0][0]];
        const maxCount = sortedBins[0][1];
        
        for (let i = 1; i < sortedBins.length; i++) {
            const [binX, count] = sortedBins[i];
            if (Math.abs(binX - validColumns[0]) > 200) { // e.g., separated by distance
                if (count >= Math.max(2, maxCount * 0.1)) {
                    validColumns.push(binX);
                    break; // Max 2 columns
                }
            }
        }
        validColumns.sort((a, b) => a - b);
        globalLayoutState.columns = validColumns;
        console.log(`[PRE-SCAN] Detected global columns at:`, validColumns);
    }
    
    for (let pageNum = config.startPage; pageNum <= numPages; pageNum++) {
        const bullets = pageBulletsMap[pageNum] || [];
        
        if (globalLayoutState.columns.length === 2) {
            const midX = (globalLayoutState.columns[0] + globalLayoutState.columns[1]) / 2;
            const hasLeft = bullets.some(b => b.x < midX);
            const hasRight = bullets.some(b => b.x >= midX);
            
            if (hasLeft && hasRight) {
                globalLayoutState.pageLayouts[pageNum] = 2;
            } else {
                globalLayoutState.pageLayouts[pageNum] = 1;
            }
        } else {
            globalLayoutState.pageLayouts[pageNum] = 1;
        }
    }
}

async function processPage(pageNum, startPage, endPage, worker, doc = pdfDoc, config = qConfig) {
    if (!isProcessingAnswers && pdfDocAnswers === doc) {
        if (pageNum > aConfig.startPage) {
            return;
        }
    }

    const page     = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width  = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const topPct = config.topMargin;
    let botPct = config.bottomMargin;
    if (!isProcessingAnswers && pdfDocAnswers === doc && pageNum === aConfig.startPage) {
        botPct = Math.min(botPct, aConfig.topMargin);
    }

    const coarseTop    = Math.floor(topPct * viewport.height);
    const coarseBottom = Math.floor(botPct * viewport.height);
    const pageLayout = globalLayoutState.pageLayouts[pageNum] || 1;
    const pageHeaders = await detectExerciseHeadersFromPage(page, viewport);
    const processColumn = async (cropX, cropW) => {
        const result = await detectBulletsFromTextLayer(page, viewport, cropX, cropX + cropW, coarseTop, coarseBottom);
        const colBullets = result.bullets;
        let newCoarseBottom = result.newCoarseBottom; 
        if (colBullets.length === 0) return;
        const yBands = [];
        colBullets.sort((a, b) => a.y - b.y);
        for (const b of colBullets) {
            let added = false;
            for (const band of yBands) {
                if (Math.abs(band.y - b.y) < 15) {
                    band.bullets.push(b);
                    band.y = Math.min(band.y, b.y); 
                    added = true;
                    break;
                }
            }
            if (!added) {
                yBands.push({ y: b.y, bullets: [b] });
            }
        }
        
        yBands.sort((a, b) => a.y - b.y);

        const colLinesMap = new Map();
        for (const item of (result.textItems || [])) {
            if (item.x >= cropX - 20 && item.x <= cropX + cropW + 20) {
                let found = null;
                for (const [y, line] of colLinesMap) {
                    if (Math.abs(y - item.y) < 6) { found = y; break; }
                }
                if (found) {
                    colLinesMap.get(found).push(item);
                } else {
                    colLinesMap.set(item.y, [item]);
                }
            }
        }
        
        const compYStarts = [];
        for (const [y, items] of colLinesMap) {
            items.sort((a, b) => a.x - b.x);
            const text = items.map(it => it.str).join(' ').trim();
            if (/^(?:comprehension|passage|paragraph|read the following)/i.test(text) || 
                /(?:comprehension|passage|paragraph)\s*(?:type|for|[-:\d])/i.test(text) ||
                text.toLowerCase().includes("comprehension type") ||
                text.toLowerCase().includes("paragraph for")) {
                compYStarts.push(y);
            }
        }
        compYStarts.sort((a, b) => a - b);

        const splitPoints = [];
        for (let i = 0; i < yBands.length; i++) {
            let defaultSplit = yBands[i].y - 15;
            let prevY = (i === 0) ? coarseTop : yBands[i-1].y + 15;
            let bestCompY = null;
            for (const cy of compYStarts) {
                if (cy > prevY && cy < yBands[i].y) {
                    if (bestCompY === null || cy < bestCompY) {
                        bestCompY = cy;
                    }
                }
            }
            
            if (bestCompY !== null) {
                splitPoints.push(Math.max(coarseTop, bestCompY - 15));
            } else {
                splitPoints.push(Math.max(coarseTop, defaultSplit));
            }
        }
        splitPoints.push(newCoarseBottom);

        let orphanTop = coarseTop;
        let orphanBottom = splitPoints[0];
        let lowestHeaderY = null;
        for (const hdr of pageHeaders) {
            if (hdr.x >= cropX && hdr.x < cropX + cropW) {
                if (hdr.y >= coarseTop && hdr.y < orphanBottom) {
                    lowestHeaderY = hdr.y + 30; 
                }
            }
        }
        
        if (lowestHeaderY !== null) {
            orphanTop = lowestHeaderY;
        }

        const orphanH = orphanBottom - orphanTop;
        if (orphanH > 10 && extractedImages.length > 0 && !isProcessingAnswers) {
            const orphanCanvas = cropCanvas(canvas, cropX, orphanTop, cropW, orphanH);
            if (orphanCanvas) {
                const prev = extractedImages[extractedImages.length - 1];
                prev.dataUrl = await stitchImages(prev.dataUrl, orphanCanvas);
            }
        }

        for (let i = 0; i < yBands.length; i++) {
            const band = yBands[i];
            
            let rowTop = splitPoints[i];
            let rowBottom;
            if (i < yBands.length - 1) {
                rowBottom = Math.min(newCoarseBottom, splitPoints[i+1] + 13);
            } else {
                rowBottom = newCoarseBottom;
            }
            
            for (const hdr of pageHeaders) {
                if (hdr.x >= cropX && hdr.x < cropX + cropW) {
                    if (hdr.y > band.y && hdr.y < rowBottom) {
                        rowBottom = hdr.y - 5;
                    }
                }
            }
            
            const h = rowBottom - rowTop;
            if (h <= 5) continue;
            
            const cropped = cropCanvas(canvas, cropX, rowTop, cropW, h);
            if (!cropped) continue;
            
            for (const hdr of pageHeaders) {
                if (hdr.x >= cropX && hdr.x < cropX + cropW && hdr.y < band.y && !hdr.used) {
                    currentExercise = hdr.name;
                    hdr.used = true;
                }
            }
            
            const nums = band.bullets.map(b => b.text).join(', ');
            let labelStr = `Q. ${nums}`;
            if (currentExercise) labelStr = `${currentExercise} - ${labelStr}`;
            const qItems = (result.textItems || []).filter(item => 
                item.x >= cropX - 5 && item.x <= cropX + cropW + 5 &&
                item.y >= rowTop - 5 && item.y <= rowBottom + 5
            );
            qItems.sort((a, b) => {
                if (Math.abs(a.y - b.y) > 6) return a.y - b.y;
                return a.x - b.x;
            });
            const qText = qItems.map(item => item.str).join(' ');
            const qType = classifyQuestionType(qText);
            extractedImages.push({
                id:      `q_${pageNum}_${Math.random().toString(36).substr(2,6)}`,
                dataUrl: cropped.toDataURL('image/png'),
                page:    pageNum,
                label:   `${labelStr} [${qType}]`,
                type:    qType,
                qNums:   band.bullets.map(b => b.text)
            });
        }
        
        for (const hdr of pageHeaders) {
            if (hdr.x >= cropX && hdr.x < cropX + cropW && !hdr.used) {
                currentExercise = hdr.name;
                hdr.used = true;
            }
        }
    };

    if (pageLayout === 2 && !isProcessingAnswers && globalLayoutState.columns.length === 2) {
        const splitX = globalLayoutState.columns[1] - 15;
        await processColumn(0, splitX);
        await processColumn(splitX, viewport.width - splitX);
    } else {
        await processColumn(0, viewport.width);
    }
}

function cropCanvas(sourceCanvas, x, y, w, h) {
    if (w <= 0 || h <= 0) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(sourceCanvas, x, y, w, h, 0, 0, w, h);
    return c;
}

async function stitchImages(topDataUrl, bottomCanvas) {
    return new Promise((resolve) => {
        const topImg = new Image();
        topImg.onload = () => {
            const w = Math.max(topImg.width, bottomCanvas.width);
            const h = topImg.height + bottomCanvas.height;
            
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.drawImage(topImg, 0, 0);
            ctx.drawImage(bottomCanvas, 0, topImg.height);
            resolve(c.toDataURL('image/png'));
        };
        topImg.src = topDataUrl;
    });
}

async function getPdfPageCount(file) {
    const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    return doc.numPages;
}

async function runQuestionExtraction(file, opts, onProgress) {
    opts = opts || {};
    extractedImages = [];
    pdfDoc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;

    const start = Math.max(1, Number(opts.startPage) || 1);
    const end   = Math.min(pdfDoc.numPages, Math.max(start, Number(opts.endPage) || pdfDoc.numPages));
    const top    = Math.min(0.9, Math.max(0, (Number(opts.topPct)    || 0) / 100));
    const bottom = Math.min(0.9, Math.max(0, (Number(opts.bottomPct) || 0) / 100));

    qConfig = { startPage: start, endPage: end, topMargin: top, bottomMargin: 1 - bottom,
                margins: { top: top * 100, bottom: bottom * 100 } };
    globalLayoutState = { columns: [], pageLayouts: {} };
    currentExercise = '';

    if (onProgress) onProgress(0, end - start + 1, 'Scanning layout');
    await preScanDocument(pdfDoc, qConfig);
    for (let p = start; p <= end; p++) {
        if (onProgress) onProgress(p - start, end - start + 1, `Reading page ${p} of ${end}`);
        await processPage(p, start, end, null, pdfDoc, qConfig);
    }
    if (onProgress) onProgress(end - start + 1, end - start + 1, 'Done');
    return { numPages: pdfDoc.numPages, startPage: start, endPage: end, items: extractedImages.slice() };
}
