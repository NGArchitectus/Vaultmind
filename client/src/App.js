import { useState, useRef, useCallback, useEffect } from "react";

const IS_DEMO = false;
const API_BASE = "https://vaultmind-production-5775.up.railway.app";
const ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
const MAX_PAGES_PER_CHUNK = 90;

// ── API helpers ───────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = () => rej(new Error("Read failed"));
    r.readAsDataURL(file);
  });
}

async function splitPdfIntoChunks(base64Data, chunkSize) {
  try {
    if (!window.PDFLib) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const { PDFDocument } = window.PDFLib;
    const pdfBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const chunks = [];
    for (let start = 0; start < totalPages; start += chunkSize) {
      const end = Math.min(start + chunkSize, totalPages);
      const chunkDoc = await PDFDocument.create();
      const pages = await chunkDoc.copyPages(srcDoc, Array.from({ length: end - start }, (_, i) => start + i));
      pages.forEach(p => chunkDoc.addPage(p));
      const chunkBytes = await chunkDoc.save();
      const chunkBase64 = await new Promise((resolve) => {
        const blob = new Blob([chunkBytes], { type: "application/pdf" });
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(blob);
      });
      chunks.push({ base64: chunkBase64, startPage: start + 1, endPage: end, totalPages });
    }
    return chunks;
  } catch (e) {
    console.warn("PDF splitting failed:", e);
    return [{ base64: base64Data, startPage: 1, endPage: "?", totalPages: "?" }];
  }
}

async function callClaude(messages, systemPrompt, maxTokens = 1000, retries = 2, model = "gemini-2.5-flash") {
  // 60 second timeout — if Gemini doesn't respond, abort and surface a clean error
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  let res;
  try {
    res = await fetch(`${API_BASE}/api/claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages }),
    });
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error("Request timed out — Gemini is experiencing high traffic. Please try again in a moment.");
    }
    throw e;
  }
  clearTimeout(timeoutId);

  // Auto-retry on rate limit with 15 second wait
  if (res.status === 429 && retries > 0) {
    console.log(`Rate limit hit, waiting 15 seconds before retry (${retries} retries left)…`);
    await new Promise(r => setTimeout(r, 15000));
    return callClaude(messages, systemPrompt, maxTokens, retries - 1, model);
  }

  // Retry on timeout/gateway errors
  if ((res.status === 504 || res.status === 502) && retries > 0) {
    console.log(`Gateway error ${res.status}, retrying in 5 seconds (${retries} retries left)…`);
    await new Promise(r => setTimeout(r, 5000));
    return callClaude(messages, systemPrompt, maxTokens, retries - 1, model);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `API error ${res.status}`);
  }
  const data = await res.json();
  return data.content.map(b => b.text || "").join("\n");
}

// ── sub-components ────────────────────────────────────────────────────────────

function Spinner({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
    </svg>
  );
}

function ProgressBar({ label, pct, color = "#0d6478" }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#9a9088", marginBottom: 4, letterSpacing: "0.04em" }}>
        <span style={{ fontWeight: 500 }}>{label}</span><span>{Math.round(pct)}%</span>
      </div>
      <div style={{ height: 3, background: "#e8e0d5" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, transition: "width 0.4s ease" }} />
      </div>
    </div>
  );
}

function formatInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i} style={{ color: "#e8d5a3" }}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`")) return <code key={i} style={{ background: "#1e1e1e", color: "#c8a96e", padding: "1px 5px", borderRadius: 3, fontSize: 12 }}>{p.slice(1, -1)}</code>;
    return p;
  });
}

// Approved Document green colour
const AD_GREEN = "#0d6478";        // Architectus teal dark
const AD_GREEN_LIGHT = "#f0f5f6";    // Architectus light teal tint
const AD_GREEN_MID = "#b8d4da";      // Architectus mid teal tint
const ARC_NAVY = "#1e2a35";          // Architectus dark navy
const ARC_TERRACOTTA = "#c25a45";    // Architectus rust/terracotta
const ARC_STONE = "#e8e0d5";         // Architectus warm stone

function AnswerRenderer({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  const elements = [];
  let tableBuffer = [];
  let inTable = false;

  const flushTable = (key) => {
    if (tableBuffer.length === 0) return;
    const rows = tableBuffer.map(r => r.split("|").map(c => c.trim()).filter(c => c !== ""));
    const header = rows[0];
    const body = rows.slice(2);
    elements.push(
      <div key={`tbl-${key}`} style={{ overflowX: "auto", margin: "16px 0", border: "1px solid #aaa" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>{header.map((h, i) => (
              <th key={i} style={{ background: ARC_NAVY, color: "#ffffff", padding: "8px 14px", border: "none", textAlign: "left", fontWeight: 500, fontSize: 11, fontFamily: "Inter, Arial, sans-serif", letterSpacing: "0.05em", textTransform: "uppercase" }}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri} style={{ background: ri % 2 === 0 ? "#ffffff" : "#f5f9fa" }}>
                {row.map((cell, ci) => (
                  <td key={ci} style={{ padding: "9px 14px", border: "none", borderBottom: "1px solid #e8e0d5", color: ARC_NAVY, verticalAlign: "top", fontSize: 12, lineHeight: 1.6, fontFamily: "Inter, Arial, sans-serif" }}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableBuffer = []; inTable = false;
  };

  lines.forEach((line, i) => {
    if (line.startsWith("|")) { inTable = true; tableBuffer.push(line); return; }
    if (inTable) flushTable(i);

    if (line.startsWith("### ")) {
      // Sub-headings — green uppercase like AD section headings
      elements.push(
        <h3 key={i} style={{ color: ARC_TERRACOTTA, fontSize: 11, fontWeight: 600, margin: "20px 0 6px", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "Inter, Arial, sans-serif" }}>
          {line.slice(4)}
        </h3>
      );
    } else if (line.startsWith("## ")) {
      const text = line.slice(3);
      const isSummary = text.toLowerCase().includes("summary");
      if (isSummary) {
        // Summary — green requirement box style like D1 requirement box
        elements.push(
          <div key={i} style={{ background: "#f0f5f6", border: `1px solid ${AD_GREEN_MID}`, borderLeft: `3px solid ${AD_GREEN}`, padding: "14px 18px", margin: "16px 0 8px" }}>
            <h2 style={{ color: AD_GREEN, fontSize: 12, fontWeight: 600, margin: 0, fontFamily: "Inter, Arial, sans-serif", textTransform: "uppercase", letterSpacing: "0.08em" }}>{text}</h2>
          </div>
        );
      } else {
        // Regular section heading — black with green underline rule
        elements.push(
          <div key={i} style={{ borderBottom: `1px solid #e8e0d5`, marginTop: 28, marginBottom: 10, paddingBottom: 6 }}>
            <h2 style={{ color: ARC_NAVY, fontSize: 16, fontWeight: 400, margin: 0, fontFamily: "Inter, Arial, sans-serif", letterSpacing: "0.02em" }}>{text}</h2>
          </div>
        );
      }
    } else if (line.startsWith("# ")) {
      elements.push(
        <div key={i} style={{ borderBottom: `2px solid ${ARC_TERRACOTTA}`, marginTop: 32, marginBottom: 14, paddingBottom: 6 }}>
          <h1 style={{ color: ARC_NAVY, fontSize: 20, fontWeight: 300, margin: 0, fontFamily: "Inter, Arial, sans-serif", letterSpacing: "0.02em" }}>{line.slice(2)}</h1>
        </div>
      );
    } else if (line.startsWith("> ")) {
      const quoteText = line.slice(2);
      const isCitation = quoteText.startsWith("*") && quoteText.endsWith("*");
      const isTableRow = quoteText.startsWith("|");
      const isSeparatorRow = /^\|[\s:|-]+\|/.test(quoteText);
      if (isCitation) {
        elements.push(
          <p key={i} style={{ fontSize: 11, color: "#9a9088", fontStyle: "italic", margin: "2px 0 8px 0", fontFamily: "Inter, Arial, sans-serif" }}>
            {quoteText.slice(1, -1)}
          </p>
        );
      } else if (isTableRow && !isSeparatorRow) {
        inTable = true; tableBuffer.push(quoteText);
      } else if (isSeparatorRow) {
        if (inTable) tableBuffer.push(quoteText);
      } else {
        elements.push(
          <div key={i} style={{ borderLeft: `2px solid #d0ccc8`, padding: "2px 0 2px 14px", margin: "4px 0", fontStyle: "italic", fontSize: 13, color: "#4a5568", lineHeight: 1.8, fontFamily: "Inter, Arial, sans-serif" }}>
            {quoteText}
          </div>
        );
      }
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      elements.push(<li key={i} style={{ color: ARC_NAVY, fontSize: 13, lineHeight: 1.7, marginLeft: 20, marginBottom: 4, fontFamily: "Inter, Arial, sans-serif" }}>{formatInline(line.slice(2))}</li>);
    } else if (line.match(/^\d+\.\d+ /)) {
      // Numbered paragraphs like 1.1, 1.2 — AD style
      const numMatch = line.match(/^(\d+\.\d+) (.+)/);
      if (numMatch) {
        elements.push(
          <div key={i} style={{ display: "flex", gap: 12, margin: "6px 0", fontFamily: "Arial, sans-serif" }}>
            <span style={{ color: ARC_TERRACOTTA, fontWeight: 600, fontSize: 12, flexShrink: 0, minWidth: 28 }}>{numMatch[1]}</span>
            <p style={{ color: ARC_NAVY, fontSize: 13, lineHeight: 1.7, margin: 0, fontFamily: "Inter, Arial, sans-serif" }}>{formatInline(numMatch[2])}</p>
          </div>
        );
      }
    } else if (line.match(/^\d+\. /)) {
      elements.push(<li key={i} style={{ color: "#0b0c0c", fontSize: 14, lineHeight: 1.7, marginLeft: 20, marginBottom: 3, listStyleType: "decimal", fontFamily: "Arial, sans-serif" }}>{formatInline(line.replace(/^\d+\. /, ""))}</li>);
    } else if (line === "") {
      elements.push(<div key={i} style={{ height: 10 }} />);
    } else {
      const isStandaloneCitation = line.startsWith("*") && line.endsWith("*") && line.length > 2 && !line.startsWith("**");
      if (isStandaloneCitation) {
        elements.push(
          <p key={i} style={{ fontSize: 11, color: "#9a9088", fontStyle: "italic", margin: "2px 0 8px 0", fontFamily: "Inter, Arial, sans-serif" }}>
            {line.slice(1, -1)}
          </p>
        );
      } else {
        elements.push(<p key={i} style={{ color: ARC_NAVY, fontSize: 13, lineHeight: 1.8, margin: "6px 0", fontFamily: "Inter, Arial, sans-serif", letterSpacing: "0.01em" }}>{formatInline(line)}</p>);
      }
    }
  });
  if (inTable) flushTable("end");
  return <div>{elements}</div>;
}

// ── main app ──────────────────────────────────────────────────────────────────

export default function App() {
  const [vaults, setVaults] = useState([]);
  const [selectedVault, setSelectedVault] = useState(null);
  const [pdfs, setPdfs] = useState([]);
  const [vaultIndex, setVaultIndex] = useState(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState(null);
  const [stage, setStage] = useState(null);
  const [progress, setProgress] = useState({ index: 0, select: 0, read: 0, answer: 0 });
  const [statusMsg, setStatusMsg] = useState("");
  const [creating, setCreating] = useState(false);
  const [newVaultName, setNewVaultName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [costEst, setCostEst] = useState(null);
  const [history, setHistory] = useState([]);
  const [conversationHistory, setConversationHistory] = useState([]);
  const [loadingVaults, setLoadingVaults] = useState(true);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [tempDoc, setTempDoc] = useState(null); // { name, base64 } — in memory only
  const [tempDocDragOver, setTempDocDragOver] = useState(false);
  const fileInputRef = useRef();
  const tempDocInputRef = useRef();

  const CORRECT_PASSWORD = "4Rawbn11";

  const handleLogin = () => {
    if (passwordInput === CORRECT_PASSWORD) {
      setAuthenticated(true);
      setPasswordError(false);
    } else {
      setPasswordError(true);
      setPasswordInput("");
    }
  };

  const loadTempDoc = async (file) => {
    if (!file || file.type !== "application/pdf") return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result.split(",")[1];
      setTempDoc({ name: file.name, base64 });
    };
    reader.readAsDataURL(file);
  };

  const vault = vaults.find(v => v.id === selectedVault);
  const vaultHistory = history.filter(h => h.vaultId === selectedVault);

  // ── load vaults on mount ────────────────────────────────────────────────────
  useEffect(() => {
    loadVaults();
  }, []);

  const loadVaults = async () => {
    setLoadingVaults(true);
    try {
      const data = await api("/api/vaults");
      setVaults(data.vaults || []);
    } catch (e) {
      console.error("Failed to load vaults:", e);
    }
    setLoadingVaults(false);
  };

  // ── load PDFs and index when vault selected ─────────────────────────────────
  useEffect(() => {
    if (!selectedVault) return;
    loadVaultContents(selectedVault);
  }, [selectedVault]);

  const loadVaultContents = async (vaultId) => {
    setAnswer(null);
    setStage(null);
    setStatusMsg("Loading vault…");
    setPdfs([]);
    setVaultIndex(null);
    setConversationHistory([]);

    try {
      const [pdfsData, indexData] = await Promise.all([
        api(`/api/vaults/${vaultId}/pdfs`),
        api(`/api/vaults/${vaultId}/index`).catch(() => null),
      ]);
      setPdfs(pdfsData.pdfs || []);
      setVaultIndex(indexData);
      if (indexData) {
        const total = (indexData.documents || []).reduce((s, d) => s + (d.headings?.length || 0), 0);
        setStatusMsg(`✓ Vault ready — ${total} sections indexed across ${pdfsData.pdfs.length} document${pdfsData.pdfs.length !== 1 ? "s" : ""}.`);
      } else {
        setStatusMsg(pdfsData.pdfs.length > 0 ? "Documents loaded — click Index Vault to prepare for questions." : "No documents yet — upload PDFs to get started.");
      }
    } catch (e) {
      setStatusMsg("Error loading vault: " + e.message);
    }
  };

  // ── vault creation ──────────────────────────────────────────────────────────
  const createVault = async () => {
    if (!newVaultName.trim()) return;
    try {
      const v = await api("/api/vaults", { method: "POST", body: { name: newVaultName.trim() } });
      setVaults(prev => [...prev, v]);
      setSelectedVault(v.id);
      setNewVaultName("");
      setCreating(false);
    } catch (e) {
      alert("Failed to create vault: " + e.message);
    }
  };

  // ── PDF upload ──────────────────────────────────────────────────────────────
  const addPDFs = useCallback(async (files) => {
    if (!vault) return;
    const pdfFiles = Array.from(files).filter(f => f.type === "application/pdf");
    if (!pdfFiles.length) return;
    setUploadingPdf(true);
    for (const file of pdfFiles) {
      setStatusMsg(`Uploading ${file.name}…`);
      try {
        const base64 = await fileToBase64(file);
        await api(`/api/vaults/${vault.id}/pdfs`, { method: "POST", body: { name: file.name, base64 } });
      } catch (e) {
        console.error("Upload failed:", e);
        setStatusMsg(`Failed to upload ${file.name}: ${e.message}`);
      }
    }
    setUploadingPdf(false);
    await loadVaultContents(vault.id);
    setVaultIndex(null); // index is now stale
    setStatusMsg("Upload complete — click Index Vault to update the index.");
  }, [vault]);

  const onDrop = (e) => { e.preventDefault(); setDragOver(false); addPDFs(e.dataTransfer.files); };

  const deletePdf = async (pdf) => {
    if (!window.confirm(`Remove "${pdf.name}" from this vault? This cannot be undone.`)) return;
    try {
      await api(`/api/vaults/${encodeURIComponent(vault.id)}/pdfs/${encodeURIComponent(pdf.name)}`, { method: "DELETE" });
      setVaultIndex(null); // index is now stale
      await loadVaultContents(vault.id);
      setStatusMsg(`"${pdf.name}" removed — re-index the vault to update.`);
    } catch (e) {
      setStatusMsg("Failed to remove: " + e.message);
    }
  };

  // ── PDF helper: extract pages as base64 ────────────────────────────────────
  const extractPdfPages = async (base64, pageIndices) => {
    if (!window.PDFLib) {
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";
        script.onload = resolve; script.onerror = reject;
        document.head.appendChild(script);
      });
    }
    const { PDFDocument } = window.PDFLib;
    const pdfBytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const newDoc = await PDFDocument.create();
    const valid = pageIndices.filter(i => i >= 0 && i < srcDoc.getPageCount());
    const copied = await newDoc.copyPages(srcDoc, valid);
    copied.forEach(p => newDoc.addPage(p));
    const bytes = await newDoc.save();
    const uint8 = new Uint8Array(bytes);
    let binary = "";
    for (let b = 0; b < uint8.length; b++) binary += String.fromCharCode(uint8[b]);
    return { base64: btoa(binary), pageCount: srcDoc.getPageCount() };
  };

  // ── shared indexing helper ────────────────────────────────────────────────────
  // Indexes headings with their absolute PDF page positions.
  // For small docs: sends full PDF to Gemini in one pass.
  // For large docs (>60 pages): chunks into 60-page segments, merges results.
  // Deduplicates on title — keeps the highest page number to prefer body
  // occurrences over table of contents references.
  const indexOnePdf = async (pdfName, base64) => {
    const SYSTEM = "You are a document indexer. Extract only structural metadata. Return pure JSON only, no markdown, no explanation.";
    const INDEX_PROMPT = `Extract structural headings from this document — chapter titles, numbered sections (e.g. 6.6, 6.6.1), and named sub-sections. Do not extract body text, bullet points, figure captions, or table content — only headings that introduce a section of content.

For pageHint, use only the position of the page within this PDF file — page 1 is the first page of this file, page 2 is the second, etc. Ignore all printed page numbers on the pages.

Output ONLY valid JSON: {"headings": [{"level": 1, "title": "heading text", "pageHint": 1}]}`;

    const tryParse = (text) => {
      const clean = text.replace(/```json|```/g, "").trim();
      try { return JSON.parse(clean); } catch {}
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) try { return JSON.parse(m[0]); } catch {}
      return null;
    };

    const dedupe = (headings) => {
      // Exact title dedup only — keep highest page number for identical titles
      // All other headings are kept, including multiple staircase-related sections
      const map = {};
      for (const h of headings) {
        const key = h.title.toLowerCase().trim();
        if (!map[key] || h.pageHint > map[key].pageHint) map[key] = h;
      }
      return Object.values(map);
    };

    // First attempt — full PDF in one pass (works for most docs)
    try {
      const result = await callClaude(
        [{ role: "user", content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 }, title: pdfName },
          { type: "text", text: INDEX_PROMPT }
        ]}],
        SYSTEM, 65000, 2, "gemini-2.5-flash-lite"
      );
      console.log(`Raw index response for ${pdfName} (first 200 chars):`, result.slice(0, 200));
      const parsed = tryParse(result);
      if (parsed?.headings?.length > 0) {
        const deduped = dedupe(parsed.headings);
        console.log(`Indexed ${pdfName}: ${deduped.length} headings`);
        return { headings: deduped };
      }
      console.warn(`${pdfName}: full-PDF index returned no headings, trying chunked…`);
    } catch (e) {
      console.warn(`${pdfName}: full-PDF indexing failed (${e.message}), trying chunked…`);
    }

    // Chunked fallback — 60 pages at a time, absolute page positions
    try {
      const { pageCount } = await extractPdfPages(base64, [0]);
      const CHUNK_SIZE = 60;
      const numChunks = Math.ceil(pageCount / CHUNK_SIZE);
      const allHeadings = [];
      console.log(`${pdfName}: splitting into ${numChunks} chunks (${pageCount} pages total)`);

      for (let chunk = 0; chunk < numChunks; chunk++) {
        const startPage = chunk * CHUNK_SIZE;
        const endPage = Math.min(startPage + CHUNK_SIZE, pageCount);
        setStatusMsg(`Indexing ${pdfName} — pages ${startPage + 1}–${endPage} of ${pageCount}…`);
        const { base64: chunkBase64 } = await extractPdfPages(base64, Array.from({ length: endPage - startPage }, (_, i) => startPage + i));
        try {
          const chunkPrompt = `Extract structural headings from this document — chapter titles, numbered sections (e.g. 6.6, 6.6.1), and named sub-sections. Do not extract body text, bullet points, or table content.

For pageHint, use only the page number within this chunk — page 1 is the first page of this chunk, page 2 is the second, up to page ${endPage - startPage}. Ignore all printed page numbers on the pages completely.

Output ONLY valid JSON: {"headings": [{"level": 1, "title": "heading text", "pageHint": 1}]}`;
          const result = await callClaude(
            [{ role: "user", content: [
              { type: "document", source: { type: "base64", media_type: "application/pdf", data: chunkBase64 } },
              { type: "text", text: chunkPrompt }
            ]}],
            SYSTEM, 65000, 2, "gemini-2.5-flash-lite"
          );
          const parsed = tryParse(result);
          if (parsed?.headings) {
            // Always recalculate absolute page position ourselves —
            // Gemini returns chunk-relative page (1-60), we add startPage
            const offsetHeadings = parsed.headings.map(h => ({
              ...h,
              pageHint: Math.max(1, (h.pageHint || 1) + startPage)
            }));
            allHeadings.push(...offsetHeadings);
            console.log(`${pdfName} chunk ${chunk + 1}/${numChunks}: ${parsed.headings.length} headings (pages ${startPage + 1}–${endPage})`);
          }
        } catch (e) {
          console.warn(`${pdfName} chunk ${chunk + 1} failed:`, e.message);
          // Retry once after a short delay if rate limited
          if (e.message?.includes("503") || e.message?.includes("UNAVAILABLE")) {
            try {
              await new Promise(r => setTimeout(r, 3000));
              const result2 = await callClaude(
                [{ role: "user", content: [
                  { type: "document", source: { type: "base64", media_type: "application/pdf", data: chunkBase64 } },
                  { type: "text", text: chunkPrompt }
                ]}],
                SYSTEM, 65000, 1, "gemini-2.5-flash-lite"
              );
              const parsed2 = tryParse(result2);
              if (parsed2?.headings) {
                allHeadings.push(...parsed2.headings);
                console.log(`${pdfName} chunk ${chunk + 1} retry: ${parsed2.headings.length} headings`);
              }
            } catch (e2) {
              console.warn(`${pdfName} chunk ${chunk + 1} retry also failed:`, e2.message);
            }
          }
        }
      }

      const deduped = dedupe(allHeadings);
      console.log(`Indexed ${pdfName}: ${deduped.length} headings (deduped from ${allHeadings.length})`);
      return { headings: deduped };
    } catch (e) {
      console.warn(`${pdfName}: chunked indexing failed:`, e.message);
      return { headings: [] };
    }
  };

  // ── indexing ────────────────────────────────────────────────────────────────
  const indexVault = async () => {
    if (!vault || pdfs.length === 0) return;
    setStage("indexing");
    setProgress({ index: 0, select: 0, read: 0, answer: 0 });
    setStatusMsg("Loading documents for indexing…");
    setAnswer(null);

    try {
      const allDocuments = [];

      for (let i = 0; i < pdfs.length; i++) {
        const pdf = pdfs[i];
        setStatusMsg(`Fetching document ${i + 1} of ${pdfs.length}: ${pdf.name}…`);

        // Load PDF from R2
        const pdfData = await api(`/api/vaults/${vault.id}/pdfs/${encodeURIComponent(pdf.name)}`);
        const base64 = pdfData.base64;

        setStatusMsg(`Scanning ${pdf.name}…`);
        setProgress(p => ({ ...p, index: Math.round((i / pdfs.length) * 80) }));

        const { headings } = await indexOnePdf(pdf.name, base64);
        allDocuments.push({ name: pdf.name, headings });
      }

      setProgress(p => ({ ...p, index: 100 }));

      const indexData = { documents: allDocuments, indexedAt: new Date().toISOString() };

      // Save index permanently to R2
      setStatusMsg("Saving index…");
      await api(`/api/vaults/${vault.id}/index`, { method: "POST", body: indexData });

      setVaultIndex(indexData);
      setStage("done-index");
      const totalHeadings = allDocuments.reduce((s, d) => s + (d.headings?.length || 0), 0);
      setStatusMsg(`✓ Vault indexed — ${totalHeadings} sections mapped across ${allDocuments.length} document${allDocuments.length !== 1 ? "s" : ""}. Ready for questions.`);
    } catch (err) {
      setStage(null);
      setStatusMsg("Indexing failed: " + err.message);
    }
  };

  // ── single document re-index ────────────────────────────────────────────────
  const indexSinglePdf = async (pdf) => {
    if (!vault) return;
    setStage("indexing");
    setStatusMsg(`Re-indexing ${pdf.name}…`);
    setAnswer(null);
    try {
      const pdfData = await api(`/api/vaults/${vault.id}/pdfs/${encodeURIComponent(pdf.name)}`);
      const base64 = pdfData.base64;
      const { headings } = await indexOnePdf(pdf.name, base64);
      if (!headings.length) throw new Error("No headings found — document may be too large or unreadable");

      // Merge with existing index — replace this doc's entry
      const existingDocs = (vaultIndex?.documents || []).filter(d => d.name !== pdf.name);
      const newIndex = { documents: [...existingDocs, { name: pdf.name, headings }], indexedAt: new Date().toISOString() };

      await api(`/api/vaults/${vault.id}/index`, { method: "POST", body: newIndex });
      setVaultIndex(newIndex);
      setStage("done-index");
      const total = newIndex.documents.reduce((s, d) => s + (d.headings?.length || 0), 0);
      setStatusMsg(`✓ ${pdf.name} re-indexed — ${headings.length} sections found. ${total} total sections across vault.`);
    } catch (e) {
      setStage(null);
      setStatusMsg(`Re-index failed for ${pdf.name}: ${e.message}`);
    }
  };

  // ── question answering — 3-pass pipeline ────────────────────────────────────
  const askQuestion = async () => {
    if (!vaultIndex || !question.trim()) return;
    const q = question.trim();
    setAnswer(null);
    setCostEst(null);
    setQuestion("");
    setStage("selecting");
    setProgress({ index: 100, select: 0, read: 0, answer: 0 });
    setStatusMsg("Pass 1/3 · Reading contents pages and scoring sections…");

    try {
      // ── PASS 1: Score index only — NO PDFs sent, pure text, very cheap ────────
      setStatusMsg("Pass 1/3 · Scoring index — identifying relevant sections…");

      // Compress index into compact plain text — far more efficient than raw JSON
      // Format: "DOCUMENT: filename\n  p14: Section heading\n  p22: Another section"
      // This reduces token usage by ~70% vs JSON, allowing 20+ documents to fit
      // Filter out boilerplate headings that appear in every AD and would
      // pollute scoring by matching generic questions about "approved documents"
      const BOILERPLATE_HEADINGS = [
        "the approved documents", "what is an approved document", "approved documents",
        "list of approved documents", "use of guidance", "how to use this approved document",
        "other guidance", "the building regulations", "online version", "hm government",
        "main changes", "approved document", "list of approved documents"
      ];
      const isBoilerplate = (title) => {
        const t = title.toLowerCase().trim();
        return BOILERPLATE_HEADINGS.some(b => t === b || t === b + "s");
      };

      const indexSummary = (vaultIndex.documents || []).map(doc => {
        // Identify contents pages — any heading whose title is a variant of "contents"
        const contentsPages = new Set(
          (doc.headings || [])
            .filter(h => /^(contents|table of contents|index)$/i.test(h.title.trim()))
            .map(h => h.pageHint)
        );

        const headings = (doc.headings || [])
          .filter(h => !isBoilerplate(h.title))
          .filter(h => !contentsPages.has(h.pageHint)) // exclude headings on contents pages
          .map(h => `  p${h.pageHint || 1}: ${h.title}`)
          .join("\n");
        return `DOCUMENT: ${doc.name}\n${headings}`;
      }).join("\n\n");
      setProgress(p => ({ ...p, select: 30 }));

      // Build full conversation context — keep all exchanges in session
      const recentHistory = conversationHistory.slice(-5);
      const conversationContext = recentHistory.length > 0
        ? `\n\nCONVERSATION HISTORY (this is a continuing conversation — the current question may be a follow-up to earlier questions):\n${recentHistory.map((h, i) => `Q${i+1}: ${h.question}\nA${i+1}: ${h.answer.slice(0, 600)}…`).join("\n\n")}`
        : "";

      const scoringPrompt = `You are an expert technical document analyst. Using ONLY the document index below, identify which specific sections and pages are most likely to contain the answer to the question.

DOCUMENT INDEX (headings, sections and page numbers extracted from vault documents):
${indexSummary}
${conversationContext}

QUESTION: ${q}
${recentHistory.length > 0 ? "NOTE: This may be a follow-up question. Use the conversation history above to understand the full context before scoring." : ""}

Analyse the index carefully. For every section that could possibly be relevant — even tangentially — assign a probability score. Building regulations frequently contain cross-references, exceptions and caveats in unexpected sections. Be CONSERVATIVE — it is better to include a borderline section than to miss critical information.

NOTE: Select ALL sections that are relevant to the question — do not limit to just one section if multiple sections are relevant.

Respond ONLY as compact JSON — no other text, no explanations, no reasons:
{
  "selectedDocs": [
    {
      "docName": "exact filename from index",
      "sections": [
        {"heading": "exact heading from index", "pageHint": 42, "probability": 0.95}
      ]
    }
  ]
}

Rules:
- Include sections with probability > 0.5
- pageHint MUST be a plain integer. Never use "p.12" or "page 12". Use 1 if unknown.
- Omit "styleNotes", "reason" and "crossRefs" fields entirely — keep JSON compact`;

      const scoringText = await callClaude(
        [{ role: "user", content: scoringPrompt }],
        "You are a technical document analyst. Score document sections for relevance using only the text index provided. Return pure JSON only, no markdown.",
        65000,
        2,
        "gemini-2.5-flash"
      );

      setProgress(p => ({ ...p, select: 100 }));

      let scoring = { selectedDocs: [], styleNotes: "" };
      try {
        const clean = scoringText.replace(/```json|```/g, "").trim();
        scoring = JSON.parse(clean);
      } catch {
        const m = scoringText.match(/\{[\s\S]*\}/);
        if (m) try { scoring = JSON.parse(m[0]); } catch {}
      }
      // If scoring came back empty, log the raw response for debugging
      if (!scoring.selectedDocs || scoring.selectedDocs.length === 0) {
        console.warn("Scoring returned empty — raw response:", scoringText.slice(0, 500));
      }
      // Debug: log scoring result
      console.log("Scoring result:", JSON.stringify(scoring).slice(0, 500));
      console.log("Selected docs:", (scoring.selectedDocs || []).length);
      (scoring.selectedDocs || []).forEach(d => {
        console.log("Doc:", d.docName, "Sections:", (d.sections || []).length);
        (d.sections || []).slice(0, 3).forEach(s => {
          console.log("  Section:", s.heading?.slice(0,30), "pageHint:", JSON.stringify(s.pageHint), typeof s.pageHint);
        });
      });

      // Pre-load all PDFs needed for page extraction (done after scoring, not before)
      setStatusMsg("Pass 1/3 · Loading documents for page extraction…");
      const contentsData = [];
      const selectedDocNames = (scoring.selectedDocs || []).map(d => d.docName);
      const docsNeeded = pdfs.filter(p =>
        selectedDocNames.some(n => p.name.includes(n) || n.includes(p.name))
      );
      const docsToFetch = docsNeeded.length > 0 ? docsNeeded : pdfs.slice(0, 2);

      for (const pdf of docsToFetch) {
        try {
          const pdfData = await api(`/api/vaults/${encodeURIComponent(vault.id)}/pdfs/${encodeURIComponent(pdf.name)}`);
          contentsData.push({ pdf, base64: pdfData.base64 });
        } catch (e) {
          console.warn(`Could not load ${pdf.name}:`, e);
        }
      }

      // ── PASS 2: Extract ONLY the specific pages identified in Pass 1 ─────────
      setStage("reading");
      setStatusMsg("Pass 2/3 · Extracting specific relevant pages only…");

      // Helper to parse page hints in ANY format — very aggressive extraction
      const parsePageNums = (hint) => {
        const pages = new Set();
        if (hint === null || hint === undefined) return pages;

        // Handle plain numbers directly (most common case after prompt fix)
        if (typeof hint === "number") {
          if (hint > 0 && hint < 9999) pages.add(Math.round(hint));
          return pages;
        }

        const str = String(hint).trim();
        if (!str) return pages;

        // Try direct integer parse first
        const directInt = parseInt(str);
        if (!isNaN(directInt) && directInt > 0 && directInt < 9999) {
          pages.add(directInt);
          return pages;
        }

        // Extract all numbers from the string
        const allNums = str.match(/\d+/g);
        if (!allNums) return pages;

        const nums = allNums.map(n => parseInt(n)).filter(n => n > 0 && n < 9999);
        if (nums.length === 0) return pages;

        // Two close numbers = range
        if (nums.length >= 2 && nums[1] > nums[0] && nums[1] <= nums[0] + 30) {
          for (let i = nums[0]; i <= nums[1]; i++) pages.add(i);
          return pages;
        }

        // Otherwise each number is a page
        nums.forEach(n => pages.add(n));
        return pages;
      };

      // Build a ranked list of all sections across all docs, sorted by probability (highest first)
      // This ensures the 90-page budget is spent on the MOST relevant pages first
      const HARD_PAGE_BUDGET = 80;
      const allScoredSections = [];

      (scoring.selectedDocs || []).forEach(selectedDoc => {
        const matchedDoc = contentsData.find(d =>
          d.pdf.name.includes(selectedDoc.docName) || selectedDoc.docName.includes(d.pdf.name)
        );
        if (!matchedDoc) return;

        (selectedDoc.sections || []).forEach(section => {
          const parsed = parsePageNums(section.pageHint);
          if (parsed.size > 0) {
            allScoredSections.push({
              docName: matchedDoc.pdf.name,
              contentsDoc: matchedDoc,
              pages: parsed,
              probability: section.probability || 0,
              heading: section.heading,
            });
          }
        });
      });

      // Sort by probability descending — highest relevance first
      allScoredSections.sort((a, b) => b.probability - a.probability);

      // Fill page budget from highest probability sections downward
      const docPageMap = {};
      let budgetRemaining = HARD_PAGE_BUDGET;

      for (const section of allScoredSections) {
        if (budgetRemaining <= 0) break;

        const key = section.docName;
        if (!docPageMap[key]) docPageMap[key] = { contentsDoc: section.contentsDoc, pages: new Set() };

        // Add the section page plus the next page — tables and figures
        // frequently appear on the page immediately after the section heading
        const pagesToAdd = [];
        section.pages.forEach(p => {
          [0, 1].forEach(offset => {
            const pg = p + offset;
            if (pg > 0 && !docPageMap[key].pages.has(pg)) pagesToAdd.push(pg);
          });
        });
        pagesToAdd.sort((a, b) => a - b);
        for (const p of pagesToAdd) {
          if (budgetRemaining <= 0) break;
          docPageMap[key].pages.add(p);
          budgetRemaining--;
        }
      }

      // Fallback 1: if no docs matched at all, use first 5 pages of top 2 docs
      if (Object.keys(docPageMap).length === 0 && contentsData.length > 0) {
        contentsData.slice(0, 2).forEach(d => {
          docPageMap[d.pdf.name] = { contentsDoc: d, pages: new Set() };
          for (let i = 1; i <= 5; i++) docPageMap[d.pdf.name].pages.add(i);
        });
      }

      // Fallback 2: if docs matched but pages are empty (page hint parsing failed), use first 5 pages
      Object.entries(docPageMap).forEach(([key, val]) => {
        if (val.pages.size === 0) {
          for (let i = 1; i <= 5; i++) val.pages.add(i);
        }
      });

      const pagesUsed = HARD_PAGE_BUDGET - budgetRemaining;
      console.log(`Page budget used: ${pagesUsed}/${HARD_PAGE_BUDGET} pages across ${Object.keys(docPageMap).length} documents`);
      if (pagesUsed === 0) {
        console.warn("WARNING: No pages selected — page hint format may not be parseable");
        // Log what page hints look like for debugging
        (scoring.selectedDocs || []).forEach(d => {
          (d.sections || []).forEach(s => {
            console.log("pageHint sample:", JSON.stringify(s.pageHint), "heading:", s.heading?.slice(0,40));
          });
        });
      }

      // Extract specific pages server-side (reliable binary handling)
      const docBlocks = [];
      let totalPagesExtracted = 0;

      for (const [docName, { contentsDoc, pages }] of Object.entries(docPageMap)) {
        setStatusMsg(`Pass 2/3 · Extracting pages from ${docName}…`);
        const pageList = Array.from(pages).sort((a, b) => a - b);
        if (pageList.length === 0) continue;

        try {
          // Try server-side page extraction first
          const result = await api("/api/extract-pages", {
            method: "POST",
            body: { base64: contentsDoc.base64, pages: pageList }
          });
          totalPagesExtracted += result.pagesExtracted;
          docBlocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: result.base64 },
            title: `${docName} — pages ${result.pageNumbers.join(", ")}`,
          });
          console.log(`Extracted ${result.pagesExtracted} pages from ${docName}`);
        } catch (e) {
          // Page extraction failed — skip this document rather than sending full PDF
          // Full PDFs would be too large and slow to send to Gemini
          console.warn(`Page extraction failed for ${docName}, skipping:`, e.message);
        }
      }

      // Add temp doc to context if one is loaded — sent in full, not page-extracted
      if (tempDoc) {
        docBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: tempDoc.base64 },
          title: `TEMPORARY DOCUMENT (not in vault): ${tempDoc.name}`,
        });
        console.log(`Temp doc included: ${tempDoc.name}`);
      }

      setStatusMsg(`Pass 2/3 · ${totalPagesExtracted} specific pages extracted across ${docBlocks.length} document${docBlocks.length !== 1 ? "s" : ""}…`);
      setProgress(p => ({ ...p, read: 100 }));

      // ── PASS 3: Deep read extracted pages + answer ─────────────────────────
      setStage("answering");
      setStatusMsg("Pass 3/3 · Deep reading selected pages and synthesising answer…");

      const vaultDocNames = pdfs.map(p => p.name).join(", ");
      const focusSections = (scoring.selectedDocs || [])
        .flatMap(d => (d.sections || []).map(s => `${d.docName}: ${s.heading} (p.${s.pageHint})`))
        .join("; ");

      const priorContext = conversationHistory.slice(-5);
      const contextBlock = priorContext.length > 0
        ? `CONVERSATION SO FAR — this question is part of a continuing discussion. Build on what has already been established rather than starting fresh. Do not repeat information already covered unless directly relevant to this new question.\n\n${priorContext.map((h, i) => `Question ${i+1}: ${h.question}\nAnswer ${i+1}: ${h.answer.slice(0, 1000)}`).join("\n\n---\n\n")}\n\n---\n\n`
        : "";

      const answerPrompt = `You are an expert building regulations consultant at an architectural practice. Use ONLY the provided document pages to answer.${tempDoc ? `\n\nNOTE: A temporary document has been included for reference: "${tempDoc.name}". This is not part of the permanent vault — treat it as an additional reference document when answering.` : ""}

${contextBlock}CURRENT QUESTION: ${q}

PRIORITY SECTIONS: ${focusSections || "all sections"}

---

RESPONSE FORMAT — output in this exact order every time:

## Summary

WRITE THIS FIRST. A confident, definitive answer in 2–4 sentences directly addressing the current question. Must:
- Open with a direct answer in plain English
- Reference the key evidence briefly
- Build logically on any prior questions in the conversation where relevant
- Include a table if the source document contains a table relevant to the question. Reproduce it exactly — same columns, same rows, no restructuring. Do NOT wrap tables in > block quote syntax.
- After any table include any footnotes or qualifications from the source as plain italic text.

For each key fact in the summary, include the exact supporting phrase from the document and its source on separate lines:

> "Exact short phrase from document — one sentence maximum."
*Document Name | Page X | Section X.X.X — Clause Heading*

Always cite the most specific clause available — use the subsection number (e.g. 6.6.11) not just the chapter (e.g. 6.6).

---

## Detailed Analysis

WRITE THIS SECOND — only include content that genuinely adds value beyond the summary. Do not repeat figures or tables already shown above.

Two cases only:

CASE 1 — If the summary fully covers the answer and there is nothing meaningful to add:
Write exactly: "The summary above fully addresses this question."

CASE 2 — If there is additional context, conditions, exceptions or cross-references not already covered in the summary:
Write concise bullet points in plain English. Each bullet is one sentence. If a bullet references a table from the document, reproduce that table immediately below the bullet (same columns and rows, no restructuring). Citation on its own italic line immediately after each bullet or table.

RULES:
- Do not repeat anything already in the summary
- No coloured boxes — plain bullets and plain tables only
- Summarise in your own words, do not quote large passages
- Citations: *Document | Page X | Section X.X.X — Clause* on their own line
- Plain language an architect can act on immediately
- Maximum 6 bullets

---

## Contradictions & Conflicts

WRITE THIS LAST. If conflicts exist: one sentence stating the conflict, quotes from each side with citations, then a definitive practical conclusion. If none: "No contradictions identified."

---

RULES:
- Summary MUST come first, Detailed Analysis second, Contradictions last — do not change this order
- Use ONLY the provided document pages — no external knowledge
- Every factual statement must have a citation
- Omit citations rather than guess page numbers
- If pages do not contain enough to answer definitively, state exactly what is missing`;

      const finalAnswer = await callClaude(
        [{ role: "user", content: [...docBlocks, { type: "text", text: answerPrompt }] }],
        `You are an expert building regulations consultant. Answer using ONLY the provided document pages. Always output: (1) ## Summary first, (2) ## Detailed Analysis second, (3) ## Contradictions & Conflicts last. Never change this order. Build on prior conversation context where relevant.`,
        65536
      );

      setProgress(p => ({ ...p, answer: 100 }));
      setAnswer(finalAnswer);
      setStage("done");
      setHistory(prev => [...prev, { vaultId: vault.id, question: q, answer: finalAnswer, timestamp: new Date() }]);
      setConversationHistory(prev => [...prev, { question: q, answer: finalAnswer }]);

      const estimatedTokens = (indexSummary.length + answerPrompt.length + totalPagesExtracted * 500) / 4;
      const costGBP = (estimatedTokens / 1_000_000) * 3 * 0.79;
      setCostEst(costGBP);
      setStatusMsg(`Answer ready · Est. cost: ${costGBP < 0.01 ? "< 1p" : costGBP.toFixed(2) + "p"}`);
    } catch (err) {
      setStage(null);
      if (err.message && err.message.includes('rate_limit')) {
        setStatusMsg('Rate limit reached — retrying automatically in 15 seconds…');
      } else {
        setStatusMsg("Error: " + err.message);
      }
    }
  };

  const isRunning = ["indexing", "selecting", "reading", "answering"].includes(stage);

  // ── render ─────────────────────────────────────────────────────────────────

  const globalStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #f5f3f0; } ::-webkit-scrollbar-thumb { background: #c8c0b8; border-radius: 2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .vault-item { cursor: pointer; transition: all 0.2s; }
    .vault-item:hover { background: #f0f5f6 !important; }
    .btn { cursor: pointer; transition: all 0.2s; border: none; font-family: Inter, Arial, sans-serif; letter-spacing: 0.01em; }
    .btn:hover { opacity: 0.85; }
    .btn:disabled { cursor: not-allowed; opacity: 0.35; }
    .arc-input:focus { outline: 2px solid #0d6478; outline-offset: 0; }
    body { font-family: Inter, Arial, sans-serif; }
  `;

  // ── login screen ────────────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div style={{ fontFamily: "Arial, sans-serif", background: "#f3f2f1", minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <style>{globalStyles}</style>
        <div style={{ background: ARC_NAVY, padding: "20px 40px", display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <span style={{ color: "#ffffff", fontSize: 22, fontWeight: 300, letterSpacing: "0.02em", fontFamily: "Inter, Arial, sans-serif" }}>Architectus</span>
          <span style={{ color: "#7a9aaa", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase" }}>Document Intelligence</span>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: ARC_STONE }}>
          <div style={{ background: "#ffffff", padding: "48px 48px", width: 400, borderTop: `3px solid ${ARC_TERRACOTTA}` }}>
            <p style={{ fontSize: 11, color: "#9a9088", marginBottom: 32, letterSpacing: "0.1em", textTransform: "uppercase" }}>Secure Access</p>
            <label style={{ fontSize: 12, fontWeight: 500, color: ARC_NAVY, display: "block", marginBottom: 8, letterSpacing: "0.05em", textTransform: "uppercase" }}>Password</label>
            <input
              type="password"
              value={passwordInput}
              onChange={e => { setPasswordInput(e.target.value); setPasswordError(false); }}
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              autoFocus
              className="arc-input"
              style={{ width: "100%", border: passwordError ? `1px solid ${ARC_TERRACOTTA}` : `1px solid #ccc`, padding: "12px 14px", fontSize: 14, marginBottom: 6, outline: "none", fontFamily: "Inter, Arial, sans-serif", color: ARC_NAVY }}
            />
            {passwordError && <p style={{ color: ARC_TERRACOTTA, fontSize: 12, marginBottom: 16, letterSpacing: "0.02em" }}>Incorrect password. Please try again.</p>}
            <button className="btn" onClick={handleLogin}
              style={{ marginTop: 20, width: "100%", background: ARC_NAVY, color: "#ffffff", padding: "12px 0", fontSize: 13, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase" }}>
              Sign In
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "Arial, sans-serif", background: "#f3f2f1", minHeight: "100vh", color: "#0b0c0c", display: "flex", flexDirection: "column" }}>
      <style>{globalStyles}</style>

      {/* Architectus top nav */}
      <div style={{ background: ARC_NAVY, padding: "0 40px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, height: 56 }}>
        <span style={{ color: "#ffffff", fontSize: 20, fontWeight: 300, letterSpacing: "0.02em", fontFamily: "Inter, Arial, sans-serif" }}>Architectus</span>
        <span style={{ color: "#7a9aaa", fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase" }}>Document Intelligence</span>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden", maxHeight: "calc(100vh - 56px)" }}>

        {/* sidebar */}
        <div style={{ width: 260, borderRight: "1px solid #e8e0d5", background: ARC_STONE, display: "flex", flexDirection: "column", flexShrink: 0 }}>

          {/* Vault list */}
          <div style={{ padding: "20px 24px 8px", fontSize: 10, color: "#9a9088", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", borderBottom: "1px solid #ddd8d0" }}>Vaults</div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            {loadingVaults ? (
              <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 8, color: "#9a9088", fontSize: 12 }}><Spinner size={12} /> Loading…</div>
            ) : vaults.map(v => (
              <div key={v.id} className="vault-item"
                onClick={() => { setSelectedVault(v.id); setAnswer(null); setStage(null); setCostEst(null); }}
                style={{ padding: "12px 24px", background: selectedVault === v.id ? "#ffffff" : "transparent", borderLeft: selectedVault === v.id ? `3px solid ${ARC_TERRACOTTA}` : "3px solid transparent" }}>
                <div style={{ fontSize: 13, color: ARC_NAVY, fontWeight: selectedVault === v.id ? 600 : 400, letterSpacing: "0.01em" }}>{v.name}</div>
              </div>
            ))}
          </div>

          {creating ? (
            <div style={{ padding: "16px 24px", borderTop: "1px solid #ddd8d0", background: "#f5f3f0" }}>
              <label style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", display: "block", marginBottom: 8, letterSpacing: "0.08em", textTransform: "uppercase" }}>Vault Name</label>
              <input value={newVaultName} onChange={e => setNewVaultName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && createVault()}
                placeholder="Name" autoFocus className="arc-input"
                style={{ width: "100%", border: `1px solid #ccc`, padding: "8px 10px", fontSize: 13, color: ARC_NAVY, marginBottom: 10, outline: "none", background: "#fff", fontFamily: "Inter, Arial, sans-serif" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" onClick={createVault} style={{ background: ARC_NAVY, color: "#ffffff", padding: "7px 16px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase" }}>Create</button>
                <button className="btn" onClick={() => setCreating(false)} style={{ background: "transparent", color: "#9a9088", padding: "7px 12px", fontSize: 11, border: "1px solid #ccc" }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ padding: "16px 24px", borderTop: "1px solid #ddd8d0" }}>
              <button className="btn" onClick={() => setCreating(true)}
                style={{ width: "100%", background: "transparent", color: ARC_NAVY, padding: "9px 0", fontSize: 11, fontWeight: 600, textAlign: "center", border: `1px solid ${ARC_NAVY}`, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                + New Vault
              </button>
            </div>
          )}
        </div>

        {/* main */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#faf8f5" }}>
          {!vault ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <p style={{ fontSize: 20, color: ARC_NAVY, fontWeight: 300, letterSpacing: "0.02em" }}>Select a vault</p>
              <p style={{ fontSize: 12, color: "#9a9088", letterSpacing: "0.04em" }}>Upload documents and query building regulations</p>
            </div>
          ) : (
            <>
              {/* Vault header */}
              <div style={{ borderBottom: `1px solid #e8e0d5`, background: "#ffffff", flexShrink: 0 }}>
                <div style={{ padding: "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <h1 style={{ fontSize: 22, fontWeight: 300, color: ARC_NAVY, letterSpacing: "0.01em", fontFamily: "Inter, Arial, sans-serif" }}>{vault.name}</h1>
                    <p style={{ fontSize: 11, color: "#9a9088", marginTop: 4, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                      {pdfs.length} document{pdfs.length !== 1 ? "s" : ""} &nbsp;·&nbsp;
                      {vaultIndex
                        ? <span style={{ color: AD_GREEN, fontWeight: 600 }}>Indexed</span>
                        : <span style={{ color: ARC_TERRACOTTA }}>Not indexed</span>}
                    </p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {/* Temp doc button */}
                    <div style={{ position: "relative" }}>
                      {tempDoc ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, background: "#fdf5f3", border: `1px solid ${ARC_TERRACOTTA}`, padding: "7px 14px" }}>
                          <span style={{ fontSize: 11, color: ARC_TERRACOTTA, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", letterSpacing: "0.02em" }}>📄 {tempDoc.name}</span>
                          <button className="btn" onClick={() => setTempDoc(null)} title="Remove temporary document"
                            style={{ background: "none", color: "#6f777b", fontSize: 16, padding: "0 2px", fontWeight: 700, lineHeight: 1 }}
                            onMouseEnter={e => e.target.style.color = "#d4351c"}
                            onMouseLeave={e => e.target.style.color = "#6f777b"}>×</button>
                        </div>
                      ) : (
                        <div
                          onDragOver={e => { e.preventDefault(); setTempDocDragOver(true); }}
                          onDragLeave={() => setTempDocDragOver(false)}
                          onDrop={e => { e.preventDefault(); setTempDocDragOver(false); const f = e.dataTransfer.files[0]; if (f) loadTempDoc(f); }}
                          onClick={() => tempDocInputRef.current.click()}
                          style={{ border: `1px dashed ${tempDocDragOver ? AD_GREEN : "#ccc"}`, padding: "7px 16px", cursor: "pointer", background: tempDocDragOver ? "#f0f5f6" : "transparent", display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 11, color: "#9a9088", letterSpacing: "0.03em" }}>📎 Temporary document</span>
                          <span style={{ fontSize: 10, color: "#b0a8a0", letterSpacing: "0.03em" }}>— not saved</span>
                          <input ref={tempDocInputRef} type="file" accept="application/pdf" style={{ display: "none" }} onChange={e => { if (e.target.files[0]) loadTempDoc(e.target.files[0]); }} />
                        </div>
                      )}
                    </div>
                    {pdfs.length > 0 && (
                      <button className="btn" onClick={indexVault} disabled={isRunning}
                        style={{ background: vaultIndex ? "transparent" : ARC_NAVY, color: vaultIndex ? ARC_NAVY : "#ffffff", border: `1px solid ${ARC_NAVY}`, padding: "8px 20px", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                        {stage === "indexing" ? <><Spinner size={12} /> Indexing…</> : vaultIndex ? "Re-index" : "Index Vault"}
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

                {/* PDF panel */}
                <div style={{ width: 220, borderRight: "1px solid #e8e0d5", background: "#faf8f5", display: "flex", flexDirection: "column", flexShrink: 0 }}>
                  <div onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
                    onClick={() => fileInputRef.current.click()}
                    style={{ margin: 12, border: `1px dashed ${dragOver ? AD_GREEN : "#ccc"}`, padding: "14px 10px", textAlign: "center", cursor: "pointer", background: dragOver ? "#f0f5f6" : "transparent" }}>
                    {uploadingPdf ? (
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: AD_GREEN, fontSize: 12 }}><Spinner size={12} /> Uploading…</div>
                    ) : (
                      <>
                        <div style={{ fontSize: 18, marginBottom: 4, opacity: 0.4 }}>📄</div>
                        <p style={{ fontSize: 11, color: "#9a9088", lineHeight: 1.6, letterSpacing: "0.02em" }}>Drop PDFs here<br />or click to browse</p>
                      </>
                    )}
                    <input ref={fileInputRef} type="file" multiple accept="application/pdf" style={{ display: "none" }} onChange={e => addPDFs(e.target.files)} />
                  </div>

                  <div style={{ flex: 1, overflowY: "auto" }}>
                    {pdfs.length > 0 && (
                      <div style={{ padding: "4px 12px 4px", fontSize: 9, color: "#b0a8a0", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", display: "flex", gap: 12, borderBottom: "1px solid #eae5df" }}>
                        <span style={{ color: AD_GREEN }}>● indexed</span>
                        <span style={{ color: "#c0b8b0" }}>○ pending</span>
                      </div>
                    )}
                    {pdfs.map(pdf => {
                      const isIndexed = vaultIndex?.documents?.some(d => d.name === pdf.name);
                      return (
                        <div key={pdf.id} style={{ padding: "8px 12px", display: "flex", alignItems: "center", gap: 6, borderBottom: "1px solid #eae5df" }}>
                          <span style={{ fontSize: 8, color: isIndexed ? AD_GREEN : "#c0b8b0", flexShrink: 0 }}>{isIndexed ? "●" : "○"}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, color: ARC_NAVY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.01em" }}>{pdf.name}</div>
                            <div style={{ fontSize: 9, color: "#b0a8a0", marginTop: 1 }}>{(pdf.size / 1024).toFixed(0)} KB</div>
                          </div>
                          <button className="btn" onClick={() => indexSinglePdf(pdf)} disabled={isRunning} title="Re-index"
                            style={{ background: "none", color: "#b0a8a0", fontSize: 11, padding: "2px 4px", lineHeight: 1, flexShrink: 0 }}
                            onMouseEnter={e => e.target.style.color = AD_GREEN}
                            onMouseLeave={e => e.target.style.color = "#b0a8a0"}>↻</button>
                          <button className="btn" onClick={() => deletePdf(pdf)} disabled={isRunning} title="Remove"
                            style={{ background: "none", color: "#b0a8a0", fontSize: 14, padding: "2px 4px", lineHeight: 1, flexShrink: 0 }}
                            onMouseEnter={e => e.target.style.color = ARC_TERRACOTTA}
                            onMouseLeave={e => e.target.style.color = "#b0a8a0"}>×</button>
                        </div>
                      );
                    })}
                    {pdfs.length === 0 && <p style={{ fontSize: 11, color: "#b0a8a0", textAlign: "center", marginTop: 24, letterSpacing: "0.02em" }}>No documents yet</p>}
                  </div>
                </div>

                {/* Q&A panel */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", background: "#faf8f5" }}>

                  {/* Progress */}
                  {isRunning && (
                    <div style={{ padding: "14px 32px", borderBottom: "1px solid #e8e0d5", background: "#ffffff", flexShrink: 0, animation: "fadeIn 0.3s ease" }}>
                      <div style={{ fontSize: 12, color: ARC_NAVY, marginBottom: 10, display: "flex", alignItems: "center", gap: 8, fontWeight: 500, letterSpacing: "0.02em" }}><Spinner size={12} /> {statusMsg}</div>
                      <ProgressBar label="Pass 1 · Index scoring" pct={progress.select} color={AD_GREEN} />
                      <ProgressBar label="Pass 2 · Page extraction" pct={progress.read} color={ARC_TERRACOTTA} />
                      <ProgressBar label="Pass 3 · Answer synthesis" pct={progress.answer} color={ARC_NAVY} />
                    </div>
                  )}

                  {/* Status bar */}
                  {!isRunning && statusMsg && (
                    <div style={{ padding: "8px 24px", borderBottom: "1px solid #b1b4b6", background: "#ffffff", fontSize: 13, color: "#505a5f", display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
                      <span>{statusMsg}</span>
                      {costEst !== null && (
                        <span style={{ background: costEst < 0.01 ? "#e9f7ef" : "#fff7e6", border: `1px solid ${costEst < 0.01 ? "#00703c" : "#f47738"}`, color: costEst < 0.01 ? "#00703c" : "#f47738", padding: "2px 10px", fontSize: 12, fontWeight: 700 }}>
                          {costEst < 0.01 ? "✓ Under 1p" : `~${(costEst * 100).toFixed(2)}p`}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Answer area */}
                  <div style={{ flex: 1, overflowY: "auto", padding: "20px 28px" }}>

                    {/* History */}
                    {vaultHistory.length > 0 && (
                      <div style={{ marginBottom: 20 }}>
                        {vaultHistory.map((h, i) => (
                          <div key={i} style={{ marginBottom: 8 }}>
                            <div style={{ fontSize: 13, color: "#505a5f", background: "#ffffff", border: "1px solid #b1b4b6", padding: "8px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                              <span style={{ color: "#4a7c20", fontWeight: 700, flexShrink: 0 }}>Q:</span>
                              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.question}</span>
                              <span style={{ fontSize: 11, color: "#6f777b", flexShrink: 0 }}>{new Date(h.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Current answer */}
                    {answer && (
                      <div style={{ animation: "fadeIn 0.4s ease" }}>
                        <div style={{ background: "#ffffff", border: "1px solid #b1b4b6", borderTop: "4px solid #4a7c20", padding: "24px 28px" }}>
                          <p style={{ fontSize: 12, color: "#505a5f", marginBottom: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            Response — {vault.name}
                          </p>
                          <AnswerRenderer text={answer} />
                        </div>
                      </div>
                    )}

                    {!answer && !isRunning && vaultIndex && vaultHistory.length === 0 && (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10 }}>
                        <div style={{ width: 32, height: 2, background: ARC_TERRACOTTA }} />
                        <p style={{ fontSize: 16, color: ARC_NAVY, fontWeight: 300, letterSpacing: "0.02em" }}>Ask a question</p>
                        <p style={{ fontSize: 11, color: "#9a9088", letterSpacing: "0.03em" }}>AI selects the most relevant pages before answering</p>
                      </div>
                    )}

                    {!vaultIndex && !isRunning && pdfs.length > 0 && (
                      <div style={{ border: `1px solid ${ARC_TERRACOTTA}`, borderLeft: `3px solid ${ARC_TERRACOTTA}`, padding: "14px 20px", margin: "24px 0", background: "#fdf5f3" }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: ARC_NAVY, marginBottom: 4 }}>Vault not indexed</p>
                        <p style={{ fontSize: 12, color: "#9a9088" }}>Click Index Vault to prepare documents for searching.</p>
                      </div>
                    )}

                    {pdfs.length === 0 && !isRunning && (
                      <div style={{ border: `1px solid #b8d4da`, borderLeft: `3px solid ${AD_GREEN}`, padding: "14px 20px", margin: "24px 0", background: "#f0f5f6" }}>
                        <p style={{ fontSize: 13, fontWeight: 600, color: ARC_NAVY, marginBottom: 4 }}>No documents uploaded</p>
                        <p style={{ fontSize: 12, color: "#9a9088" }}>Use the panel on the left to upload PDF documents to this vault.</p>
                      </div>
                    )}
                  </div>

                  {/* Question input */}
                  {vaultIndex && (
                    <div style={{ padding: "16px 32px 20px", borderTop: `1px solid #e8e0d5`, background: "#ffffff", flexShrink: 0 }}>
                      <div style={{ display: "flex", gap: 0, alignItems: "stretch" }}>
                        <textarea value={question} onChange={e => setQuestion(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); askQuestion(); } }}
                          placeholder="Ask a question about your building regulations documents…"
                          disabled={isRunning} rows={2} className="arc-input"
                          style={{ flex: 1, border: `1px solid #ddd8d0`, borderRight: "none", padding: "12px 16px", color: ARC_NAVY, fontSize: 13, outline: "none", resize: "none", lineHeight: 1.6, fontFamily: "Inter, Arial, sans-serif", opacity: isRunning ? 0.5 : 1, background: isRunning ? "#faf8f5" : "#ffffff", letterSpacing: "0.01em" }} />
                        <button className="btn" onClick={askQuestion} disabled={isRunning || !question.trim()}
                          style={{ background: isRunning || !question.trim() ? "#f0ede8" : ARC_NAVY, color: isRunning || !question.trim() ? "#9a9088" : "#ffffff", padding: "0 24px", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${isRunning || !question.trim() ? "#ddd8d0" : ARC_NAVY}`, minWidth: 90, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                          {isRunning ? <Spinner size={14} /> : "Search"}
                        </button>
                      </div>
                      {costEst !== null && <p style={{ fontSize: 10, color: "#b0a8a0", marginTop: 6, letterSpacing: "0.04em" }}>Est. cost: {costEst < 0.01 ? "< 1p" : costEst.toFixed(2) + "p"}</p>}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
