import { useState, useEffect, useRef } from "react";
import { api } from "../api/client";
import { Spinner } from "./common/Spinner";
import { ARC_TERRACOTTA, DESIGN_SHELL, DESIGN_GROUND, DESIGN_GOLD } from "../constants";
import QaLogPanel from "./QaLogPanel";

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

const COLOUR_LABELS = {
  header:      "Column Header Background",
  headerText:  "Column Header Text",
  groupRow:    "Group Row Background",
  bforward:    "B' Forward Column",
  latestIssue: "Latest Issue Column",
  rowEven:     "Alternating Row (Even)",
  rowOdd:      "Alternating Row (Odd)",
  bodyText:    "Body Text",
};

const NOTIFICATION_ROWS = [
  { key: "timesheet_submitted", label: "Timesheet submitted",          desc: "When someone submits their timesheet for review" },
  { key: "expense_submitted",   label: "Expense submitted",            desc: "When someone files an expense" },
  { key: "unlock_requested",    label: "Unlock requested",             desc: "When someone asks to edit a locked timesheet" },
  { key: "expense_decided",     label: "Expense approved / rejected",  desc: "When an expense is approved or rejected" },
  { key: "timesheet_rejected",  label: "Timesheet returned",           desc: "When a timesheet is returned for changes" },
];

function RoleToggle({ on, label, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} type="button"
      style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", cursor: disabled ? "default" : "pointer", padding: 0 }}>
      <span style={{ width: 38, height: 20, borderRadius: 10, background: on ? DESIGN_SHELL : "#cfc8c0", position: "relative", transition: "background .15s", flexShrink: 0 }}>
        <span style={{ position: "absolute", top: 2, left: on ? 20 : 2, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left .15s" }} />
      </span>
      <span style={{ fontSize: 11, fontWeight: 600, color: on ? DESIGN_SHELL : "#9a9088", textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</span>
    </button>
  );
}

function NotificationSettings() {
  const [settings, setSettings] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState(null);

  useEffect(() => { api("/api/admin/notification-settings").then(setSettings).catch(() => {}); }, []);

  const setRole = async (key, role, value) => {
    if (!settings || saving) return;
    const prev = settings;
    const cur  = settings[key] || { admin: false, hr: false };
    const next = { ...settings, [key]: { ...cur, [role]: value } };
    setSettings(next);
    setSaving(true);
    try {
      const saved = await api("/api/admin/notification-settings", { method: "PUT", body: next });
      setSettings(saved);
      setToast("Saved"); setTimeout(() => setToast(null), 1500);
    } catch {
      setSettings(prev);
      setToast("Could not save"); setTimeout(() => setToast(null), 2000);
    } finally { setSaving(false); }
  };

  return (
    <div style={{ marginBottom: 48 }}>
      <h2 style={{ fontSize: 16, fontWeight: 300, color: DESIGN_SHELL, marginBottom: 4 }}>Email Notifications</h2>
      <p style={{ fontSize: 12, color: "#9a9088", marginBottom: 20 }}>
        Choose which role is emailed for each event — Admin, HR, both, or neither.
        {toast && <span style={{ marginLeft: 10, color: DESIGN_SHELL, fontWeight: 600 }}>{toast}</span>}
      </p>
      <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "8px 24px", maxWidth: 640 }}>
        {!settings && <p style={{ fontSize: 13, color: "#9a9088", padding: "12px 0" }}>Loading…</p>}
        {settings && NOTIFICATION_ROWS.map(({ key, label, desc }) => {
          const r = settings[key] || { admin: false, hr: false };
          return (
            <div key={key} style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 0", borderBottom: "1px solid #f0ede8" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: DESIGN_SHELL }}>{label}</div>
                <div style={{ fontSize: 11, color: "#9a9088" }}>{desc}</div>
              </div>
              <RoleToggle on={r.admin} label="Admin" disabled={saving} onClick={() => setRole(key, "admin", !r.admin)} />
              <RoleToggle on={r.hr}    label="HR"    disabled={saving} onClick={() => setRole(key, "hr", !r.hr)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimesheetReminderSettings() {
  const [cfg, setCfg]       = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast]   = useState(null);

  useEffect(() => { api("/api/admin/timesheet-reminder").then(setCfg).catch(() => {}); }, []);

  const save = async (patch) => {
    if (!cfg || saving) return;
    const prev = cfg, next = { ...cfg, ...patch };
    setCfg(next); setSaving(true);
    try {
      const saved = await api("/api/admin/timesheet-reminder", { method: "PUT", body: next });
      setCfg(saved); setToast("Saved"); setTimeout(() => setToast(null), 1500);
    } catch {
      setCfg(prev); setToast("Could not save"); setTimeout(() => setToast(null), 2000);
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setSaving(true);
    try {
      const r = await api("/api/admin/timesheet-reminder/test", { method: "POST" });
      setToast(r.sent ? "Test sent to your email" : "Nothing outstanding for you — no test email");
    } catch { setToast("Could not send test"); }
    finally { setSaving(false); setTimeout(() => setToast(null), 2500); }
  };

  const DAYS = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"]];
  const TIMES = [];
  for (let h = 7; h <= 20; h++) { const hh = String(h).padStart(2, "0"); TIMES.push(`${hh}:00`, `${hh}:30`); }
  const inp = { fontSize: 13, padding: "6px 8px", border: "1px solid #d0d8de", background: "#fff", color: DESIGN_SHELL, fontFamily: "Inter, Arial, sans-serif" };

  return (
    <div style={{ marginBottom: 48 }}>
      <h2 style={{ fontSize: 16, fontWeight: 300, color: DESIGN_SHELL, marginBottom: 4 }}>Timesheet Reminder</h2>
      <p style={{ fontSize: 12, color: "#9a9088", marginBottom: 20 }}>
        Emails staff (excluding Admin/HR) who have outstanding timesheets, on the day &amp; time below.
        {toast && <span style={{ marginLeft: 10, color: DESIGN_SHELL, fontWeight: 600 }}>{toast}</span>}
      </p>
      <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "18px 24px", maxWidth: 640 }}>
        {!cfg && <p style={{ fontSize: 13, color: "#9a9088" }}>Loading…</p>}
        {cfg && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: DESIGN_SHELL }}>
              <input type="checkbox" checked={cfg.enabled} disabled={saving} onChange={e => save({ enabled: e.target.checked })} />
              Send weekly reminders
            </label>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "#9a9088" }}>Day<br />
                <select value={cfg.day} disabled={saving} onChange={e => save({ day: Number(e.target.value) })} style={inp}>
                  {DAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: "#9a9088" }}>Time (UK)<br />
                <select value={cfg.time} disabled={saving} onChange={e => save({ time: e.target.value })} style={inp}>
                  {TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: "#9a9088" }}>Chase incomplete weeks from<br />
                <input type="date" value={cfg.track_from} disabled={saving} onChange={e => save({ track_from: e.target.value })} style={inp} />
              </label>
            </div>
            <div>
              <button type="button" onClick={sendTest} disabled={saving}
                style={{ fontSize: 12, padding: "8px 16px", border: `1px solid ${DESIGN_SHELL}`, background: "#fff", color: DESIGN_SHELL, cursor: saving ? "default" : "pointer" }}>
                Send a test reminder to my email
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function HrReportSettings() {
  const [cfg, setCfg]       = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast]   = useState(null);

  useEffect(() => { api("/api/admin/hr-report").then(setCfg).catch(() => {}); }, []);

  const save = async (patch) => {
    if (!cfg || saving) return;
    const prev = cfg, next = { ...cfg, ...patch };
    setCfg(next); setSaving(true);
    try {
      const saved = await api("/api/admin/hr-report", { method: "PUT", body: next });
      setCfg(saved); setToast("Saved"); setTimeout(() => setToast(null), 1500);
    } catch {
      setCfg(prev); setToast("Could not save"); setTimeout(() => setToast(null), 2000);
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setSaving(true);
    try {
      const r = await api("/api/admin/hr-report/test", { method: "POST" });
      setToast(r.sent ? "Test report sent to your email" : "No HR recipients / nothing to send");
    } catch { setToast("Could not send test"); }
    finally { setSaving(false); setTimeout(() => setToast(null), 2500); }
  };

  const DAYS = [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"]];
  const TIMES = [];
  for (let h = 7; h <= 20; h++) { const hh = String(h).padStart(2, "0"); TIMES.push(`${hh}:00`, `${hh}:30`); }
  const inp = { fontSize: 13, padding: "6px 8px", border: "1px solid #d0d8de", background: "#fff", color: DESIGN_SHELL, fontFamily: "Inter, Arial, sans-serif" };

  return (
    <div style={{ marginBottom: 48 }}>
      <h2 style={{ fontSize: 16, fontWeight: 300, color: DESIGN_SHELL, marginBottom: 4 }}>Weekly HR Report</h2>
      <p style={{ fontSize: 12, color: "#9a9088", marginBottom: 20 }}>
        Emails HR a PDF + Excel of everyone's logged hours, on the day &amp; time below.
        {toast && <span style={{ marginLeft: 10, color: DESIGN_SHELL, fontWeight: 600 }}>{toast}</span>}
      </p>
      <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "18px 24px", maxWidth: 640 }}>
        {!cfg && <p style={{ fontSize: 13, color: "#9a9088" }}>Loading…</p>}
        {cfg && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: DESIGN_SHELL }}>
              <input type="checkbox" checked={cfg.enabled} disabled={saving} onChange={e => save({ enabled: e.target.checked })} />
              Send weekly report to HR
            </label>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              <label style={{ fontSize: 12, color: "#9a9088" }}>Day<br />
                <select value={cfg.day} disabled={saving} onChange={e => save({ day: Number(e.target.value) })} style={inp}>
                  {DAYS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: "#9a9088" }}>Time (UK)<br />
                <select value={cfg.time} disabled={saving} onChange={e => save({ time: e.target.value })} style={inp}>
                  {TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label style={{ fontSize: 12, color: "#9a9088" }}>Week covered<br />
                <select value={cfg.coverage} disabled={saving} onChange={e => save({ coverage: e.target.value })} style={inp}>
                  <option value="previous">Previous week</option>
                  <option value="current">Current week</option>
                </select>
              </label>
            </div>
            <div>
              <button type="button" onClick={sendTest} disabled={saving}
                style={{ fontSize: 12, padding: "8px 16px", border: `1px solid ${DESIGN_SHELL}`, background: "#fff", color: DESIGN_SHELL, cursor: saving ? "default" : "pointer" }}>
                Send a test report to my email
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AdminSection() {
  const [users, setUsers] = useState([]);
  const [adminTab, setAdminTab] = useState("users");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Add user form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetPw, setResetPw] = useState(null);        // { uid, password } shown once after a reset
  const [resettingId, setResettingId] = useState(null);
  const [pwCopied, setPwCopied] = useState(false);
  const [newRole, setNewRole] = useState("user");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");

  const [updatingRole, setUpdatingRole] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  // Logo
  const [logo, setLogo] = useState(null);       // { base64, mimeType } | null
  const [logoLoading, setLogoLoading] = useState(true);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoDeleting, setLogoDeleting] = useState(false);
  const [logoMsg, setLogoMsg] = useState(null);
  const logoInputRef = useRef(null);

  // Colours
  const [colours, setColours] = useState(DEFAULT_COLOURS);
  const [coloursLoading, setColoursLoading] = useState(true);
  const [coloursDraft, setColoursDraft] = useState(DEFAULT_COLOURS);
  const [editingColours, setEditingColours] = useState(false);
  const [savingColours, setSavingColours] = useState(false);
  const [coloursMsg, setColoursMsg] = useState(null);

  // ArchiSync connection code
  const [archisyncCode, setArchisyncCode] = useState(null);
  const [archisyncLoading, setArchisyncLoading] = useState(false);
  const [archisyncCopied, setArchisyncCopied] = useState(false);
  const [archisyncPasswordCopied, setArchisyncPasswordCopied] = useState(false);
  const [archisyncPassword, setArchisyncPassword] = useState("");
  const [archisyncShowPassword, setArchisyncShowPassword] = useState(false);

  // Quiz management
  const [quizVaults, setQuizVaults] = useState([]);
  const [quizAdVault, setQuizAdVault] = useState("");
  const [quizAdVaultSaving, setQuizAdVaultSaving] = useState(false);
  const [quizDocs, setQuizDocs] = useState([]); // [{ document_name, count }]
  const [quizDocsLoading, setQuizDocsLoading] = useState(false);
  const [generatingDoc, setGeneratingDoc] = useState(null); // document_name | null
  const [clearingDoc, setClearingDoc] = useState(null);
  const [cscsCount, setCscsCount] = useState(null);
  const [cscsUploading, setCscsUploading] = useState(false);
  const [quizStats, setQuizStats] = useState([]);
  const [quizStatsLoading, setQuizStatsLoading] = useState(false);
  const [quizMsg, setQuizMsg] = useState(null); // { type: 'ok'|'err', text }
  const [cscsClearing, setCscsClearing] = useState(false);
  const cscsInputRef = useRef(null);
  const quizDocsTokenRef = useRef(0); // race guard for loadQuizDocs

  function showMsg(setter, type, text) {
    setter({ type, text });
    setTimeout(() => setter(null), 6000);
  }

  useEffect(() => { loadUsers(); loadLogo(); loadColours(); loadQuizInit(); }, []);

  // ── Users ──────────────────────────────────────────────────────────────────
  const loadUsers = async () => {
    setLoading(true); setError("");
    try {
      const data = await api("/api/admin/users");
      setUsers(data.users || []);
    } catch (e) { setError("Failed to load users: " + e.message); }
    setLoading(false);
  };

  const handleAddUser = async () => {
    if (!newEmail.trim() || !newPassword.trim()) { setAddError("Email and password are required."); return; }
    setAdding(true); setAddError("");
    try {
      await api("/api/admin/users", { method: "POST", body: { email: newEmail.trim(), password: newPassword, role: newRole } });
      setNewEmail(""); setNewPassword(""); setNewRole("user"); setShowAddForm(false);
      await loadUsers();
    } catch (e) { setAddError(e.message); }
    setAdding(false);
  };

  const handleChangeRole = async (uid, role) => {
    setUpdatingRole(uid);
    try {
      await api(`/api/admin/users/${uid}`, { method: "PATCH", body: { role } });
      setUsers(prev => prev.map(u => u.id === uid ? { ...u, role } : u));
    } catch (e) { alert("Failed to update role: " + e.message); }
    setUpdatingRole(null);
  };

  const handleDeleteUser = async (uid, email) => {
    if (!window.confirm(`Delete user "${email}"? This cannot be undone.`)) return;
    setDeletingId(uid);
    try {
      await api(`/api/admin/users/${uid}`, { method: "DELETE" });
      setUsers(prev => prev.filter(u => u.id !== uid));
    } catch (e) { alert("Failed to delete user: " + e.message); }
    setDeletingId(null);
  };

  const handleSuggestPassword = async () => {
    try { const { password } = await api("/api/admin/suggest-password"); setNewPassword(password); setAddError(""); }
    catch { setAddError("Could not generate a password."); }
  };

  const handleResetPassword = async (uid) => {
    setResettingId(uid); setResetPw(null); setPwCopied(false);
    try {
      const { password } = await api(`/api/admin/users/${uid}/password`, { method: "POST" });
      setResetPw({ uid, password });
    } catch (e) { alert("Failed to reset password: " + e.message); }
    setResettingId(null);
  };

  const copyPw = async (pw) => {
    try { await navigator.clipboard.writeText(pw); setPwCopied(true); setTimeout(() => setPwCopied(false), 2000); } catch {}
  };

  // ── Logo ───────────────────────────────────────────────────────────────────
  async function loadLogo() {
    setLogoLoading(true);
    try {
      const data = await api("/api/admin/logo");
      setLogo(data.base64 ? data : null);
    } catch (e) { setLogo(null); }
    setLogoLoading(false);
  }

  async function handleLogoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const allowed = ["image/png", "image/jpeg", "image/svg+xml", "image/webp"];
    if (!allowed.includes(file.type)) {
      showMsg(setLogoMsg, "err", "Please upload a PNG, JPG, SVG or WebP image.");
      e.target.value = ""; return;
    }
    if (file.size > 2 * 1024 * 1024) {
      showMsg(setLogoMsg, "err", "Logo must be under 2 MB.");
      e.target.value = ""; return;
    }
    setLogoUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(",")[1];
        try {
          await api("/api/admin/logo", { method: "POST", body: { base64, mimeType: file.type } });
          await loadLogo();
          showMsg(setLogoMsg, "ok", "Logo uploaded. It will appear on all drawing schedules.");
        } catch (err) { showMsg(setLogoMsg, "err", "Upload failed: " + err.message); }
        setLogoUploading(false);
      };
      reader.onerror = () => { showMsg(setLogoMsg, "err", "Failed to read file."); setLogoUploading(false); };
      reader.readAsDataURL(file);
    } catch (e) { showMsg(setLogoMsg, "err", e.message); setLogoUploading(false); }
    e.target.value = "";
  }

  async function handleLogoDelete() {
    if (!window.confirm("Remove the practice logo? This will affect all drawing schedules.")) return;
    setLogoDeleting(true);
    try {
      await api("/api/admin/logo", { method: "DELETE" });
      setLogo(null);
      showMsg(setLogoMsg, "ok", "Logo removed.");
    } catch (e) { showMsg(setLogoMsg, "err", "Failed to remove logo: " + e.message); }
    setLogoDeleting(false);
  }

  // ── Colours ────────────────────────────────────────────────────────────────
  async function loadColours() {
    setColoursLoading(true);
    try {
      const data = await api("/api/admin/colours");
      setColours(data);
      setColoursDraft(data);
    } catch (e) { /* use defaults */ }
    setColoursLoading(false);
  }

  async function saveColours() {
    setSavingColours(true);
    try {
      await api("/api/admin/colours", { method: "POST", body: coloursDraft });
      setColours(coloursDraft);
      setEditingColours(false);
      showMsg(setColoursMsg, "ok", "Colour scheme saved. Drawing schedules will update immediately.");
    } catch (e) { showMsg(setColoursMsg, "err", "Failed to save colours: " + e.message); }
    setSavingColours(false);
  }

  function resetColours() {
    setColoursDraft({ ...DEFAULT_COLOURS });
  }

  // ── ArchiSync ──────────────────────────────────────────────────────────────
  async function encryptPayload(jsonStr, password) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
      keyMaterial, { name: "AES-GCM", length: 256 }, false, ["encrypt"]
    );
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(jsonStr));
    const combined = new Uint8Array(16 + 12 + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, 16);
    combined.set(new Uint8Array(ciphertext), 28);
    return btoa(String.fromCharCode(...combined));
  }

  async function generateArchisyncCode() {
    if (!archisyncPassword.trim()) {
      alert("Please enter a password before generating the code.");
      return;
    }
    setArchisyncLoading(true);
    setArchisyncCode(null);
    try {
      const data = await api("/api/admin/archisync-config");
      const payload = JSON.stringify({
        apiUrl: data.apiUrl,
        supabaseUrl: data.supabaseUrl,
        supabaseAnonKey: data.supabaseAnonKey
      });
      const encrypted = await encryptPayload(payload, archisyncPassword.trim());
      setArchisyncCode("ARCH-" + encrypted);
    } catch (e) {
      alert("Failed to generate connection code: " + e.message);
    }
    setArchisyncLoading(false);
  }

  async function copyArchisyncCode() {
    if (!archisyncCode) return;
    await navigator.clipboard.writeText(archisyncCode);
    setArchisyncCopied(true);
    setTimeout(() => setArchisyncCopied(false), 2500);
  }

  async function copyArchisyncPassword() {
    if (!archisyncPassword) return;
    await navigator.clipboard.writeText(archisyncPassword);
    setArchisyncPasswordCopied(true);
    setTimeout(() => setArchisyncPasswordCopied(false), 2500);
  }

  // ── Quiz management ────────────────────────────────────────────────────────
  async function loadQuizInit() {
    // Load vaults for selector
    api("/api/vaults").then(d => setQuizVaults(d.vaults || [])).catch(() => {});
    // Load current AD vault setting
    api("/api/admin/quiz/settings").then(d => {
      if (d.quiz_ad_vault_name) {
        setQuizAdVault(d.quiz_ad_vault_name);
        loadQuizDocs(d.quiz_ad_vault_name);
      }
    }).catch(() => {});
    // Load CSCS count
    api("/api/quiz/questions?type=cscs").then(d => setCscsCount(d.questions?.length ?? 0)).catch(() => {});
    // Load stats
    setQuizStatsLoading(true);
    api("/api/admin/quiz/stats")
      .then(d => setQuizStats(d.stats || []))
      .catch(() => {})
      .finally(() => setQuizStatsLoading(false));
  }

  async function loadQuizDocs(vaultName) {
    if (!vaultName) return;
    const token = ++quizDocsTokenRef.current;
    setQuizDocs([]); // clear stale data immediately on vault change
    setQuizDocsLoading(true);
    try {
      const [{ pdfs }, { questions }] = await Promise.all([
        api(`/api/vaults/${encodeURIComponent(vaultName)}/pdfs`),
        api(`/api/quiz/questions?type=approved_docs&vault_name=${encodeURIComponent(vaultName)}`),
      ]);
      if (token !== quizDocsTokenRef.current) return; // discard stale response
      const counts = {};
      (questions || []).forEach(q => { counts[q.document_name] = (counts[q.document_name] || 0) + 1; });
      setQuizDocs((pdfs || []).map(p => ({ document_name: p.name, count: counts[p.name] || 0 })));
    } catch (e) {
      if (token !== quizDocsTokenRef.current) return;
      showMsg(setQuizMsg, "err", "Failed to load documents: " + e.message);
    } finally {
      if (token === quizDocsTokenRef.current) setQuizDocsLoading(false);
    }
  }

  async function saveQuizVault() {
    if (!quizAdVault) return;
    setQuizAdVaultSaving(true);
    setQuizMsg(null);
    try {
      await api("/api/admin/quiz/settings", { method: "PUT", body: { quiz_ad_vault_name: quizAdVault } });
      showMsg(setQuizMsg, "ok", "AD vault saved.");
      loadQuizDocs(quizAdVault);
    } catch (e) {
      showMsg(setQuizMsg, "err", e.message);
    } finally {
      setQuizAdVaultSaving(false);
    }
  }

  async function generateQuizQuestions(document_name) {
    setGeneratingDoc(document_name);
    setQuizMsg(null);
    try {
      const result = await api("/api/admin/quiz/generate", {
        method: "POST",
        body: { vault_name: quizAdVault, document_name },
      });
      showMsg(setQuizMsg, "ok", `Generated ${result.count} questions for ${document_name}`);
      loadQuizDocs(quizAdVault);
    } catch (e) {
      showMsg(setQuizMsg, "err", e.message);
    } finally {
      setGeneratingDoc(null);
    }
  }

  async function clearQuizQuestions(document_name) {
    setClearingDoc(document_name);
    setQuizMsg(null);
    try {
      await api("/api/admin/quiz/questions", {
        method: "DELETE",
        body: { type: "approved_docs", vault_name: quizAdVault, document_name },
      });
      showMsg(setQuizMsg, "ok", `Cleared questions for ${document_name}`);
      loadQuizDocs(quizAdVault);
    } catch (e) {
      showMsg(setQuizMsg, "err", e.message);
    } finally {
      setClearingDoc(null);
    }
  }

  async function uploadCscs(file) {
    if (!file || file.type !== "application/pdf") {
      showMsg(setQuizMsg, "err", "Please select a PDF file.");
      return;
    }
    setCscsUploading(true);
    setQuizMsg(null);
    try {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const result = await api("/api/admin/quiz/upload-cscs", { method: "POST", body: { base64 } });
      setCscsCount(result.count);
      showMsg(setQuizMsg, "ok", `Imported ${result.count} CSCS questions.`);
    } catch (e) {
      showMsg(setQuizMsg, "err", e.message);
    } finally {
      setCscsUploading(false);
    }
  }

  async function clearCscsQuestions() {
    setCscsClearing(true);
    setQuizMsg(null);
    try {
      await api("/api/admin/quiz/questions", { method: "DELETE", body: { type: "cscs" } });
      setCscsCount(0);
      showMsg(setQuizMsg, "ok", "CSCS questions cleared.");
    } catch (e) {
      showMsg(setQuizMsg, "err", e.message);
    } finally {
      setCscsClearing(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const sectionHeader = (title, subtitle) => (
    <div style={{ marginBottom: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 300, color: DESIGN_SHELL, fontFamily: "Inter, Arial, sans-serif", marginBottom: 4 }}>{title}</h2>
      {subtitle && <p style={{ fontSize: 12, color: "#9a9088" }}>{subtitle}</p>}
    </div>
  );

  return (
    <>
    <div style={{ background: DESIGN_SHELL, padding:"12px 40px", display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
      <span style={{ fontSize:11, fontWeight:500, color:"#fff", letterSpacing:".16em", textTransform:"uppercase" }}>Admin</span>
    </div>
    <div style={{ flex: 1, overflowY: "auto", background: "#faf8f5", padding: "32px 40px" }}>

      {/* ── Tab bar ───────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", borderBottom: "2px solid #e8e0d5", marginBottom: 28, gap: 4 }}>
        {[["users","Users"],["notifications","Notifications"],["qalog","Q&A Log"],["quiz","Quiz"],["branding","Branding"],["archisync","ArchiSync"]].map(([key, label]) => (
          <button key={key} onClick={() => setAdminTab(key)}
            style={{ fontSize: 12, padding: "10px 18px", border: "none", background: "none", cursor: "pointer",
              color: adminTab === key ? DESIGN_SHELL : "#9a9088",
              fontWeight: adminTab === key ? 700 : 500,
              borderBottom: adminTab === key ? `2px solid ${DESIGN_SHELL}` : "2px solid transparent",
              marginBottom: -2, fontFamily: "Inter, Arial, sans-serif", letterSpacing: ".04em", textTransform: "uppercase" }}>
            {label}
          </button>
        ))}
      </div>

      {adminTab === "users" && (<>
      {/* ── User Management ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 8, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 300, color: DESIGN_SHELL, letterSpacing: "0.01em", fontFamily: "Inter, Arial, sans-serif", marginBottom: 4 }}>
            User Management
          </h1>
          <p style={{ fontSize: 12, color: "#9a9088", letterSpacing: "0.04em", marginBottom: 28 }}>
            Create and manage Archimind user accounts
          </p>
        </div>
        <button onClick={() => { setShowAddForm(v => !v); setAddError(""); }}
          style={{
            background: showAddForm ? "transparent" : DESIGN_SHELL,
            color: showAddForm ? "#9a9088" : "#fff",
            border: `1px solid ${showAddForm ? "#ccc" : DESIGN_SHELL}`,
            padding: "9px 20px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
            textTransform: "uppercase", cursor: "pointer", fontFamily: "Inter, Arial, sans-serif",
          }}>
          {showAddForm ? "Cancel" : "+ Add User"}
        </button>
      </div>

      {showAddForm && (
        <div style={{ background: "#fff", border: `1px solid #e0dbd4`, borderTop: `3px solid ${ARC_TERRACOTTA}`, padding: "24px 28px", marginBottom: 24, maxWidth: 480 }}>
          <p style={{ fontSize: 10, color: "#9a9088", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 20 }}>New User</p>
          <label style={labelStyle}>Email</label>
          <input type="email" value={newEmail} onChange={e => { setNewEmail(e.target.value); setAddError(""); }}
            onKeyDown={e => e.key === "Enter" && handleAddUser()} autoFocus style={inputStyle(!!addError)} />
          <label style={labelStyle}>Password</label>
          <div style={{ display: "flex", gap: 8, alignItems: "stretch", marginBottom: 16 }}>
            <input type="text" value={newPassword} onChange={e => { setNewPassword(e.target.value); setAddError(""); }}
              onKeyDown={e => e.key === "Enter" && handleAddUser()} style={{ ...inputStyle(!!addError), flex: 1, marginBottom: 0 }} />
            <button type="button" onClick={handleSuggestPassword}
              style={{ background: "none", border: `1px solid ${DESIGN_SHELL}`, color: DESIGN_SHELL, padding: "0 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "Inter, Arial, sans-serif" }}>
              ↻ Generate
            </button>
          </div>
          <label style={labelStyle}>Role</label>
          <select value={newRole} onChange={e => setNewRole(e.target.value)}
            style={{ ...inputStyle(false), cursor: "pointer" }}>
            <option value="user">User</option>
            <option value="admin">Admin</option>
            <option value="hr">HR</option>
          </select>
          {addError && <p style={{ color: ARC_TERRACOTTA, fontSize: 12, marginBottom: 12 }}>{addError}</p>}
          <button onClick={handleAddUser} disabled={adding}
            style={{ marginTop: 8, background: DESIGN_SHELL, color: "#fff", border: "none", padding: "10px 24px", fontSize: 12, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: adding ? "not-allowed" : "pointer", opacity: adding ? 0.6 : 1, display: "flex", alignItems: "center", gap: 8, fontFamily: "Inter, Arial, sans-serif" }}>
            {adding ? <><Spinner size={12} /> Creating…</> : "Create User"}
          </button>
        </div>
      )}

      {error && (
        <div style={{ background: "#fdf5f3", border: `1px solid ${ARC_TERRACOTTA}`, borderLeft: `3px solid ${ARC_TERRACOTTA}`, padding: "12px 16px", marginBottom: 20 }}>
          <p style={{ fontSize: 13, color: ARC_TERRACOTTA }}>{error}</p>
        </div>
      )}

      <div style={{ background: "#fff", border: "1px solid #e0dbd4", marginBottom: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 120px 170px 40px", padding: "10px 20px", borderBottom: "1px solid #e8e0d5", background: DESIGN_GROUND }}>
          {["Email", "Role", "Created", "Password", ""].map(h => (
            <span key={h} style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</span>
          ))}
        </div>
        {loading ? (
          <div style={{ padding: "24px 20px", display: "flex", alignItems: "center", gap: 10, color: "#9a9088", fontSize: 13 }}><Spinner size={14} /> Loading users…</div>
        ) : users.length === 0 ? (
          <div style={{ padding: "24px 20px", fontSize: 13, color: "#9a9088" }}>No users found.</div>
        ) : users.map(u => (
          <div key={u.id} style={{ display: "grid", gridTemplateColumns: "1fr 110px 120px 170px 40px", padding: "12px 20px", borderBottom: "1px solid #f0ede8", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: DESIGN_SHELL, letterSpacing: "0.01em" }}>{u.email}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <select value={u.role} onChange={e => handleChangeRole(u.id, e.target.value)} disabled={updatingRole === u.id}
                style={{ fontSize: 11, padding: "3px 6px", border: `1px solid ${u.role === "admin" ? ARC_TERRACOTTA : "#ccc"}`, color: u.role === "admin" ? ARC_TERRACOTTA : "#505a5f", background: "#fff", cursor: "pointer", fontFamily: "Inter, Arial, sans-serif", fontWeight: u.role === "admin" ? 600 : 400, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
                <option value="hr">HR</option>
              </select>
              {updatingRole === u.id && <Spinner size={11} />}
            </div>
            <span style={{ fontSize: 12, color: "#9a9088" }}>
              {u.created_at ? new Date(u.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—"}
            </span>
            {resetPw?.uid === u.id ? (
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <code style={{ fontSize: 12, fontWeight: 700, color: "#2e4a1e" }}>{resetPw.password}</code>
                <button onClick={() => copyPw(resetPw.password)} title="Copy"
                  style={{ background: "none", border: "1px solid #b9d3a6", color: "#2e7d32", fontSize: 10, padding: "2px 6px", cursor: "pointer", fontFamily: "Inter, Arial, sans-serif" }}>
                  {pwCopied ? "✓" : "Copy"}
                </button>
                <button onClick={() => setResetPw(null)} title="Dismiss"
                  style={{ background: "none", border: "none", color: "#bbb", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>×</button>
              </div>
            ) : (
              <button onClick={() => handleResetPassword(u.id)} disabled={resettingId === u.id}
                style={{ background: "none", border: "1px solid #ccc", color: "#505a5f", fontSize: 10, padding: "3px 8px", cursor: resettingId === u.id ? "not-allowed" : "pointer", fontFamily: "Inter, Arial, sans-serif", whiteSpace: "nowrap" }}>
                {resettingId === u.id ? <Spinner size={10} /> : "Reset password"}
              </button>
            )}
            <button onClick={() => handleDeleteUser(u.id, u.email)} disabled={deletingId === u.id} title="Delete user"
              style={{ background: "none", border: "none", color: "#c0b8b0", fontSize: 14, cursor: deletingId === u.id ? "not-allowed" : "pointer", padding: "2px 6px", fontFamily: "Inter, Arial, sans-serif", transition: "color 0.15s" }}
              onMouseEnter={e => e.target.style.color = ARC_TERRACOTTA} onMouseLeave={e => e.target.style.color = "#c0b8b0"}>
              {deletingId === u.id ? <Spinner size={12} /> : "×"}
            </button>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 11, color: "#b0a8a0", marginBottom: 48, letterSpacing: "0.03em" }}>
        {users.length} user{users.length !== 1 ? "s" : ""}
      </p>

      </>)}

      {adminTab === "notifications" && (<><NotificationSettings /><TimesheetReminderSettings /><HrReportSettings /></>)}

      {adminTab === "qalog" && <QaLogPanel />}

      {adminTab === "branding" && (<>
      {/* ── Practice Logo ─────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 48 }}>
        {sectionHeader("Practice Logo", "Appears in the header of all drawing schedules. PNG, JPG, SVG or WebP, max 2 MB.")}
        <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "24px 28px", maxWidth: 560 }}>

          {logoMsg && (
            <div style={{ padding: "10px 14px", marginBottom: 16, fontSize: 12, background: logoMsg.type === "ok" ? "#eef6ee" : "#fdf0f0", border: `1px solid ${logoMsg.type === "ok" ? "#a8d4a8" : "#f0b8b8"}`, color: logoMsg.type === "ok" ? "#2e7d4f" : ARC_TERRACOTTA }}>
              {logoMsg.text}
            </div>
          )}

          {logoLoading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#9a9088", fontSize: 13 }}><Spinner size={13} /> Loading…</div>
          ) : logo?.base64 ? (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>Current Logo</p>
              <div style={{ background: "#faf8f5", border: "1px solid #e8e0d5", padding: "16px 20px", display: "inline-flex", alignItems: "center", gap: 20, marginBottom: 16 }}>
                <img
                  src={`data:${logo.mimeType};base64,${logo.base64}`}
                  alt="Practice logo"
                  style={{ maxHeight: 60, maxWidth: 200, objectFit: "contain" }}
                />
                <button onClick={handleLogoDelete} disabled={logoDeleting}
                  style={{ fontSize: 11, color: ARC_TERRACOTTA, background: "none", border: `1px solid ${ARC_TERRACOTTA}`, padding: "5px 14px", fontWeight: 600, letterSpacing: "0.04em", cursor: "pointer", fontFamily: "Inter, Arial, sans-serif", display: "flex", alignItems: "center", gap: 6 }}>
                  {logoDeleting ? <><Spinner size={10} /> Removing…</> : "× Remove"}
                </button>
              </div>
            </div>
          ) : (
            <p style={{ fontSize: 13, color: "#9a9088", fontStyle: "italic", marginBottom: 16 }}>No logo uploaded yet.</p>
          )}

          <label style={{ background: DESIGN_SHELL, color: "#fff", border: "none", padding: "10px 20px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: logoUploading ? "not-allowed" : "pointer", display: "inline-flex", alignItems: "center", gap: 8, fontFamily: "Inter, Arial, sans-serif", opacity: logoUploading ? 0.6 : 1 }}>
            {logoUploading ? <><Spinner size={11} /> Uploading…</> : (logo?.base64 ? "↑ Replace Logo" : "↑ Upload Logo")}
            <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={handleLogoUpload} disabled={logoUploading} style={{ display: "none" }} />
          </label>
        </div>
      </div>

      {/* ── Drawing Schedule Colours ──────────────────────────────────────── */}
      <div style={{ marginBottom: 48 }}>
        {sectionHeader("Drawing Schedule Colours", "Customise the colour scheme used in all drawing schedules and exports.")}
        <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "24px 28px", maxWidth: 560 }}>

          {coloursMsg && (
            <div style={{ padding: "10px 14px", marginBottom: 16, fontSize: 12, background: coloursMsg.type === "ok" ? "#eef6ee" : "#fdf0f0", border: `1px solid ${coloursMsg.type === "ok" ? "#a8d4a8" : "#f0b8b8"}`, color: coloursMsg.type === "ok" ? "#2e7d4f" : ARC_TERRACOTTA }}>
              {coloursMsg.text}
            </div>
          )}

          {coloursLoading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#9a9088", fontSize: 13 }}><Spinner size={13} /> Loading…</div>
          ) : editingColours ? (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px 24px", marginBottom: 20 }}>
                {Object.entries(COLOUR_LABELS).map(([key, label]) => (
                  <div key={key}>
                    <label style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", textTransform: "uppercase", letterSpacing: "0.06em", display: "block", marginBottom: 5 }}>{label}</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input
                        type="color"
                        value={coloursDraft[key] || DEFAULT_COLOURS[key]}
                        onChange={e => setColoursDraft(prev => ({ ...prev, [key]: e.target.value }))}
                        style={{ width: 40, height: 32, border: "1px solid #ddd8d0", cursor: "pointer", padding: 2 }}
                      />
                      <input
                        type="text"
                        value={coloursDraft[key] || ""}
                        onChange={e => setColoursDraft(prev => ({ ...prev, [key]: e.target.value }))}
                        style={{ width: 80, border: "1px solid #ddd8d0", padding: "5px 8px", fontSize: 12, fontFamily: "Inter, Arial, sans-serif", color: DESIGN_SHELL, outline: "none" }}
                      />
                      <div style={{ width: 20, height: 20, background: coloursDraft[key], border: "1px solid #ddd8d0", flexShrink: 0 }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Live preview strip */}
              <div style={{ marginBottom: 20 }}>
                <p style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Preview</p>
                <div style={{ border: "1px solid #e0dbd4", overflow: "hidden", fontSize: 11, fontFamily: "Inter, Arial, sans-serif" }}>
                  <div style={{ display: "flex" }}>
                    <div style={{ flex: 3, padding: "6px 10px", background: coloursDraft.header, color: coloursDraft.headerText, fontWeight: 600, fontSize: 10, letterSpacing: "0.05em", textTransform: "uppercase" }}>Drawing Title</div>
                    <div style={{ width: 90, padding: "6px 8px", background: coloursDraft.header, color: coloursDraft.headerText, fontWeight: 600, fontSize: 10, textTransform: "uppercase", textAlign: "center" }}>Drawing No.</div>
                    <div style={{ width: 60, padding: "6px 8px", background: coloursDraft.bforward, color: coloursDraft.headerText, fontWeight: 600, fontSize: 10, textTransform: "uppercase", textAlign: "center" }}>B' Fwd</div>
                    <div style={{ width: 50, padding: "6px 8px", background: coloursDraft.latestIssue, color: coloursDraft.headerText, fontWeight: 600, fontSize: 10, textAlign: "center" }}>01/04</div>
                  </div>
                  <div style={{ display: "flex", background: coloursDraft.groupRow }}>
                    <div style={{ flex: 1, padding: "5px 10px", color: coloursDraft.bodyText, fontWeight: 700, fontSize: 10, textTransform: "uppercase" }}>GA Plans</div>
                  </div>
                  <div style={{ display: "flex", background: coloursDraft.rowEven }}>
                    <div style={{ flex: 3, padding: "5px 10px", color: coloursDraft.bodyText }}>Ground Floor Plan</div>
                    <div style={{ width: 90, padding: "5px 8px", color: coloursDraft.bodyText, textAlign: "center" }}>XX-GA-001</div>
                    <div style={{ width: 60, padding: "5px 8px", background: coloursDraft.bforward + "22", color: coloursDraft.bodyText, textAlign: "center", fontWeight: 700 }}>P02</div>
                    <div style={{ width: 50, padding: "5px 8px", background: coloursDraft.latestIssue + "22", color: coloursDraft.bodyText, textAlign: "center" }}>P02</div>
                  </div>
                  <div style={{ display: "flex", background: coloursDraft.rowOdd }}>
                    <div style={{ flex: 3, padding: "5px 10px", color: coloursDraft.bodyText }}>First Floor Plan</div>
                    <div style={{ width: 90, padding: "5px 8px", color: coloursDraft.bodyText, textAlign: "center" }}>XX-GA-002</div>
                    <div style={{ width: 60, padding: "5px 8px", background: coloursDraft.bforward + "22", color: coloursDraft.bodyText, textAlign: "center" }}>—</div>
                    <div style={{ width: 50, padding: "5px 8px", background: coloursDraft.latestIssue + "22", color: coloursDraft.bodyText, textAlign: "center" }}></div>
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={saveColours} disabled={savingColours}
                  style={{ background: DESIGN_SHELL, color: "#fff", border: "none", padding: "9px 20px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: savingColours ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 8, fontFamily: "Inter, Arial, sans-serif" }}>
                  {savingColours ? <><Spinner size={11} /> Saving…</> : "Save Colours"}
                </button>
                <button onClick={resetColours}
                  style={{ background: "none", color: "#9a9088", border: "1px solid #ddd8d0", padding: "8px 16px", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer", fontFamily: "Inter, Arial, sans-serif" }}>
                  Reset to Default
                </button>
                <button onClick={() => { setColoursDraft({ ...colours }); setEditingColours(false); }}
                  style={{ background: "none", color: "#9a9088", border: "none", padding: "8px 12px", fontSize: 11, cursor: "pointer", fontFamily: "Inter, Arial, sans-serif" }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              {/* Colour swatches summary */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
                {Object.entries(COLOUR_LABELS).map(([key, label]) => (
                  <div key={key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <div style={{ width: 18, height: 18, background: colours[key], border: "1px solid #e0dbd4", flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: "#6a6058" }}>{label}</span>
                  </div>
                ))}
              </div>
              <button onClick={() => { setColoursDraft({ ...colours }); setEditingColours(true); }}
                style={{ background: DESIGN_SHELL, color: "#fff", border: "none", padding: "9px 20px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer", fontFamily: "Inter, Arial, sans-serif" }}>
                Edit Colours
              </button>
            </div>
          )}
        </div>
      </div>

      </>)}

      {adminTab === "quiz" && (<>
      {/* ── Quiz Management ──────────────────────────────────────────────── */}
      <div style={{ marginBottom: 48 }}>
        {sectionHeader("Quiz Management", "Generate practice questions for Approved Documents and upload the CSCS question bank.")}

        {quizMsg && (
          <div style={{ padding: "10px 14px", marginBottom: 16, fontSize: 12,
            background: quizMsg.type === "ok" ? "#eef6ee" : "#fdf0f0",
            border: `1px solid ${quizMsg.type === "ok" ? "#a8d4a8" : "#f0b8b8"}`,
            color: quizMsg.type === "ok" ? "#2e7d4f" : ARC_TERRACOTTA, maxWidth: 560 }}>
            {quizMsg.text}
          </div>
        )}

        {/* AD Vault selector */}
        <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "20px 24px", maxWidth: 560, marginBottom: 20 }}>
          <p style={{ fontSize: 10, color: "#9a9088", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>Approved Documents Vault</p>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <select
              value={quizAdVault}
              onChange={e => { setQuizAdVault(e.target.value); loadQuizDocs(e.target.value); }}
              style={{ flex: 1, fontSize: 12, padding: "7px 10px", border: "1px solid #d0ccc8", background: "#fff", color: DESIGN_SHELL, fontFamily: "Inter, Arial, sans-serif" }}
            >
              <option value="">— Select vault —</option>
              {quizVaults.map(v => (
                <option key={v.id || v.name} value={v.name}>{v.name}</option>
              ))}
            </select>
            <button
              onClick={saveQuizVault}
              disabled={!quizAdVault || quizAdVaultSaving}
              style={{ background: DESIGN_SHELL, color: "#fff", border: "none", padding: "8px 18px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: (!quizAdVault || quizAdVaultSaving) ? "not-allowed" : "pointer", opacity: !quizAdVault ? 0.5 : 1, display: "flex", alignItems: "center", gap: 6, fontFamily: "Inter, Arial, sans-serif" }}
            >
              {quizAdVaultSaving ? <><Spinner size={11} /> Saving…</> : "Save"}
            </button>
          </div>
        </div>

        {/* AD documents table */}
        {quizAdVault && (
          <div style={{ background: "#fff", border: "1px solid #e0dbd4", maxWidth: 720, marginBottom: 20 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 180px", padding: "10px 16px", borderBottom: "1px solid #e8e0d5", background: DESIGN_GROUND }}>
              {["Document", "Questions", ""].map(h => (
                <span key={h} style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", textTransform: "uppercase", letterSpacing: "0.08em" }}>{h}</span>
              ))}
            </div>
            {quizDocsLoading ? (
              <div style={{ padding: "16px", display: "flex", alignItems: "center", gap: 8, color: "#9a9088", fontSize: 12 }}><Spinner size={12} /> Loading…</div>
            ) : quizDocs.length === 0 ? (
              <div style={{ padding: "16px", fontSize: 12, color: "#9a9088" }}>No PDFs found in this vault.</div>
            ) : quizDocs.map(({ document_name, count }) => (
              <div key={document_name} style={{ display: "grid", gridTemplateColumns: "1fr 100px 180px", padding: "10px 16px", borderBottom: "1px solid #f0ede8", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: DESIGN_SHELL, overflowWrap: "anywhere", minWidth: 0 }}>{document_name}</span>
                <span style={{ fontSize: 12, color: count > 0 ? "#2e7d4f" : "#9a9088" }}>{count > 0 ? count : "None"}</span>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => generateQuizQuestions(document_name)}
                    disabled={generatingDoc === document_name}
                    style={{ fontSize: 10, padding: "4px 10px", background: DESIGN_SHELL, color: "#fff", border: "none", cursor: generatingDoc === document_name ? "not-allowed" : "pointer", letterSpacing: "0.04em", display: "flex", alignItems: "center", gap: 4, fontFamily: "Inter, Arial, sans-serif" }}
                  >
                    {generatingDoc === document_name ? <><Spinner size={10} /> Generating…</> : "Generate"}
                  </button>
                  {count > 0 && (
                    <button
                      onClick={() => clearQuizQuestions(document_name)}
                      disabled={clearingDoc === document_name}
                      style={{ fontSize: 10, padding: "4px 10px", background: "none", color: "#c0b8b0", border: "1px solid #d0ccc8", cursor: clearingDoc === document_name ? "not-allowed" : "pointer", fontFamily: "Inter, Arial, sans-serif" }}
                    >
                      {clearingDoc === document_name ? <Spinner size={10} /> : "Clear"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* CSCS upload */}
        <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "20px 24px", maxWidth: 560, marginBottom: 20 }}>
          <p style={{ fontSize: 10, color: "#9a9088", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 12 }}>
            CSCS Question Bank
            {cscsCount !== null && (
              <span style={{ marginLeft: 8, color: cscsCount > 0 ? "#2e7d4f" : "#9a9088", fontWeight: 400, textTransform: "none" }}>
                ({cscsCount} questions stored)
              </span>
            )}
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input ref={cscsInputRef} type="file" accept="application/pdf" style={{ display: "none" }}
              onChange={e => { if (e.target.files[0]) { uploadCscs(e.target.files[0]); e.target.value = ""; } }} />
            <button
              onClick={() => cscsInputRef.current?.click()}
              disabled={cscsUploading}
              style={{ background: DESIGN_SHELL, color: "#fff", border: "none", padding: "8px 18px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", cursor: cscsUploading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "Inter, Arial, sans-serif" }}
            >
              {cscsUploading ? <><Spinner size={11} /> Uploading…</> : "Upload CSCS PDF"}
            </button>
            {cscsCount > 0 && (
              <button
                onClick={clearCscsQuestions}
                disabled={cscsClearing}
                style={{ fontSize: 10, padding: "8px 14px", background: "none", color: "#c0b8b0", border: "1px solid #d0ccc8", cursor: cscsClearing ? "not-allowed" : "pointer", fontFamily: "Inter, Arial, sans-serif", display: "flex", alignItems: "center", gap: 4 }}
              >
                {cscsClearing ? <Spinner size={10} /> : "Clear all"}
              </button>
            )}
          </div>
        </div>

        {/* User stats table */}
        <div style={{ marginTop: 8 }}>
          {sectionHeader("Quiz Stats — All Users", "Correct and incorrect answer counts per user.")}
          <div style={{ background: "#fff", border: "1px solid #e0dbd4", maxWidth: 680 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 110px 110px", padding: "10px 16px", borderBottom: "1px solid #e8e0d5", background: DESIGN_GROUND }}>
              {["User", "AD Correct", "AD Incorrect", "CSCS Correct", "CSCS Incorrect"].map(h => (
                <span key={h} style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</span>
              ))}
            </div>
            {quizStatsLoading ? (
              <div style={{ padding: 16, display: "flex", alignItems: "center", gap: 8, color: "#9a9088", fontSize: 12 }}><Spinner size={12} /> Loading…</div>
            ) : quizStats.length === 0 ? (
              <div style={{ padding: 16, fontSize: 12, color: "#9a9088" }}>No quiz activity yet.</div>
            ) : quizStats.map(s => (
              <div key={s.user_id} style={{ display: "grid", gridTemplateColumns: "1fr 110px 110px 110px 110px", padding: "10px 16px", borderBottom: "1px solid #f0ede8", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: DESIGN_SHELL }}>{s.email}</span>
                <span style={{ fontSize: 12, color: "#2e7d4f" }}>{s.ad_correct}</span>
                <span style={{ fontSize: 12, color: ARC_TERRACOTTA }}>{s.ad_incorrect}</span>
                <span style={{ fontSize: 12, color: "#2e7d4f" }}>{s.cscs_correct}</span>
                <span style={{ fontSize: 12, color: ARC_TERRACOTTA }}>{s.cscs_incorrect}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      </>)}

      {adminTab === "archisync" && (<>
      {/* ── ArchiSync Connection ──────────────────────────────────────────── */}
      <div style={{ marginBottom: 48 }}>
        {sectionHeader("ArchiSync Connection", "Generate an encrypted connection code to link the ArchiSync desktop tool to this Archimind deployment.")}
        <div style={{ background: "#fff", border: "1px solid #e0dbd4", borderTop: `3px solid ${DESIGN_SHELL}`, padding: "24px 28px", maxWidth: 560 }}>

          <p style={{ fontSize: 13, color: "#6a6058", lineHeight: 1.7, marginBottom: 20 }}>
            Share this code with anyone who needs to connect ArchiSync to this Archimind instance.
            The code is encrypted with a password — share the code and password through separate channels.
            Codes do not expire but you can generate a new one at any time.
          </p>

          <label style={labelStyle}>Encryption Password</label>
          <div style={{ position: "relative", marginBottom: 0 }}>
            <input
              type={archisyncShowPassword ? "text" : "password"}
              value={archisyncPassword}
              onChange={e => setArchisyncPassword(e.target.value)}
              placeholder="Choose a password for this code"
              style={{ ...inputStyle(false), paddingRight: 40, marginBottom: 0 }}
              disabled={!!archisyncCode}
            />
            <button
              type="button"
              onClick={() => setArchisyncShowPassword(v => !v)}
              style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#9a9088", fontSize: 13, padding: 0, lineHeight: 1 }}>
              {archisyncShowPassword ? "Hide" : "Show"}
            </button>
          </div>
          <p style={{ fontSize: 11, color: "#9a9088", marginTop: 6, marginBottom: 20 }}>
            The ArchiSync user will need this password when they paste the code.
          </p>

          {archisyncCode ? (
            <div>
              <p style={{ fontSize: 10, fontWeight: 600, color: "#9a9088", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>
                Encrypted Connection Code
              </p>
              <div style={{
                background: "#f5f3f0",
                border: "1px solid #e0dbd4",
                padding: "12px 16px",
                fontFamily: "monospace",
                fontSize: 11,
                color: DESIGN_SHELL,
                wordBreak: "break-all",
                letterSpacing: "0.02em",
                marginBottom: 10,
                lineHeight: 1.6
              }}>
                {archisyncCode}
              </div>
              <p style={{ fontSize: 11, color: ARC_TERRACOTTA, fontWeight: 600, marginBottom: 14 }}>
                Remember to share the password separately from this code.
              </p>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  onClick={copyArchisyncCode}
                  style={{
                    background: archisyncCopied ? DESIGN_GOLD : DESIGN_SHELL,
                    color: "#fff", border: "none", padding: "9px 20px",
                    fontSize: 11, fontWeight: 600, letterSpacing: "0.06em",
                    textTransform: "uppercase", cursor: "pointer",
                    fontFamily: "Inter, Arial, sans-serif", transition: "background 0.2s"
                  }}>
                  {archisyncCopied ? "✓ Copied" : "Copy Code"}
                </button>
                <button
                  onClick={copyArchisyncPassword}
                  style={{
                    background: archisyncPasswordCopied ? DESIGN_GOLD : "none",
                    color: archisyncPasswordCopied ? "#fff" : DESIGN_SHELL,
                    border: `1px solid ${archisyncPasswordCopied ? DESIGN_GOLD : DESIGN_SHELL}`,
                    padding: "8px 16px", fontSize: 11, fontWeight: 600,
                    letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer",
                    fontFamily: "Inter, Arial, sans-serif", transition: "all 0.2s"
                  }}>
                  {archisyncPasswordCopied ? "✓ Copied" : "Copy Password"}
                </button>
                <button
                  onClick={() => { setArchisyncCode(null); setArchisyncCopied(false); setArchisyncPasswordCopied(false); setArchisyncPassword(""); setArchisyncShowPassword(false); }}
                  style={{ background: "none", color: "#9a9088", border: "1px solid #ddd8d0", padding: "8px 16px", fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", cursor: "pointer", fontFamily: "Inter, Arial, sans-serif" }}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={generateArchisyncCode}
              disabled={archisyncLoading || !archisyncPassword.trim()}
              style={{
                background: DESIGN_SHELL, color: "#fff", border: "none",
                padding: "10px 24px", fontSize: 11, fontWeight: 600,
                letterSpacing: "0.06em", textTransform: "uppercase",
                cursor: (archisyncLoading || !archisyncPassword.trim()) ? "not-allowed" : "pointer",
                opacity: (archisyncLoading || !archisyncPassword.trim()) ? 0.6 : 1,
                display: "flex", alignItems: "center", gap: 8,
                fontFamily: "Inter, Arial, sans-serif"
              }}>
              {archisyncLoading ? <><Spinner size={11} /> Generating…</> : "Generate Connection Code"}
            </button>
          )}
        </div>
      </div>
      </>)}

    </div>
    </>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const labelStyle = {
  fontSize: 11, fontWeight: 600, color: DESIGN_SHELL, display: "block",
  marginBottom: 6, letterSpacing: "0.05em", textTransform: "uppercase",
};

const inputStyle = (hasError) => ({
  width: "100%", border: hasError ? `1px solid ${ARC_TERRACOTTA}` : "1px solid #ccc",
  padding: "10px 12px", fontSize: 13, marginBottom: 14, outline: "none",
  fontFamily: "Inter, Arial, sans-serif", color: DESIGN_SHELL, background: "#fff", boxSizing: "border-box",
});
