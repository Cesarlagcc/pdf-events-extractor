// ---------------------------------------------------------
// Front-end only PDF Event Extractor (text-based PDFs)
// - Uses PDF.js (CDN) to extract positioned text items
// - Parses table rows by X-position into 4 columns
// - Merges wrapped lines into the previous event
// - Saves seen events to localStorage and only adds "new"
// - Renders NEW events at the top, SAVED events below
// - Export SAVED events to Excel-friendly file (CSV; optional XLSX via SheetJS)
// ---------------------------------------------------------

const STORAGE_KEY = "pdf_events_seen_v1";

// ---------------------------
// DOM
// ---------------------------
const fileInput = document.getElementById("pdfFile");
const btnParse  = document.getElementById("btnParse");
const btnClear  = document.getElementById("btnClear");
const btnExport = document.getElementById("btnExport"); // ✅ add this button in HTML
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
  const key = `${normalize(title).toLowerCase()}|${normalize(date)}|${normalize(location).toLowerCase()}`;
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2,"0")).join("");
}

// ---------------------------
// Export helpers
// ---------------------------
function pad2(n){ return String(n).padStart(2, "0"); }
function fileStamp(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

function escapeCsvCell(value){
  const s = String(value ?? "");
  // Escape if contains comma, quote, or newline
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildExportRows(savedList){
  // Only export SAVED events (not NEW flags)
  // Keep it clean for Excel.
  const rows = savedList.map(ev => ({
    "Event Details": ev.title || "",
    "Date": ev.date || "",
    "Location": ev.location || "",
    "URL": ev.url || "",
    "First Saved (Local Time)": ev.addedAt ? new Date(ev.addedAt).toLocaleString() : ""
  }));

  // Sort by date text first, then title (best-effort)
  rows.sort((a,b) => {
    const da = (a["Date"] || "").toLowerCase();
    const db = (b["Date"] || "").toLowerCase();
    if (da < db) return -1;
    if (da > db) return 1;
    const ta = (a["Event Details"] || "").toLowerCase();
    const tb = (b["Event Details"] || "").toLowerCase();
    return ta.localeCompare(tb);
  });

  return rows;
}

function exportSavedToCSV(savedList){
  const rows = buildExportRows(savedList);
  const headers = ["Event Details", "Date", "Location", "URL", "First Saved (Local Time)"];

  const lines = [];
  lines.push(headers.map(escapeCsvCell).join(","));

  for (const r of rows){
    const line = headers.map(h => escapeCsvCell(r[h])).join(",");
    lines.push(line);
  }

  // Add UTF-8 BOM for Excel friendliness
  const csv = "\uFEFF" + lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, `ANA_Events_Saved_${fileStamp()}.csv`);
}

function exportSavedToXLSXIfAvailable(savedList){
  // Optional: if SheetJS is present as window.XLSX, export .xlsx
  // If not present, return false to indicate fallback needed.
  if (!window.XLSX) return false;

  const rows = buildExportRows(savedList);

  const ws = window.XLSX.utils.json_to_sheet(rows, { header: [
    "Event Details", "Date", "Location", "URL", "First Saved (Local Time)"
  ]});

  // Make columns a bit nicer
  ws["!cols"] = [
    { wch: 60 }, // Event Details
    { wch: 22 }, // Date
    { wch: 28 }, // Location
    { wch: 55 }, // URL
    { wch: 26 }  // First Saved
  ];

  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, "Saved Events");

  const out = window.XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  downloadBlob(blob, `ANA_Events_Saved_${fileStamp()}.xlsx`);
  return true;
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
    headerTd.style.paddingBottom = "1.25rem";
    headerTd.textContent = `${label} (${list.length})`;
    if (label === "Saved") headerTd.style.paddingTop = "2rem";
    headerTr.appendChild(headerTd);
    tbody.appendChild(headerTr);

    for(const ev of list){
      const tr = document.createElement("tr");

      const td1 = document.createElement("td");
      td1.textContent = ev.title || "(No event details)";

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
// PDF.js extract positioned items
// ---------------------------
async function extractPagesFromPdf(arrayBuffer) {
  const loadingTask = pdfjsLib.getDocument({
    data: arrayBuffer,
    disableWorker: true
  });

  const pdf = await loadingTask.promise;

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    const items = content.items
      .filter(it => it && typeof it.str === "string" && it.str.trim().length)
      .map(it => {
        const x = it.transform?.[4] ?? 0;
        const y = it.transform?.[5] ?? 0;
        return { str: it.str, x, y };
      });

    pages.push({ pageNumber: p, items });
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
// ---------------------------
function splitLineIntoColumns(line, anchors) {
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
    location: joinCol(cols.location)
  };
}

// ---------------------------
// Parse events
// - Rows parsed until next header
// - Wrap continuation lines merge into previous event
// - Prevent phantom "2026" titles
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

        const cols = splitLineIntoColumns(lines[r], headerAnchors);

        const dateCell  = normalize(cols.date);
        const timeCell  = normalize(cols.time);
        const eventCell = normalize(cols.event);
        const locCell   = normalize(cols.location);

        if (/^\d+$/.test(rowText)) continue;
        if (/ANA\s+Upcoming\s+Events/i.test(rowText)) continue;

        const hasNewRowSignal = Boolean(timeCell) || (Boolean(dateCell) && !isYearOnly(dateCell));

        // Continuation line (wrapped Event Details)
        if (!hasNewRowSignal && eventCell && lastEvent) {
          if (!isYearOnly(eventCell)) {
            lastEvent.title = normalize(`${lastEvent.title} ${eventCell}`);
          }
          if (locCell) lastEvent.location = normalize(`${lastEvent.location} ${locCell}`.trim());
          continue;
        }

        if (!hasNewRowSignal && !eventCell) continue;

        if (!eventCell || isYearOnly(eventCell)) continue;

        const dateDisplay =
          dateCell && timeCell ? `${dateCell} • ${timeCell}` :
          dateCell ? dateCell :
          timeCell ? timeCell : "";

        const ev = {
          title: eventCell,
          date: dateDisplay,
          location: locCell || ""
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

  setStatus("Extracting positioned text…");
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

  const merged = [...saved, ...newlyAdded];
  saveAll(merged);

  const mergedForRender = merged.map(e => ({
    ...e,
    isNew: newlyAdded.some(n => n.fingerprint === e.fingerprint)
  }));

  render(mergedForRender);
  setStatus(`Found ${found.length} event(s). New: ${newlyAdded.length}. Total saved: ${merged.length}.`);
});

// Export button
if (btnExport) {
  btnExport.addEventListener("click", () => {
    const saved = loadSaved();
    if (!saved.length) {
      alert("No saved events to export yet.");
      return;
    }

    // Prefer real XLSX if SheetJS is present; otherwise CSV (Excel-friendly)
    const okXlsx = exportSavedToXLSXIfAvailable(saved);
    if (!okXlsx) {
      exportSavedToCSV(saved);
      alert("Exported as CSV (Excel-friendly). If you want a true .xlsx export, I can enable it with a free CDN library.");
    }
  });
}

// init
refresh();
