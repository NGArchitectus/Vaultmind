const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

// Extend timeout to 5 minutes to handle large Gemini requests
app.use((req, res, next) => {
  res.setTimeout(300000);
  next();
});

// ── R2 client ─────────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET || "vaultmind-docs";

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── Gemini AI proxy ───────────────────────────────────────────────────────────
// Accepts the same request format as before but translates to Gemini API
app.post("/api/claude", async (req, res) => {
  console.log("Gemini request received");
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set." });

  try {
    const { model, max_tokens, system, messages } = req.body;

    // Build Gemini contents array from Anthropic-format messages
    const contents = [];

    // Add system prompt as first user turn if present
    if (system) {
      contents.push({
        role: "user",
        parts: [{ text: `SYSTEM INSTRUCTIONS:\n${system}` }]
      });
      contents.push({
        role: "model",
        parts: [{ text: "Understood. I will follow these instructions." }]
      });
    }

    // Convert each message
    for (const msg of messages) {
      const parts = [];

      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "document" && block.source?.type === "base64") {
            // PDF as inline data
            parts.push({
              inline_data: {
                mime_type: block.source.media_type || "application/pdf",
                data: block.source.data
              }
            });
          }
        }
      }

      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts
      });
    }

    const geminiModel = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: {
          maxOutputTokens: max_tokens || 65000,
          temperature: 0.1,
        }
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Gemini error:", err);
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();

    // Convert Gemini response back to Anthropic format so frontend needs no changes
    // Strip markdown code fences that Gemini wraps around JSON responses
    let text = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
    console.log("Gemini cleaned response (first 500 chars):", text.slice(0, 500));
    res.json({
      content: [{ type: "text", text }]
    });

  } catch (err) {
    console.error("Gemini proxy error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── vault routes ──────────────────────────────────────────────────────────────

app.get("/api/vaults", async (req, res) => {
  try {
    const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: "/" });
    const result = await r2.send(cmd);
    const vaults = (result.CommonPrefixes || []).map(p => ({
      id: p.Prefix.replace("/", ""),
      name: p.Prefix.replace("/", ""),
    }));
    res.json({ vaults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vaults", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${name}/.vault`,
      Body: JSON.stringify({ created: new Date().toISOString() }),
      ContentType: "application/json",
    }));
    res.json({ id: name, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/vaults/:vault/pdfs", async (req, res) => {
  const { vault } = req.params;
  try {
    const result = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${vault}/` }));
    const pdfs = (result.Contents || [])
      .filter(f => f.Key.endsWith(".pdf"))
      .map(f => ({ id: f.Key, name: f.Key.replace(`${vault}/`, ""), size: f.Size, key: f.Key }));
    res.json({ pdfs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vaults/:vault/pdfs", async (req, res) => {
  const { vault } = req.params;
  const { name, base64 } = req.body;
  if (!name || !base64) return res.status(400).json({ error: "name and base64 required" });
  const buffer = Buffer.from(base64, "base64");
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${vault}/${name}`,
      Body: buffer,
      ContentType: "application/pdf",
    }));
    res.json({ key: `${vault}/${name}`, name, size: buffer.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/vaults/:vault/pdfs/:filename", async (req, res) => {
  const { vault, filename } = req.params;
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${vault}/${filename}` }));
    const buffer = await streamToBuffer(result.Body);
    res.json({ base64: buffer.toString("base64"), name: filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/vaults/:vault/pdfs/:filename", async (req, res) => {
  const { vault, filename } = req.params;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `${vault}/${filename}` }));
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/vaults/:vault/index", async (req, res) => {
  const { vault } = req.params;
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${vault}/.index.json`,
      Body: JSON.stringify(req.body),
      ContentType: "application/json",
    }));
    res.json({ saved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/vaults/:vault/index", async (req, res) => {
  const { vault } = req.params;
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${vault}/.index.json` }));
    const buffer = await streamToBuffer(result.Body);
    res.json(JSON.parse(buffer.toString()));
  } catch (err) {
    if (err.name === "NoSuchKey") return res.json(null);
    res.status(500).json({ error: err.message });
  }
});

// ── page extraction — server side ────────────────────────────────────────────
app.post("/api/extract-pages", async (req, res) => {
  const { base64, pages } = req.body;
  if (!base64 || !pages || !Array.isArray(pages)) {
    return res.status(400).json({ error: "base64 and pages array required" });
  }

  const pdfBytes = Buffer.from(base64, "base64");
  const pageList = pages.map(Number).filter(p => p > 0).sort((a, b) => a - b);

  // Attempt 1: mupdf — handles compressed object streams that pdf-lib cannot copy
  // Uses dynamic import() because mupdf is an ES Module
  try {
    const mupdf = await import("mupdf");
    const srcDoc = new mupdf.PDFDocument(pdfBytes);
    const totalPages = srcDoc.countPages();
    const validPages = pageList.filter(p => p <= totalPages);
    if (validPages.length === 0) return res.status(400).json({ error: "No valid pages" });

    // Use mupdf merge approach — copy selected pages into a new document
    const outDoc = new mupdf.PDFDocument();
    const graftMap = outDoc.newGraftMap();
    for (const pageNum of validPages) {
      // Find the page object in the source document
      const pageRef = srcDoc.findPage(pageNum - 1);
      // Graft (deep copy) the page and all its dependencies into outDoc
      const newPageRef = graftMap.graftObject(pageRef);
      // Insert the grafted page at the end
      outDoc.insertPage(-1, newPageRef);
    }
    const outPageCount = outDoc.countPages();
    console.log(`mupdf: inserted ${validPages.length} pages, outDoc has ${outPageCount} pages`);
    if (outPageCount === 0) throw new Error("mupdf produced empty document");
    const rawBuffer = outDoc.saveToBuffer("compress,garbage");
    const outBytes = Buffer.from(Array.from(rawBuffer));
    console.log(`mupdf extracted ${validPages.length} pages successfully`);
    return res.json({
      base64: outBytes.toString("base64"),
      pagesExtracted: validPages.length,
      pageNumbers: validPages
    });
  } catch (mupdfErr) {
    console.warn("mupdf extraction failed, trying pdf-lib:", mupdfErr.message);
  }

  // Attempt 2: pdf-lib fallback
  try {
    const { PDFDocument } = require("pdf-lib");
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const pageIndices = pageList
      .map(p => p - 1)
      .filter(i => i >= 0 && i < totalPages);
    if (pageIndices.length === 0) return res.status(400).json({ error: "No valid pages" });
    const extractedDoc = await PDFDocument.create();
    const copiedPages = await extractedDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => extractedDoc.addPage(p));
    const extractedBytes = await extractedDoc.save();
    console.log(`pdf-lib extracted ${pageIndices.length} pages successfully`);
    return res.json({
      base64: Buffer.from(extractedBytes).toString("base64"),
      pagesExtracted: pageIndices.length,
      pageNumbers: pageIndices.map(i => i + 1)
    });
  } catch (pdfLibErr) {
    console.error("All extraction methods failed:", pdfLibErr.message);
    return res.status(500).json({ error: pdfLibErr.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("*", (req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`VaultMind server running on port ${PORT}`));
