// Vault CRUD (R2-backed — no DB), PDF upload/list/delete, heading index,
// and server-side text/page extraction (mupdf in a worker thread). Verbatim.
const express = require("express");
const path = require("path");
const { Worker } = require("worker_threads");
const { ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { requireAuth } = require("../middleware/auth");
const { rateLimit } = require("../middleware/rateLimit");
const { r2, BUCKET } = require("../helpers/clients");
const { movePrefix, deletePrefix, streamToBuffer } = require("../helpers/r2");
const { serverError } = require("../helpers/serverError");

const router = express.Router();

// ── vault routes ──────────────────────────────────────────────────────────────

function sanitizeVaultPath(raw) {
  return String(raw).replace(/\\/g, "/").split("/").filter(seg => seg !== "" && seg !== "." && seg !== "..").join("/");
}

// GET /api/vaults — returns flat vaults and master vaults with their sub-vaults
router.get("/api/vaults", requireAuth, async (req, res) => {
  try {
    const topCmd = new ListObjectsV2Command({ Bucket: BUCKET, Delimiter: "/" });
    const topResult = await r2.send(topCmd);
    const topPrefixes = (topResult.CommonPrefixes || []).map(p => p.Prefix);

    const SYSTEM_PREFIXES = new Set(["products", "projects", "settings"]);
    const vaults = [];

    for (const prefix of topPrefixes) {
      const name = prefix.slice(0, -1);
      if (SYSTEM_PREFIXES.has(name)) continue;

      let meta = {};
      try {
        const metaResult = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${prefix}.vault` }));
        const buf = await streamToBuffer(metaResult.Body);
        meta = JSON.parse(buf.toString());
      } catch (_) {}

      if (meta.type === "master") {
        const subCmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, Delimiter: "/" });
        const subResult = await r2.send(subCmd);
        const subPrefixes = (subResult.CommonPrefixes || []).map(p => p.Prefix);
        const subVaults = subPrefixes.map(sp => {
          const subName = sp.slice(prefix.length, -1);
          return { id: sp.slice(0, -1), name: subName, path: sp.slice(0, -1) };
        });
        vaults.push({ id: name, name, type: "master", subVaults });
      } else {
        vaults.push({ id: name, name, type: "vault" });
      }
    }

    res.json({ vaults });
  } catch (err) {
    return serverError(res, err, "GET /api/vaults");
  }
});

// POST /api/vaults — create a regular vault or master vault
router.post("/api/vaults", requireAuth, async (req, res) => {
  const { name: rawName, type = "vault", parentVault: rawParentVault } = req.body;
  if (!rawName) return res.status(400).json({ error: "Name required" });
  const name = sanitizeVaultPath(rawName);
  const parentVault = rawParentVault ? sanitizeVaultPath(rawParentVault) : undefined;
  if (!name) return res.status(400).json({ error: "Invalid vault name" });

  try {
    if (type === "master") {
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${name}/.vault`,
        Body: JSON.stringify({ created: new Date().toISOString(), type: "master" }),
        ContentType: "application/json",
      }));
      res.json({ id: name, name, type: "master", subVaults: [] });

    } else if (parentVault) {
      const path = `${parentVault}/${name}`;
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${path}/.vault`,
        Body: JSON.stringify({ created: new Date().toISOString(), type: "vault", parent: parentVault }),
        ContentType: "application/json",
      }));
      res.json({ id: path, name, path, type: "vault" });

    } else {
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${name}/.vault`,
        Body: JSON.stringify({ created: new Date().toISOString() }),
        ContentType: "application/json",
      }));
      res.json({ id: name, name, type: "vault" });
    }
  } catch (err) {
    return serverError(res, err, "POST /api/vaults");
  }
});

// PATCH /api/vaults/:vault — rename a vault
router.patch("/api/vaults/*", requireAuth, async (req, res) => {
  const vaultPath = sanitizeVaultPath(req.params[0]);
  const rawNewName = req.body.name;
  if (!rawNewName) return res.status(400).json({ error: "New name required" });
  const newName = sanitizeVaultPath(rawNewName);
  if (!newName) return res.status(400).json({ error: "Invalid vault name" });

  try {
    const parts = vaultPath.split("/");
    let newPath;
    if (parts.length === 1) {
      newPath = newName;
    } else {
      newPath = [...parts.slice(0, -1), newName].join("/");
    }

    const fromPrefix = `${vaultPath}/`;
    const toPrefix = `${newPath}/`;

    await movePrefix(fromPrefix, toPrefix);
    res.json({ id: newPath, name: newName });
  } catch (err) {
    return serverError(res, err, "PATCH /api/vaults/*");
  }
});

// DELETE /api/vaults/:vault/pdfs/:filename — MUST be registered before the
// wildcard DELETE /api/vaults/* below, or that route swallows file deletes
// (its `*` matches across slashes). Specific before wildcard, always.
router.delete("/api/vaults/*/pdfs/:filename", requireAuth, async (req, res) => {
  const vaultPath = sanitizeVaultPath(req.params[0]);
  const { filename } = req.params;
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `${vaultPath}/${filename}` }));
    res.json({ deleted: true });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// DELETE /api/vaults/:vault — delete a vault and all its contents
router.delete("/api/vaults/*", requireAuth, async (req, res) => {
  // Safety net: never treat a file-delete path as a vault delete (see ordering note above).
  if (req.params[0].includes("/pdfs/")) return res.status(404).json({ error: "Not found" });

  const vaultPath = sanitizeVaultPath(req.params[0]);
  try {
    await deletePrefix(`${vaultPath}/`);
    res.json({ deleted: true });
  } catch (err) {
    return serverError(res, err, "DELETE /api/vaults/*");
  }
});

// POST /api/vaults/:vault/adopt — adopt an existing flat vault as a sub-vault of a master
router.post("/api/vaults/*/adopt", requireAuth, async (req, res) => {
  const masterPath = sanitizeVaultPath(req.params[0]);
  const sourceVault = sanitizeVaultPath(req.body.sourceVault || "");
  if (!sourceVault) return res.status(400).json({ error: "sourceVault required" });

  try {
    const fromPrefix = `${sourceVault}/`;
    const toPrefix = `${masterPath}/${sourceVault}/`;
    await movePrefix(fromPrefix, toPrefix);

    try {
      const metaResult = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${toPrefix}.vault` }));
      const buf = await streamToBuffer(metaResult.Body);
      const meta = JSON.parse(buf.toString());
      meta.parent = masterPath;
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `${toPrefix}.vault`,
        Body: JSON.stringify(meta),
        ContentType: "application/json",
      }));
    } catch (_) {}

    res.json({ id: `${masterPath}/${sourceVault}`, name: sourceVault });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// GET /api/vaults/:vault/pdfs
router.get("/api/vaults/*/pdfs", requireAuth, async (req, res) => {
  const vaultPath = sanitizeVaultPath(req.params[0]);
  try {
    const result = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${vaultPath}/` }));
    const pdfs = (result.Contents || [])
      .filter(f => f.Key.endsWith(".pdf"))
      .map(f => ({ id: f.Key, name: f.Key.replace(`${vaultPath}/`, ""), size: f.Size, key: f.Key }));
    res.json({ pdfs });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// POST /api/vaults/:vault/pdfs
router.post("/api/vaults/*/pdfs", requireAuth, async (req, res) => {
  const vaultPath = sanitizeVaultPath(req.params[0]);
  const { name, base64 } = req.body;
  if (!name || !base64) return res.status(400).json({ error: "name and base64 required" });
  const buffer = Buffer.from(base64, "base64");
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${vaultPath}/${name}`,
      Body: buffer,
      ContentType: "application/pdf",
    }));
    res.json({ key: `${vaultPath}/${name}`, name, size: buffer.length });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// GET /api/vaults/:vault/pdfs/:filename
router.get("/api/vaults/*/pdfs/:filename", requireAuth, async (req, res) => {
  const vaultPath = sanitizeVaultPath(req.params[0]);
  const { filename } = req.params;
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${vaultPath}/${filename}` }));
    const buffer = await streamToBuffer(result.Body);
    res.json({ base64: buffer.toString("base64"), name: filename });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// POST /api/vaults/:vault/index
router.post("/api/vaults/*/index", requireAuth, async (req, res) => {
  const vaultPath = sanitizeVaultPath(req.params[0]);
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${vaultPath}/.index.json`,
      Body: JSON.stringify(req.body),
      ContentType: "application/json",
    }));
    res.json({ saved: true });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// GET /api/vaults/:vault/index
router.get("/api/vaults/*/index", requireAuth, async (req, res) => {
  const vaultPath = sanitizeVaultPath(req.params[0]);
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${vaultPath}/.index.json` }));
    const buffer = await streamToBuffer(result.Body);
    res.json(JSON.parse(buffer.toString()));
  } catch (err) {
    if (err.name === "NoSuchKey") return res.json(null);
    return serverError(res, err, req.path);
  }
});

// ── text extraction — server side ────────────────────────────────────────────
router.post("/api/extract-text", requireAuth, rateLimit(30, 60_000), async (req, res) => {
  const { base64 } = req.body;
  if (!base64) return res.status(400).json({ error: "base64 required" });

  const pdfBytes = Buffer.from(base64, "base64");

  try {
    const mupdf = await import("mupdf");
    const doc = new mupdf.PDFDocument(pdfBytes);
    const pageCount = doc.countPages();
    const pages = [];

    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const structured = page.toStructuredText("preserve-whitespace");
        const text = structured.asText();
        pages.push({ page: i + 1, text: text.trim() });
      } catch (_) {
        pages.push({ page: i + 1, text: "" });
      }
    }

    const fullText = pages.map(p => `[Page ${p.page}]\n${p.text}`).join("\n\n");
    const hasText = fullText.replace(/\[Page \d+\]/g, "").trim().length > 100;

    return res.json({ text: fullText, hasText, pageCount });
  } catch (err) {
    console.warn("mupdf text extraction failed:", err.message);
    return res.json({ text: "", hasText: false, pageCount: 0 });
  }
});

// ── page extraction — server side ────────────────────────────────────────────
// mupdf runs in a worker thread so that WASM abort() only kills the worker,
// not the main process. pdf-lib is the fallback if the worker fails.
router.post("/api/extract-pages", requireAuth, rateLimit(30, 60_000), async (req, res) => {
  const { base64, pages, scanGeneral, scanAppendix } = req.body;
  if (!base64 || !pages || !Array.isArray(pages)) {
    return res.status(400).json({ error: "base64 and pages array required" });
  }

  const pdfBytes = Buffer.from(base64, "base64");
  const pageList = pages.map(Number).filter(n => !isNaN(n) && n > 0);
  if (pageList.length === 0) return res.status(400).json({ error: "No valid page numbers" });

  // Attempt 1: mupdf in an isolated worker thread
  try {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, "..", "workers/extractPages.worker.js"), {
        workerData: { pdfBuffer: pdfBytes, pageList, scanGeneral: !!scanGeneral, scanAppendix: !!scanAppendix },
      });
      worker.once("message", msg => msg.error ? reject(new Error(msg.error)) : resolve(msg));
      worker.once("error", reject);
      worker.once("exit", code => { if (code !== 0) reject(new Error(`mupdf worker exited with code ${code}`)); });
    });
    if (result.pageNumbers?.length === 0) return res.status(400).json({ error: "No valid pages" });
    return res.json(result);
  } catch (mupdfErr) {
    if (mupdfErr.message === "no-valid-pages") return res.status(400).json({ error: "No valid pages" });
    console.warn("mupdf worker failed, trying pdf-lib:", mupdfErr.message);
  }

  // Attempt 2: pdf-lib fallback
  try {
    const { PDFDocument } = require("pdf-lib");
    const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
    const totalPages = srcDoc.getPageCount();
    const pageIndices = pageList.map(p => p - 1).filter(i => i >= 0 && i < totalPages);
    if (pageIndices.length === 0) return res.status(400).json({ error: "No valid pages" });
    const extractedDoc = await PDFDocument.create();
    const copiedPages = await extractedDoc.copyPages(srcDoc, pageIndices);
    copiedPages.forEach(p => extractedDoc.addPage(p));
    const extractedBytes = await extractedDoc.save();
    return res.json({
      base64: Buffer.from(extractedBytes).toString("base64"),
      pagesExtracted: pageIndices.length,
      pageNumbers: pageIndices.map(i => i + 1),
    });
  } catch (pdfLibErr) {
    console.error("All extraction methods failed:", pdfLibErr.message);
    return res.status(500).json({ error: pdfLibErr.message });
  }
});

module.exports = router;
