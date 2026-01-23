// ---------------------------------------------------------
// Front-end only PDF Event Extractor (text-based PDFs)
// - Uses PDF.js (CDN) to extract positioned text items
// - Extracts link annotations (URLs) and attaches them to titles when possible
// - Parses table rows by X-position into 4 columns
// - Merges wrapped lines into the previous event
// - Saves seen events to localStorage and only adds "new"
// - Renders NEW events at the top, SAVED events below (with spacing)
// ---------------------------------------------------------

const STORAGE_KEY = "pdf_events_seen_v1";

// ---------------------------
// DOM
// ---------------------------
const fileInput = document.getElementById("pdfFile");
const btnParse  = document.getElementById("btnParse");
const btnClear  = document.getElementById("btnClear");
const statusEl  = document.getElementById("status");
const tbody     = document.getElementById("tbody");
const debugText = document.getElementById("debugText");

function setStatus(msg){ statusEl.textContent = msg; }
function normalize(s){ return (s || "").replace(/\s+/g, " ").trim(); }
function isYearOnly(s){ return /^\d{4}$/.test(normalize(s || "")); }

// ---------------------------
// Storage
// ---------------------------
function loadSaved(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAll(list){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

async function fingerprint(title, date, location){
  // NOTE: We intentionally do NOT include url in the fingerprint
  // so a link change doesn’t create “new” duplicates.
  const key = `${normalize(title).toLowerCase()}|${normalize(date)}|${normalize(location).toLowerCase()}`;
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,"0")).join("");
}

// ---------------------------
// Render: NEW section then SAVED section
// ---------------------------
function render(events){
  tbody.innerHTML = "";

  const newEvents   = events.filter(e => e.isNew);
  const savedEvents = events.filter(e => !e.isNew);

  const renderSection = (label, list) => {
    const headerTr = document.createElement("tr");
    const headerTd = document.createElement("td");
    headerTd.colSpan = 4;
    headerTd.style.fontWeight = "800";
    headerTd.style.background = "#fcfcfc";
    headerTd.style.borderBottom = "1px solid #eee";
    headerTd.style.paddingBottom = "1.25rem"; // gives breathing room after header
    headerTd.textContent = `${label} (${list.length})`;
    if (label === "Saved") headerTd.style.paddingTop = "2rem"; // space between New and Saved
    headerTr.appendChild(headerTd);
    tbody.appendChild(headerTr);

    for(const ev of list){
      const tr = document.createElement("tr");

      const td1 = document.createElement("td");
      if (ev.url) {
        const a = document.createElement("a");
        a.href = ev.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = ev.title || "(No event details)";
        td1.appendChild(a);
      } else {
        td1.textContent = ev.title || "(No event details)";
      }

      const td2 = document.createElement("td");
      td2.textContent = ev.date || "";

      const td3 = document.createElement("td");
      td3.textContent = ev.location || "";

      const td4 = document.createElement("td");
      const pill = document.createElement("span");
      pill.className = "pill" + (ev.isNew ? " new" : "");
      pill.textContent = ev.isNew ? "NEW" : "Saved";
      td4.appendChild(pill);

      tr.append(td1, td2, td3, td4);
      tbody.appendChild(tr);
    }
  };

  // NEW first
  if (newEvents.length) {
    newEvents.sort((a,b) => (b.addedAt || 0) - (a.addedAt || 0));
    renderSection("New", newEvents);
  } else {
    renderSection("New", []);
  }

  // SAVED second
  savedEvents.sort((a,b) => (b.addedAt || 0) - (a.addedAt || 0));
  renderSection("Saved", savedEvents);
}

function refresh(){
  const saved = loadSaved().map(e => ({...e, isNew:false}));
  render(saved);
  setStatus(`Loaded ${saved.length} saved event(s).`);
}

// ---------------------------
// PDF.js extract positioned items + link annotations
// ---------------------------
function normalizeRect(rect){
  // rect = [x1, y1, x2, y2]
  const x1 = Math.min(rect[0], rect[2]);
  const x2 = Math.max(rect[0], rect[2]);
  const y1 = Math.min(rect[1], rect[3]);
  const y2 = Math.max(rect[1], rect[3]);
  return { x1, y1, x2, y2 };
}

async function extractPagesFromPdf(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    disableWorker: true
  });

  const pdf = await loadingTask.promise;

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);

    // Text content (positions)
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it && typeof it.str === "string" && it.str.trim().length)
      .map(it => {
        const x = it.transform?.[4] ?? 0;
        const y = it.transform?.[5] ?? 0;
        return { str: it.str, x, y };
      });

    // Link annotations (URLs)
    // NOTE: Some PDFs use "dest" instead of direct URL; we only attach when a.url exists.
    let links = [];
    try {
      const annots = await page.getAnnotations();
      links = (annots || [])
        .filter(a => a && a.subtype === "Link" && a.url && a.rect && a.rect.length === 4)
        .map(a => ({
          url: a.url,
          ...normalizeRect(a.rect)
        }));
    } catch {
      links = [];
    }

    pages.push({ pageNumber: p, items, links });
  }

  return pages;
}

// ---------------------------
// Group items into lines (by Y), keep x positions
// ---------------------------
function groupIntoLines(items) {
  const sorted = [...items].sort((a,b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  const Y_TOL = 2.0;

  for (const it of sorted) {
    let placed = false;
    for (const line of lines) {
      if (Math.abs(line.y - it.y) <= Y_TOL) {
        line.items.push(it);
        placed = true;
        break;
      }
    }
    if (!placed) lines.push({ y: it.y, items: [it] });
  }

  for (const line of lines) {
    line.items.sort((a,b) => a.x - b.x);

    let text = "";
    let prevX = null;
    for (const it of line.items) {
      const s = it.str.trim();
      if (!s) continue;

      if (prevX !== null && it.x - prevX > 12) text += " ";
      if (text && !text.endsWith(" ")) text += " ";
      text += s;
      prevX = it.x;
    }
    line.text = normalize(text);
  }

  lines.sort((a,b) => b.y - a.y);
  return lines;
}

// ---------------------------
// Detect table header row in a line
// Returns x anchors for columns (DATE, TIME, EVENT DETAILS, LOCATION)
// ---------------------------
function getHeaderAnchors(line) {
  const t = (line.text || "").toUpperCase();
  if (!(t.includes("DATE") && t.includes("TIME") && t.includes("EVENT") && t.includes("DETAILS") && t.includes("LOCATION"))) {
    return null;
  }

  const items = line.items || [];
  const findX = (needleUpper) => {
    const hit = items.find(it => (it.str || "").toUpperCase().includes(needleUpper));
    return hit ? hit.x : null;
  };

  const xDate = findX("DATE");
  const xTime = findX("TIME");
  const xEvent = findX("EVENT") ?? findX("DETAILS");
  const xLoc  = findX("LOCATION");

  if (xDate == null || xTime == null || xEvent == null || xLoc == null) return null;

  return [
    { key: "date", x: xDate },
    { key: "time", x: xTime },
    { key: "event", x: xEvent },
    { key: "location", x: xLoc }
  ].sort((a,b) => a.x - b.x);
}

// ---------------------------
// Split a line into 4 columns using anchor x positions
// Also returns the event-column items so we can match link annotations.
// ---------------------------
function splitLineIntoColumnsDetailed(line, anchors) {
  const xs = anchors.map(a => a.x);
  const bounds = [
    (xs[0] + xs[1]) / 2,
    (xs[1] + xs[2]) / 2,
    (xs[2] + xs[3]) / 2
  ];

  const cols = { date: [], time: [], event: [], location: [] };

  for (const it of line.items) {
    const s = it.str.trim();
    if (!s) continue;

    if (it.x < bounds[0]) cols.date.push(it);
    else if (it.x < bounds[1]) cols.time.push(it);
    else if (it.x < bounds[2]) cols.event.push(it);
    else cols.location.push(it);
  }

  const joinCol = (arr) => normalize(arr.sort((a,b)=>a.x-b.x).map(x=>x.str).join(" "));

  return {
    date: joinCol(cols.date),
    time: joinCol(cols.time),
    event: joinCol(cols.event),
    location: joinCol(cols.location),
    eventItems: cols.event
  };
}

function findUrlForEventItems(eventItems, links) {
  if (!eventItems || !eventItems.length || !links || !links.length) return "";

  // Simple + effective: if any event text point lies inside any link rect, take that URL.
  // This works well for “title is clickable” PDFs.
  for (const it of eventItems) {
    const x = it.x;
    const y = it.y;
    for (const link of links) {
      if (x >= link.x1 && x <= link.x2 && y >= link.y1 && y <= link.y2) {
        return link.url;
      }
    }
  }

  return "";
}

// ---------------------------
// Parse events (same working row logic)
// - Rows parsed until next header
// - Wrap continuation lines merge into previous event
// - Prevent phantom "2026" titles
// - Attach URL to title when detected
// ---------------------------
async function parseEventsFromPages(pages) {
  const candidates = [];
  const debugLines = [];

  for (const page of pages) {
    const lines = groupIntoLines(page.items);

    for (let i = 0; i < lines.length; i++) {
      const headerAnchors = getHeaderAnchors(lines[i]);
      if (!headerAnchors) continue;

      let lastEvent = null;

      for (let r = i + 1; r < lines.length; r++) {
        if (getHeaderAnchors(lines[r])) break;

        const rowText = lines[r].text || "";
        if (!rowText) continue;

        const cols = splitLineIntoColumnsDetailed(lines[r], headerAnchors);

        const dateCell  = normalize(cols.date);
        const timeCell  = normalize(cols.time);
        const eventCell = normalize(cols.event);
        const locCell   = normalize(cols.location);

        if (/^\d+$/.test(rowText)) continue;
        if (/ANA\s+Upcoming\s+Events/i.test(rowText)) continue;

        // New row signal, but don't allow year-only date like "2026" to start a row
        const hasNewRowSignal = Boolean(timeCell) || (Boolean(dateCell) && !isYearOnly(dateCell));

        // Continuation line (wrapped Event Details)
        if (!hasNewRowSignal && eventCell && lastEvent) {
          if (!isYearOnly(eventCell)) {
            lastEvent.title = normalize(`${lastEvent.title} ${eventCell}`);
          }
          if (locCell) lastEvent.location = normalize(`${lastEvent.location} ${locCell}`.trim());

          // If we didn’t get a URL on the first line, try to detect on continuation too
          if (!lastEvent.url) {
            const maybeUrl = findUrlForEventItems(cols.eventItems, page.links);
            if (maybeUrl) lastEvent.url = maybeUrl;
          }
          continue;
        }

        if (!hasNewRowSignal && !eventCell) continue;

        // Must have Event Details, and it can't be just a year
        if (!eventCell || isYearOnly(eventCell)) continue;

        const dateDisplay =
          dateCell && timeCell ? `${dateCell} • ${timeCell}` :
          dateCell ? dateCell :
          timeCell ? timeCell : "";

        const url = findUrlForEventItems(cols.eventItems, page.links);

        const ev = {
          title: eventCell,
          date: dateDisplay,
          location: locCell || "",
          url: url || ""
        };

        candidates.push(ev);
        lastEvent = ev;
      }
    }

    debugLines.push(`--- Page ${page.pageNumber} ---`);
    debugLines.push(...lines.map(l => l.text));
  }

  // De-dupe by fingerprint
  const out = [];
  const seen = new Set();
  for (const ev of candidates) {
    const fp = await fingerprint(ev.title, ev.date, ev.location);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({ ...ev, fingerprint: fp });
  }

  return { events: out, debugDump: debugLines.join("\n") };
}

// ---------------------------
// UI events
// ---------------------------
btnClear.addEventListener("click", () => {
  const ok = window.confirm(
    "Are you sure you want to clear all saved events?\n\nThis cannot be undone."
  );
  if (!ok) return;

  localStorage.removeItem(STORAGE_KEY);
  debugText.value = "";
  render([]);
  setStatus("Cleared saved events.");
});

btnParse.addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if(!file){
    setStatus("Choose a PDF first.");
    return;
  }

  setStatus("Reading PDF…");
  const buffer = await file.arrayBuffer();

  setStatus("Extracting positioned text + links…");
  let pages;
  try{
    pages = await extractPagesFromPdf(buffer);
  } catch (e){
    console.error(e);
    setStatus(`Could not read text from this PDF. ${e?.message ? "Error: " + e.message : ""}`);
    return;
  }

  setStatus("Parsing rows…");
  const { events: found, debugDump } = await parseEventsFromPages(pages);
  debugText.value = debugDump.slice(0, 20000);

  const saved = loadSaved();
  const savedSet = new Set(saved.map(e => e.fingerprint));

  const now = Date.now();
  const newlyAdded = [];
  for(const ev of found){
    if(!savedSet.has(ev.fingerprint)){
      newlyAdded.push({ ...ev, addedAt: now });
      savedSet.add(ev.fingerprint);
    }
  }

  // Save: old + new
  const merged = [...saved, ...newlyAdded];
  saveAll(merged);

  // For display: mark NEW ones
  const mergedForRender = merged.map(e => ({
    ...e,
    isNew: newlyAdded.some(n => n.fingerprint === e.fingerprint)
  }));

  render(mergedForRender);
  setStatus(`Found ${found.length} event(s). New: ${newlyAdded.length}. Total saved: ${merged.length}.`);
});

// init
refresh();
