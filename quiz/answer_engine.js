function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function cleanAnswer(v){
  if(v===null || v===undefined) return "";
  let s=String(v).trim().toUpperCase();
  s=s.replace(/^[`"' ]+|[`"' ]+$/g,"");
  s=s.replace(/\s+/g,"");
  s=s.replace(/[，、]/g,",");
  s=s.replace(/^\(|\)$/g,"");
  return s;
}

function cleanQuestion(v){
  if(v===null || v===undefined) return "";
  let s=String(v).trim();
  s=s.replace(/[^\d]/g,"");
  return s;
}

function normalizePayload(payload){
  let arr = [];
  if(Array.isArray(payload)) arr = payload;
  else if(payload && Array.isArray(payload.answers)) arr = payload.answers;
  else if(payload && Array.isArray(payload.data)) arr = payload.data;
  else if(payload && Array.isArray(payload.results)) arr = payload.results;

  const map = new Map();
  for(const x of arr){
    if(!x || typeof x!=="object") continue;
    const q=cleanQuestion(x.Questionsnumber ?? x.question ?? x.questionNumber ?? x.q ?? x.number);
    const a=cleanAnswer(x.CorrectAnswer ?? x.answer ?? x.correctAnswer ?? x.ans);
    if(!q || !a) continue;
    if(!map.has(q)) map.set(q,a);
  }
  return [...map.entries()]
    .sort((a,b)=>Number(a[0])-Number(b[0]))
    .map(([q,a])=>({Questionsnumber:q,CorrectAnswer:a}));
}

function extractJson(text){
  if(typeof text!=="string") throw new Error("Gemini returned non-text output.");
  let s=text.trim();
  s=s.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  try { return JSON.parse(s); } catch {}
  const first=s.indexOf("{"), last=s.lastIndexOf("}");
  if(first>=0 && last>first){
    try { return JSON.parse(s.slice(first,last+1)); } catch {}
  }
  const a=s.indexOf("["), b=s.lastIndexOf("]");
  if(a>=0 && b>a){
    try { return JSON.parse(s.slice(a,b+1)); } catch {}
  }
  throw new Error("Could not parse Gemini JSON response.");
}

const SYSTEM_PROMPT = `
You are an expert answer-key document reader.

Your job is NOT to solve the questions. Read ONLY the marked/printed correct answers shown in the answer-key document image.

You must visually inspect the entire image and preserve its layout:
- one-column lists
- two-column lists
- multi-column tables
- grid tables
- rows such as "1 2 3 4 / A B C D"
- cells such as "Q1 (2)", "1. (c)", "Q32 (3)", "Q1 A"
- answer keys split across sections/pages
- printed option numbers (1,2,3,4) and letters (A,B,C,D)
- multiple-answer forms such as "(b,c)" or "3,4"
- "none"/"all"/special answer markings when explicitly printed

IMPORTANT:
1. Do not infer an answer from the question text.
2. Do not solve the question.
3. Do not assume missing question numbers.
4. Do not invent entries.
5. Read all visible answer rows/cells, including dense tables.
6. If a specific cell is genuinely unreadable, omit ONLY that uncertain entry rather than guessing.
7. Question numbers may be non-consecutive; preserve what is visibly present.
8. If the same question appears twice, keep the visually clearer/explicit answer only.
9. Return question number as a string.
10. CorrectAnswer must preserve what the answer key denotes, normally A/B/C/D or 1/2/3/4; for multiple answers preserve them compactly, e.g. "B,C" or "2,4".
11. Ignore page numbers, question-paper text, marks, headers, dates, roll numbers, and unrelated text.

Return ONLY valid JSON in this exact shape:
{
  "answers": [
    {"Questionsnumber":"1","CorrectAnswer":"A"}
  ]
}
No markdown. No explanation.
`;

async function fileToPages(file, scale){
  if(file.type==="application/pdf" || file.name.toLowerCase().endsWith(".pdf")){
    const buf=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:buf}).promise;
    const pages=[];
    for(let p=1;p<=pdf.numPages;p++){
      const page=await pdf.getPage(p);
      const viewport=page.getViewport({scale});
      const canvas=document.createElement("canvas");
      canvas.width=Math.ceil(viewport.width);
      canvas.height=Math.ceil(viewport.height);
      const ctx=canvas.getContext("2d",{alpha:false});
      ctx.fillStyle="#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
      await page.render({canvasContext:ctx,viewport}).promise;
      pages.push({page:p,dataUrl:canvas.toDataURL("image/jpeg",0.93)});
    }
    return pages;
  }
  return [{page:1,dataUrl:await new Promise((resolve,reject)=>{
    const r=new FileReader();
    r.onload=()=>resolve(r.result);
    r.onerror=reject;
    r.readAsDataURL(file);
  })}];
}

async function compressDataUrl(dataUrl, maxBytes){
  maxBytes = maxBytes || 13*1024*1024;
  const img=await new Promise((resolve,reject)=>{
    const i=new Image(); i.onload=()=>resolve(i); i.onerror=reject; i.src=dataUrl;
  });
  let maxDim=Math.max(img.naturalWidth,img.naturalHeight);
  let scale=1;
  if(maxDim>6500) scale=6500/maxDim;
  let q=0.92, d=dataUrl;
  for(let attempt=0;attempt<10;attempt++){
    const c=document.createElement("canvas");
    c.width=Math.max(1,Math.round(img.naturalWidth*scale));
    c.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const x=c.getContext("2d",{alpha:false});
    x.fillStyle="#fff"; x.fillRect(0,0,c.width,c.height);
    x.drawImage(img,0,0,c.width,c.height);
    d=c.toDataURL("image/jpeg",q);
    const bytes=Math.round((d.length-d.indexOf(",")-1)*0.75);
    if(bytes<maxBytes) return d;
    if(q>0.62) q-=0.08;
    else scale*=0.82;
  }
  return d; 
}

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_RPM = 10;
const GEMINI_MAX_OUT = 8192;  
const GEMINI_THINKING_BUDGET = 0;
const LIM = { rpm: GEMINI_RPM, maxOut: GEMINI_MAX_OUT };
const PACE = { stamps: [] };
const PROG = { say: null, calls: 0, planned: 0, waitSec: 0, t0: 0, guessPer: 8, label: "" };
function progInfo(){
  const el = (Date.now() - PROG.t0) / 1000, rem = Math.max(0, PROG.planned - PROG.calls);
  const per = PROG.calls >= 2 ? el / PROG.calls : PROG.guessPer;
  return { calls: PROG.calls, planned: PROG.planned, waitSec: PROG.waitSec, etaSec: Math.round(rem * per), elapsedSec: Math.round(el) };
}
function progSay(msg){
  if(msg !== undefined) PROG.label = msg;
  if(PROG.say) PROG.say(PROG.calls, Math.max(PROG.planned, 1), PROG.label, progInfo());
}
function progStart(cb){
  PROG.say = cb || null; PROG.calls = 0; PROG.planned = 0; PROG.waitSec = 0; PROG.t0 = Date.now(); PROG.label = "";
}
async function waitWithStatus(ms){
  const end = Date.now() + ms;
  while(Date.now() < end){
    PROG.waitSec = Math.ceil((end - Date.now()) / 1000);
    progSay();
    await sleep(Math.min(1000, Math.max(50, end - Date.now())));
  }
  PROG.waitSec = 0; progSay();
}
async function paceWait(){
  if(!LIM.rpm) return;
  for(;;){
    const now = Date.now();
    PACE.stamps = PACE.stamps.filter(t => now - t < 60000);
    if(PACE.stamps.length < LIM.rpm){ PACE.stamps.push(now); return; }
    await waitWithStatus(Math.max(500, PACE.stamps[0] + 60000 - now + 200));
  }
}
function parseWaitMs(text, obj){
  const det = obj && obj.error && obj.error.details;
  if(Array.isArray(det)) for(const d of det){
    const m = d && d.retryDelay && /^(\d+(?:\.\d+)?)s$/.exec(String(d.retryDelay));
    if(m) return parseFloat(m[1]) * 1000;
  }
  const m = /retry in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(String(text || ""));
  if(!m) return 0;
  return parseFloat(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000);
}

function dataUrlToInline(u){
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(String(u || ""));
  if(!m) throw new Error("Image is not a valid base64 data URL.");
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

async function geminiPost(apiKey, model, system, parts){
  await paceWait();
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0, maxOutputTokens: LIM.maxOut, thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } }
  };
  if(system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetch(GEMINI_API_BASE + encodeURIComponent(model) + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body)
  });
  const raw = await res.text();
  if(!res.ok){
    let obj = null, d = raw; try { obj = JSON.parse(raw); d = obj?.error?.message || raw; } catch {}
    let status = res.status;
    if(status === 401 || /API key not valid|API_KEY_INVALID|API key expired/i.test(raw)) status = 401; 
    const daily = status === 429 && /PerDay/i.test(raw);
    const err = new Error(`Gemini API error (${status}): ${daily ? "daily quota used up. " : ""}${d}`);
    err.status = status;
    err.daily = daily;
    err.tooLarge = status === 413 || /payload size|request.{0,20}too large|exceeds the maximum/i.test(d);
    const ra = parseFloat(res.headers && res.headers.get ? res.headers.get("retry-after") : "");
    err.retryMs = ra > 0 ? ra * 1000 : parseWaitMs(d, obj);
    throw err;
  }
  const obj = JSON.parse(raw);
  PROG.calls++; progSay();
  const cand = obj?.candidates?.[0];
  let text = (cand?.content?.parts || []).filter(p => p && !p.thought && typeof p.text === "string").map(p => p.text).join("");
  const finishReason = cand?.finishReason || "";
  if(!text.trim()){
    const block = obj?.promptFeedback?.blockReason;
    if(block) throw new Error(`Gemini blocked this request (${block}).`);
    throw new Error(`Gemini returned no text (${finishReason || "empty reply"}).`);
  }
  if(finishReason === "MAX_TOKENS" && text.includes("\n")) text = text.slice(0, text.lastIndexOf("\n"));
  return { text, finishReason, usage: obj.usageMetadata || null };
}

const SYSTEM_PROMPT_COMPACT = SYSTEM_PROMPT
  .replace("CorrectAnswer must", "The answer must")
  .replace(/Return ONLY valid JSON[\s\S]*$/, 'Return ONLY the answers, one per line, as number:answer. Example:\n1:A\n2:C\n12:B,C\nNo JSON, no markdown, no headings, no explanation.\n');

function salvagePairs(text){
  const out = [], re = /"(?:q|Questionsnumber)"\s*:\s*"?(\d{1,3})"?\s*,\s*"(?:ans|CorrectAnswer)"\s*:\s*"([^"]{1,12})"/g; let m;
  while((m = re.exec(String(text || "")))) out.push({ q: m[1], ans: m[2] });
  return out;
}
function parseLines(text){
  const out = [], re = /(?<![\d.])(\d{1,3})\s*[:=\-\u2013.)]\s*\(?([A-Da-d1-4](?:\s*,\s*[A-Da-d1-4])*)\)?(?![\w])/g; let m;
  while((m = re.exec(String(text || "")))) out.push({ q: m[1], ans: m[2].replace(/\s+/g, "") });
  return out;
}
function parseReply(content){
  const p = parseLines(content);                       
  if(p.length) return normalizePayload(p);
  try { return normalizePayload(extractJson(content)); } 
  catch(e){ const q = salvagePairs(content); if(q.length) return normalizePayload(q); throw e; }
}

async function callGeminiCustom(apiKey, model, dataUrl, userText){
  const r = await withRetry(() => geminiPost(apiKey, model, SYSTEM_PROMPT_COMPACT, [ dataUrlToInline(dataUrl), { text: userText } ]));
  return parseReply(r.text);
}

async function callGemini(apiKey, model, dataUrl, pageNo, total){
  return callGeminiCustom(apiKey, model, dataUrl,
    `Read this answer-key page ${pageNo} of ${total}. Extract EVERY clearly visible question-number/correct-answer pair. ` +
    `Do a full visual pass over the complete page, including both columns and every table/grid cell. Do not solve any question.`);
}

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
async function runAnswerExtraction(file, apiKey, opts, onProgress){
  opts = opts || {};
  const model = opts.model || DEFAULT_GEMINI_MODEL;
  const scale = Number(opts.scale) || 2.5;
  if(!apiKey) throw new Error("Gemini API key is missing.");
  if(!file) throw new Error("Answer key file is missing.");

  if(onProgress) onProgress(0, 1, "Preparing pages");
  const pages = await fileToPages(file, scale);

  const all = [];
  for(let i=0;i<pages.length;i++){
    if(onProgress) onProgress(i, pages.length, `Reading answer page ${i+1} of ${pages.length}`);
    const img  = await compressDataUrl(pages[i].dataUrl);
    const rows = await callGemini(apiKey, model, img, i+1, pages.length);
    all.push(...rows);
    await sleep(120);
  }
  if(onProgress) onProgress(pages.length, pages.length, "Done");
  const map = new Map();
  for(const x of all){ if(!map.has(x.Questionsnumber)) map.set(x.Questionsnumber, x.CorrectAnswer); }
  return [...map.entries()]
    .sort((p,q)=>Number(p[0])-Number(q[0]))
    .map(([Questionsnumber,CorrectAnswer])=>({Questionsnumber,CorrectAnswer}));
}

const canonAnswer = raw => normalizeOptionLetter(raw) || cleanAnswer(raw);
function rowsToMap(rows){
  const m = new Map();
  for(const r of rows){ const n = parseInt(r.Questionsnumber, 10); if(!isNaN(n) && !m.has(n)) m.set(n, canonAnswer(r.CorrectAnswer)); }
  return m;
}
function itemsToLines(items){
  const toks = [];
  for(const it of items){
    const str = it.str; if(!str || !str.trim()) continue;
    const x0 = it.transform[4], y = it.transform[5], w = it.width || 0, re = /\S+/g; let m;
    while((m = re.exec(str))) toks.push({ t: m[0], x: x0 + w * (m.index / str.length), y });
  }
  toks.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for(const t of toks){
    const L = lines[lines.length - 1];
    if(L && Math.abs(L.y - t.y) <= 3.5) L.tokens.push(t); else lines.push({ y: t.y, tokens: [t] });
  }
  lines.forEach(l => l.tokens.sort((a, b) => a.x - b.x));
  return lines;
}

const INLINE_PAIR = /(?<![\d.])(?:Q\.?\s*)?(\d{1,3})(?:\s*[.):\-\u2013\u2014]\s*\(?\s*([A-Da-d1-4])\s*\)?(?![\w])(?!\s*[,&]\s*[A-Da-d1-4])|\s*\(\s*([A-Da-d1-4])\s*\)(?!\s*[,&])|\s+([A-Da-d])(?![\w]))/g;

function parseAnswerLines(lines, expected, votes){
  votes = votes || new Map();
  const add = (n, v) => {
    const a = normalizeOptionLetter(v); if(!a) return;
    if(expected && !expected.has(n)) return;
    if(!votes.has(n)) votes.set(n, new Set());
    votes.get(n).add(a);
  };
  const isNum = t => /^\d{1,3}$/.test(t), isAns = t => /^\(?[A-Da-d1-4]\)?$/.test(t);
  const used = new Set();
  const lead = (arr, pred) => { let k = 0; while(k < arr.length && !pred(arr[k].t) && k < 2) k++; return arr.slice(k); };

  for(let i = 0; i < lines.length - 1; i++){
    const nt = lead(lines[i].tokens, isNum), at = lead(lines[i + 1].tokens, isAns);
    if(nt.length < 3 || nt.length !== at.length) continue;
    if(!nt.every(t => isNum(t.t)) || !at.every(t => isAns(t.t))) continue;
    const sp = (nt[nt.length - 1].x - nt[0].x) / (nt.length - 1);
    if(!nt.every((t, k) => Math.abs(t.x - at[k].x) <= Math.max(8, sp * 0.6))) continue;
    nt.forEach((t, k) => add(parseInt(t.t, 10), at[k].t));
    used.add(i); used.add(i + 1); i++;
  }
  lines.forEach((ln, i) => {
    if(used.has(i)) return;
    const toks = ln.tokens.map(t => t.t);
    if(toks.length >= 2 && toks.length % 2 === 0){          
      let ok = true; for(let k = 0; k < toks.length; k += 2) if(!isNum(toks[k]) || !isAns(toks[k + 1])) ok = false;
      const seq = toks.length >= 4 && toks.every(isNum) && toks.every((t, k) => k === 0 || +t === +toks[k - 1] + 1);
      if(ok && !seq){ for(let k = 0; k < toks.length; k += 2) add(parseInt(toks[k], 10), toks[k + 1]); return; }
    }
    const text = toks.join(' '); let m; INLINE_PAIR.lastIndex = 0;
    while((m = INLINE_PAIR.exec(text))) add(parseInt(m[1], 10), m[2] || m[3] || m[4]);
  });
  return votes;
}

async function readAnswerTextLayer(file, expected){
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if(!isPdf) return { map: new Map(), usable: false, note: "image file (no text layer)" };
  const doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const votes = new Map();
  for(let p = 1; p <= doc.numPages; p++){
    const tc = await (await doc.getPage(p)).getTextContent();
    parseAnswerLines(itemsToLines(tc.items), expected, votes);
  }
  const map = new Map();
  for(const [n, set] of votes) if(set.size === 1) map.set(n, [...set][0]); 
  const need = expected ? Math.max(3, Math.ceil(expected.size * 0.3)) : 5;
  return { map, usable: map.size >= need, note: map.size ? `${map.size} answers` : "no readable answer text (scanned file?)" };
}

/* ---- voting (pure) ---- */
function consolidateReads(reads, universe, final){
  const decided = new Map(), undecided = [];
  for(const n of [...universe].sort((a, b) => a - b)){
    const votes = [];
    for(const [src, map] of Object.entries(reads)) if(map && map.has(n)) votes.push([src, map.get(n)]);
    const tally = new Map(); votes.forEach(([, v]) => tally.set(v, (tally.get(v) || 0) + 1));
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked[0], tv = votes.find(v => v[0] === "T");
    const strict = top && top[1] >= 2 && (!ranked[1] || ranked[1][1] < top[1]);
    const ok = strict && (final || !tv || tv[1] === top[0]);       
    if(ok) decided.set(n, { value: top[0], level: (votes.length === top[1]) ? "unanimous" : "majority", votes: Object.fromEntries(votes) });
    else undecided.push({ num: n, votes: Object.fromEntries(votes), candidates: [...new Set(votes.map(v => v[1]))] });
  }
  return { decided, undecided };
}

async function withRetry(fn, tries){
  tries = tries || 4;
  let fails = 0, waits = 0;
  for(;;){
    try { return await fn(); }
    catch(e){
      const m = String((e && e.message) || e);
      if(e && (e.tooLarge || e.daily)) throw e;                    
      if(/\(429\)/.test(m)){                                        
        const wait = (e && e.retryMs) || 20000;
        if(wait > 120000 || ++waits > 12) throw e;                
        await waitWithStatus(wait + 300);
        continue;
      }
      const retry = /\((500|502|503|504)\)|Failed to fetch|Could not parse|returned no text/i.test(m);
      if(!retry || ++fails >= tries) throw e;
      await sleep(1500 * Math.pow(2, fails - 1));
    }
  }
}

async function cropDataUrl(dataUrl, y0, y1){
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const top = Math.floor(img.naturalHeight * y0), h = Math.ceil(img.naturalHeight * (y1 - y0));
  const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = h;
  const x = c.getContext("2d", { alpha: false }); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, h);
  x.drawImage(img, 0, top, img.naturalWidth, h, 0, 0, img.naturalWidth, h);
  return c.toDataURL("image/jpeg", 0.93);
}

async function readRegion(apiKey, model, pageUrl, y0, y1, text, depth){
  const img = await compressDataUrl(await cropDataUrl(pageUrl, y0, y1));
  try { return await withRetry(() => callGeminiCustom(apiKey, model, img, text)); }
  catch(e){
    if(!(e && e.tooLarge) || depth >= 3) throw e;
    PROG.planned += 1;
    const mid = (y0 + y1) / 2, ov = (y1 - y0) * 0.06;
    const a = await readRegion(apiKey, model, pageUrl, y0, Math.min(1, mid + ov), text, depth + 1);
    const b = await readRegion(apiKey, model, pageUrl, Math.max(0, mid - ov), y1, text, depth + 1);
    return a.concat(b);
  }
}
function stripBounds(n, ov){
  const out = []; for(let k = 0; k < n; k++) out.push([Math.max(0, k / n - ov), Math.min(1, (k + 1) / n + ov)]); return out;
}
function mergeRows(map, conflict, rows){
  for(const r of rows){
    const n = parseInt(r.Questionsnumber, 10); if(isNaN(n)) continue;
    const v = canonAnswer(r.CorrectAnswer);
    if(map.has(n) && map.get(n) !== v) conflict.add(n); else if(!map.has(n)) map.set(n, v);
  }
}
const stripText = (kind, i, P, k, n) =>
  `This image is strip ${k} of ${n} (${kind}) of answer-key page ${i + 1} of ${P}; neighbouring strips overlap a little. ` +
  `Extract every FULLY visible question-number/correct-answer pair. Ignore any row that is cut off at an image edge. Do not solve any question.`;

async function runVerifiedAnswerExtraction(file, apiKey, expectedNums, opts, onProgress){
  opts = opts || {}; const model = opts.model || DEFAULT_GEMINI_MODEL;
  if(!apiKey) throw new Error("Gemini API key is missing.");
  const stats = {};
  progStart(onProgress);

  // Text layer (fast, if available)
  progSay("Reading PDF text layer (fastest if it exists)");
  let T = { map: new Map(), usable: false, note: "skipped" };
  try { T = await readAnswerTextLayer(file, new Set(expectedNums)); } catch(e) { T.note = "could not read: " + e.message; }
  stats.text = { usable: T.usable, count: T.map.size, note: T.note };
  
  if(T.usable && T.map.size >= expectedNums.length * 0.8){
    progSay("PDF text layer has enough answers");
    PROG.planned = 1; PROG.calls = 1; progSay("Done");
    stats.A = { count: 0, ran: false }; stats.B = { count: 0, ran: false }; stats.C = { ran: false, asked: 0, count: 0 };
    return {
      answers: [...T.map.entries()].map(([n, v]) => ({ Questionsnumber: String(n), CorrectAnswer: v })),
      review: [], stats: { ...stats, levels: { unanimous: T.map.size, majority: 0 }, requests: 0 }, pageImages: []
    };
  }

  progSay("Preparing pages");
  const pages = await fileToPages(file, 3);
  const P = pages.length;
  
  PROG.planned = 1; 
  progSay("Sending all " + P + " page(s) to Gemini (single request for all answers)");
  const perPage = Math.max(300*1024, Math.floor(13*1024*1024 / P));
  const imageParts = await Promise.all(pages.map(async p => dataUrlToInline(await compressDataUrl(p.dataUrl, perPage))));

  const userPrompt = `You are an expert answer-key reader. Read ALL ${P} pages shown and extract EVERY visible question number and its correct answer.\n` +
    `Do NOT solve questions. Do NOT infer. Read ONLY what is printed.\n` +
    `Return ONLY the answers, one per line, as: number:answer (e.g., 1:A, 12:B,C, 37:D)\n` +
    `Do not skip, do not repeat, do not add explanations.`;

  const reply = await withRetry(() => geminiPost(apiKey, model,
    `You are an expert answer-key reader. Read the image(s) shown. Extract question numbers and correct answers. Return compact output: number:answer per line. No JSON, no explanation.`,
    [ ...imageParts, { text: userPrompt } ]));

  PROG.calls++; progSay();
  const content = reply.text || '';
  if(!content) throw new Error('Empty response from Gemini.');
  let rows = [];
  try {
    rows = parseReply(content);
  } catch(e) {
    console.error('parseReply error:', e.message, 'content:', content.slice(0,100));
    throw e;
  }
  if(!rows || rows.length === 0) throw new Error('parseReply returned empty');
  const A = new Map(); 
  if(!Array.isArray(rows)) throw new Error('rows is not an array: ' + typeof rows);
  for(const r of rows){ 
    const n = parseInt(r.Questionsnumber || r.q, 10); 
    if(!isNaN(n) && !A.has(n)) A.set(n, canonAnswer(r.CorrectAnswer || r.ans)); 
  }
  
  stats.A = { count: A.size, ran: true }; stats.B = { count: 0, ran: false }; stats.C = { ran: false, asked: 0, count: 0 };
  
  const decided = new Map(); for(const [n, v] of A){ decided.set(n, { value: v, level: "single", votes: { A: v } }); }
  const undecided = [];
  
  PROG.planned = PROG.calls; progSay("Done");
  stats.levels = { unanimous: decided.size, majority: 0 }; stats.review = undecided.length; stats.requests = PROG.calls;
  
  return {
    answers: [...decided.entries()].map(([n, d]) => ({ Questionsnumber: String(n), CorrectAnswer: d.value })),
    review: undecided, stats, pageImages: pages.map(p => p.dataUrl)
  };
}


function normalizeOptionLetter(raw){
  const s = String(raw == null ? "" : raw).toUpperCase().replace(/[\s().]/g, "");
  if(/^[A-D]$/.test(s)) return s;
  if(/^[1-4]$/.test(s)) return "ABCD"[Number(s) - 1];
  return null;  
}

function matchQuestionsAndAnswers(questions, answers){
  const issues = { notSingleNumber: [], duplicateNumbers: [], unmatchedQuestions: [], unusedAnswers: [], unsupportedAnswers: [] };

  const singles = [];
  for(const q of questions){
    const nums = (q.qNums || []).map(String);
    if(nums.length === 1 && /^\d+$/.test(nums[0])) singles.push({ num: parseInt(nums[0], 10), q });
    else issues.notSingleNumber.push({ page: q.page, found: nums.join(", ") || "(none)" });
  }

  const byNum = new Map();
  for(const s of singles){ if(!byNum.has(s.num)) byNum.set(s.num, []); byNum.get(s.num).push(s); }
  for(const [num, list] of byNum){
    if(list.length > 1) issues.duplicateNumbers.push({ num, pages: list.map(x => x.q.page) });
  }
  if(issues.duplicateNumbers.length){
    return { ok: false, matched: [], issues,
             error: "Some question numbers appear more than once, so the answer key cannot tell them apart." };
  }

  const ansByNum = new Map();
  for(const a of (answers || [])){
    const n = String(a.Questionsnumber).replace(/\D/g, "");
    if(n) ansByNum.set(parseInt(n, 10), String(a.CorrectAnswer));
  }

  const matched = [];
  for(const [num, list] of [...byNum.entries()].sort((x, y) => x[0] - y[0])){
    const raw = ansByNum.get(num);
    if(raw === undefined){ issues.unmatchedQuestions.push(num); continue; }
    const letter = normalizeOptionLetter(raw);
    if(!letter){ issues.unsupportedAnswers.push({ num, raw }); continue; }
    matched.push({ num, answer: letter, question: list[0].q });
  }
  for(const n of ansByNum.keys()){ if(!byNum.has(n)) issues.unusedAnswers.push(n); }
  issues.unusedAnswers.sort((x, y) => x - y);

  return { ok: matched.length > 0, matched, issues,
           error: matched.length ? null : "No question could be matched to an answer." };
}

function buildQuizDoc(matched, imageUrlByNum, title, ownerUid){
  const questions = matched.map(m => ({
    question: "Question " + m.num,
    imageUrl: imageUrlByNum.get(m.num),
    options: { A: "Option A", B: "Option B", C: "Option C", D: "Option D" },
    answer: m.answer
  }));
  return {
    title: title,
    questions: questions,
    durationMinutes: Math.max(5, questions.length),
    isPaid: false,
    test_quiz: false,
    ownerUid: ownerUid,
    source: "pdf-import"
  };
}

if(typeof module !== "undefined" && module.exports){
  module.exports = { cleanAnswer, cleanQuestion, normalizePayload, extractJson, normalizeOptionLetter,
                     matchQuestionsAndAnswers, buildQuizDoc, itemsToLines, parseAnswerLines, consolidateReads, canonAnswer };
}
