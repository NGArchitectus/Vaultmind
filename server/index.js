const express = require("express");
const cors = require("cors");
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.use(cors());
app.use(express.json({ limit: "100mb" }));

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

// ── Claude proxy ──────────────────────────────────────────────────────────────
app.post("/api/claude", async (req, res) => {
  console.log("Claude request received");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set." });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
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

// ── page extraction endpoint ─────────────────────────────────────────────────
app.post("/api/extract-pages", async (req, res) => {
  const { base64, pages } = req.body;
  if (!base64 || !pages || !Array.isArray(pages)) {
    return res.status(400).json({ error: "base64 and pages array required" });
  }

  try {
    const { PDFDocument } = require("pdf-lib");
    const pdfBytes = Buffer.from(base64, "base64");
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();

    // Convert 1-based page numbers to valid 0-based indices
    const pageIndices = pages
      .map(p => p - 1)
      .filter(i => i >= 0 && i < totalPages)
      .sort((a, b) => a - b);

    if (pageIndices.length === 0) {
      return res.status(400).json({ error: "No valid pages found" });
    }

    const extractedDoc = await PDFDocument.create();
    const copiedPages = await extractedDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => extractedDoc.addPage(p));
    const extractedBytes = await extractedDoc.save();

    // Server-side Buffer.toString("base64") is always correct
    const extractedBase64 = Buffer.from(extractedBytes).toString("base64");

    res.json({
      base64: extractedBase64,
      pagesExtracted: pageIndices.length,
      pageNumbers: pageIndices.map(i => i + 1)
    });
  } catch (err) {
    console.error("Page extraction error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── page extraction endpoint ─────────────────────────────────────────────────
app.post("/api/extract-pages", async (req, res) => {
  const { base64, pages } = req.body;
  if (!base64 || !pages || !Array.isArray(pages)) {
    return res.status(400).json({ error: "base64 and pages array required" });
  }
  try {
    const { PDFDocument } = require("pdf-lib");
    const pdfBytes = Buffer.from(base64, "base64");
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const pageIndices = pages
      .map(p => p - 1)
      .filter(i => i >= 0 && i < totalPages)
      .sort((a, b) => a - b);
    if (pageIndices.length === 0) return res.status(400).json({ error: "No valid pages" });
    const extractedDoc = await PDFDocument.create();
    const copiedPages = await extractedDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => extractedDoc.addPage(p));
    const extractedBytes = await extractedDoc.save();
    const extractedBase64 = Buffer.from(extractedBytes).toString("base64");
    res.json({ base64: extractedBase64, pagesExtracted: pageIndices.length, pageNumbers: pageIndices.map(i => i + 1) });
  } catch (err) {
    console.error("Page extraction error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── page extraction endpoint ─────────────────────────────────────────────────
app.post("/api/extract-pages", async (req, res) => {
  const { base64, pages } = req.body;
  if (!base64 || !pages || !Array.isArray(pages)) {
    return res.status(400).json({ error: "base64 and pages array required" });
  }
  try {
    const { PDFDocument } = require("pdf-lib");
    const pdfBytes = Buffer.from(base64, "base64");
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const pageIndices = pages
      .map(p => p - 1)
      .filter(i => i >= 0 && i < totalPages)
      .sort((a, b) => a - b);
    if (pageIndices.length === 0) return res.status(400).json({ error: "No valid pages" });
    const extractedDoc = await PDFDocument.create();
    const copiedPages = await extractedDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => extractedDoc.addPage(p));
    const extractedBytes = await extractedDoc.save();
    const extractedBase64 = Buffer.from(extractedBytes).toString("base64");
    res.json({ base64: extractedBase64, pagesExtracted: pageIndices.length, pageNumbers: pageIndices.map(i => i + 1) });
  } catch (err) {
    console.error("Page extraction error:", err);
    res.status(500).json({ error: err.message });
  }
});


app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("*", (req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`VaultMind server running on port ${PORT}`));
