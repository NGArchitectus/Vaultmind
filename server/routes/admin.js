// Admin — user management, practice logo, schedule colours, ArchiSync config,
// staff rates, and project fee. Extracted verbatim from index.js.
const express = require("express");
const { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { requireAuth, requireAdmin, requireTimesheetManager } = require("../middleware/auth");
const { supabase, r2, BUCKET } = require("../helpers/clients");
const { streamToBuffer } = require("../helpers/r2");
const { serverError } = require("../helpers/serverError");
const { generatePassword } = require("../lib/passwordGen");
const { groupQuestionsByPerson } = require("../lib/questionLog");

const router = express.Router();

// ── Q&A usage log ─────────────────────────────────────────────────────────────

// GET /api/admin/question-log — vault Q&A questions grouped by person, admin only.
// Reads the existing vault_question_history table (usage oversight, not an audit
// trail: users can clear their own history and re-asks keep only the latest date).
router.get("/api/admin/question-log", requireAuth, requireAdmin, async (req, res) => {
  try {
    const [{ data: rows, error }, { data: usersData }] = await Promise.all([
      supabase
        .from("vault_question_history")
        .select("user_id, vault_name, question, created_at")
        .order("created_at", { ascending: false })
        .limit(500),
      supabase.auth.admin.listUsers(),
    ]);
    if (error) throw error;
    const nameById = {};
    for (const u of usersData?.users || []) nameById[u.id] = u.user_metadata?.full_name || u.email || u.id;
    res.json({ people: groupQuestionsByPerson(rows || [], nameById) });
  } catch (err) {
    return serverError(res, err, "GET /api/admin/question-log");
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────

router.get("/api/admin/users", requireAuth, requireTimesheetManager, async (req, res) => {
  try {
    const { data, error } = await supabase.auth.admin.listUsers();
    if (error) throw error;
    const users = data.users.map(u => ({
      id: u.id,
      email: u.email,
      role: u.app_metadata?.role || "user",
      created_at: u.created_at,
    }));
    res.json({ users });
  } catch (err) {
    return serverError(res, err, "GET /api/admin/users");
  }
});

router.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: "email and password required" });
  const validRole = ["admin", "hr"].includes(role) ? role : "user";
  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      app_metadata: { role: validRole },
      email_confirm: true,
    });
    if (error) throw error;
    res.json({
      user: {
        id: data.user.id,
        email: data.user.email,
        role: data.user.app_metadata?.role || "user",
        created_at: data.user.created_at,
      },
    });
  } catch (err) {
    return serverError(res, err, "POST /api/admin/users");
  }
});

// GET /api/admin/suggest-password — a fresh generated password (not set on anyone yet)
router.get("/api/admin/suggest-password", requireAuth, requireAdmin, (req, res) => {
  res.json({ password: generatePassword() });
});

// POST /api/admin/users/:uid/password — generate + set a new password, returned once to show the admin
router.post("/api/admin/users/:uid/password", requireAuth, requireAdmin, async (req, res) => {
  const password = generatePassword();
  try {
    const { data, error } = await supabase.auth.admin.updateUserById(req.params.uid, { password });
    if (error) throw error;
    res.json({ password, email: data.user.email });
  } catch (err) {
    return serverError(res, err, "POST /api/admin/users/:uid/password");
  }
});

router.patch("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  const { role } = req.body;
  const validRole = ["admin", "hr"].includes(role) ? role : "user";
  try {
    const { data, error } = await supabase.auth.admin.updateUserById(req.params.uid, {
      app_metadata: { role: validRole },
    });
    if (error) throw error;
    res.json({
      user: {
        id: data.user.id,
        email: data.user.email,
        role: data.user.app_metadata?.role || "user",
      },
    });
  } catch (err) {
    return serverError(res, err, "PATCH /api/admin/users/:uid");
  }
});

router.delete("/api/admin/users/:uid", requireAuth, requireAdmin, async (req, res) => {
  if (req.params.uid === req.user.id) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }
  try {
    const { error } = await supabase.auth.admin.deleteUser(req.params.uid);
    if (error) throw error;
    res.json({ deleted: true });
  } catch (err) {
    return serverError(res, err, "DELETE /api/admin/users/:uid");
  }
});

// ── Admin: practice logo ──────────────────────────────────────────────────────
// Logo is stored in R2 at: settings/practice_logo (no extension — base64 + mime stored as JSON)

router.get("/api/admin/logo", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: "settings/practice_logo.json" }));
    const buf = await streamToBuffer(result.Body);
    res.json(JSON.parse(buf.toString()));
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return res.json({ logo: null });
    }
    return serverError(res, err, req.path);
  }
});

router.post("/api/admin/logo", requireAuth, requireAdmin, async (req, res) => {
  const { base64, mimeType } = req.body;
  if (!base64 || !mimeType) return res.status(400).json({ error: "base64 and mimeType required" });
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: "settings/practice_logo.json",
      Body: JSON.stringify({ base64, mimeType }),
      ContentType: "application/json",
    }));
    res.json({ saved: true });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

router.delete("/api/admin/logo", requireAuth, requireAdmin, async (req, res) => {
  try {
    await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: "settings/practice_logo.json" }));
    res.json({ deleted: true });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// GET /api/logo — public (authenticated) route for frontend to fetch logo for transmittal display
router.get("/api/logo", requireAuth, async (req, res) => {
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: "settings/practice_logo.json" }));
    const buf = await streamToBuffer(result.Body);
    res.json(JSON.parse(buf.toString()));
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return res.json({ logo: null });
    }
    return serverError(res, err, req.path);
  }
});

// ── Admin: schedule colours ───────────────────────────────────────────────────
// Colours stored in R2 at: settings/schedule_colours.json
// Shape: { header, groupRow, bforward, latestIssue, rowEven, rowOdd, headerText, bodyText }

const DEFAULT_COLOURS = {
  header:      "#1a2332",
  groupRow:    "#f0ede8",
  bforward:    "#2e5e8e",
  latestIssue: "#c25a45",
  rowEven:     "#ffffff",
  rowOdd:      "#faf8f5",
  headerText:  "#ffffff",
  bodyText:    "#1a2332",
};

router.get("/api/admin/colours", requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: "settings/schedule_colours.json" }));
    const buf = await streamToBuffer(result.Body);
    res.json(JSON.parse(buf.toString()));
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return res.json(DEFAULT_COLOURS);
    }
    return serverError(res, err, req.path);
  }
});

router.post("/api/admin/colours", requireAuth, requireAdmin, async (req, res) => {
  const colours = req.body;
  if (!colours || typeof colours !== "object") return res.status(400).json({ error: "colours object required" });
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: "settings/schedule_colours.json",
      Body: JSON.stringify({ ...DEFAULT_COLOURS, ...colours }),
      ContentType: "application/json",
    }));
    res.json({ saved: true });
  } catch (err) {
    return serverError(res, err, req.path);
  }
});

// GET /api/colours — authenticated route for all users
router.get("/api/colours", requireAuth, async (req, res) => {
  try {
    const result = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: "settings/schedule_colours.json" }));
    const buf = await streamToBuffer(result.Body);
    res.json(JSON.parse(buf.toString()));
  } catch (err) {
    if (err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) {
      return res.json(DEFAULT_COLOURS);
    }
    return serverError(res, err, req.path);
  }
});

// ── ArchiSync connection config — admin only ──────────────────────────────────
// Returns the values needed to build a connection code in the admin UI.
// SUPABASE_ANON_KEY must be set in Railway environment variables.
router.get("/api/admin/archisync-config", requireAuth, requireAdmin, (req, res) => {
  const apiUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : process.env.API_URL || "";
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

  if (!supabaseAnonKey) {
    return res.status(500).json({ error: "SUPABASE_ANON_KEY is not set on the server. Add it to your Railway environment variables." });
  }

  res.json({ apiUrl, supabaseUrl, supabaseAnonKey });
});

// ── Staff rates (admin) ───────────────────────────────────────────────────────

router.get("/api/admin/staff-rates", requireAuth, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from("staff_rates").select("*");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post("/api/admin/staff-rates", requireAuth, requireAdmin, async (req, res) => {
  const { user_id, rate } = req.body;
  if (!user_id || rate == null) return res.status(400).json({ error: "user_id and rate required" });
  const { data, error } = await supabase
    .from("staff_rates")
    .upsert({ user_id, rate, updated_at: new Date().toISOString() }, { onConflict: "user_id" })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Project fee (admin) ───────────────────────────────────────────────────────

router.patch("/api/admin/projects/:id/fee", requireAuth, requireAdmin, async (req, res) => {
  const { fee } = req.body;
  const { data, error } = await supabase
    .from("projects")
    .update({ fee: fee ?? null, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("id, name, job_number, fee")
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
