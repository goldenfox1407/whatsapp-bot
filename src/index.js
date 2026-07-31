import express from "express";
import cors from "cors";
import {
  state,
  sendMessage,
  sendMediaFromUrl,
  reinitialize,
  logout,
  initializeWhatsApp,
} from "./whatsapp-client.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// ─── Root Redirect to WhatsApp Manager ────────────────────────────
app.get("/", (_req, res) => {
  res.redirect("/api/whatsapp");
});

// ─── Health Check (used by keep-alive & Render) ──────────────────
app.get("/api/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    whatsapp: state.clientStatus,
    uptime: process.uptime(),
    memoryMB: Math.round(mem.rss / 1024 / 1024),
    engine: "baileys",
  });
});

// ─── WhatsApp Status ─────────────────────────────────────────────
app.get("/api/whatsapp/status", (_req, res) => {
  res.json({ status: state.isReady ? "connected" : "disconnected" });
});

// ─── QR Code (for UI) ────────────────────────────────────────────
app.get("/api/whatsapp/qr", (_req, res) => {
  res.json({
    status: state.clientStatus,
    qr: state.currentQr,
  });
});

// ─── Reinitialize WhatsApp ───────────────────────────────────────
app.post("/api/whatsapp/reinit", async (_req, res) => {
  try {
    reinitialize();
    res.json({ success: true, message: "WhatsApp client restarting" });
  } catch (err) {
    res.status(500).json({ error: "Failed to reinitialize", details: err.message });
  }
});

// ─── Send Message (called by Laravel) ────────────────────────────
app.post("/api/whatsapp/send", async (req, res) => {
  if (!state.isReady) {
    return res.status(503).json({ error: "WhatsApp Client is not ready" });
  }

  const { number, message, mediaUrl } = req.body;

  if (!number || !message) {
    return res.status(400).json({ error: "Number and message are required" });
  }

  try {
    // Format: 212660581249 → 212660581249@s.whatsapp.net
    let jid = number.replace("+", "");
    if (!jid.includes("@")) {
      jid = `${jid}@s.whatsapp.net`;
    }

    if (mediaUrl) {
      await sendMediaFromUrl(jid, message, mediaUrl);
    } else {
      await sendMessage(jid, message);
    }

    res.json({ success: true, message: "Message sent successfully" });
  } catch (err) {
    console.error("Error sending message:", err.message);
    res.status(500).json({ error: "Failed to send message", details: err.message });
  }
});

// ─── Logout ──────────────────────────────────────────────────────
app.post("/api/whatsapp/logout", async (_req, res) => {
  try {
    await logout();
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to logout", details: err.message });
  }
});

// ─── Kill Process ────────────────────────────────────────────────
app.post("/api/whatsapp/kill", (_req, res) => {
  res.json({ success: true, message: "Process terminating" });
  setTimeout(() => process.exit(0), 500);
});

// ─── Backward Compatibility Routes (Laravel WhatsAppManagerController) ─
// Laravel calls root URLs: {nodeUrl}/qr, {nodeUrl}/status, {nodeUrl}/reinit, {nodeUrl}/logout, {nodeUrl}/kill
app.get("/qr", (_req, res) => {
  res.json({
    status: state.clientStatus,
    qr: state.currentQr,
  });
});

app.get("/status", (_req, res) => {
  res.json({ status: state.isReady ? "connected" : "disconnected" });
});

app.post("/reinit", async (_req, res) => {
  try {
    reinitialize();
    res.json({ success: true, message: "WhatsApp client restarting" });
  } catch (err) {
    res.status(500).json({ error: "Failed to reinitialize", details: err.message });
  }
});

app.post("/logout", async (_req, res) => {
  try {
    await logout();
    res.json({ success: true, message: "Logged out successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to logout", details: err.message });
  }
});

app.post("/kill", (_req, res) => {
  res.json({ success: true, message: "Process terminating" });
  setTimeout(() => process.exit(0), 500);
});

// ─── WhatsApp Manager UI ─────────────────────────────────────────
app.get("/api/whatsapp", (_req, res) => {
  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>PureMed — WhatsApp Manager (Baileys)</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 440px;
      text-align: center;
      box-shadow: 0 25px 50px rgba(0,0,0,0.4);
    }
    .logo { font-size: 13px; font-weight: 600; color: #64748b; letter-spacing: 0.12em; text-transform: uppercase; margin-bottom: 4px; }
    .engine { font-size: 11px; color: #22c55e; margin-bottom: 8px; }
    h1 { font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 28px; }
    .badge {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 6px 14px; border-radius: 999px;
      font-size: 13px; font-weight: 600; margin-bottom: 28px;
    }
    .badge.connected    { background: #052e16; color: #4ade80; border: 1px solid #16a34a; }
    .badge.waiting_qr   { background: #1c1917; color: #fb923c; border: 1px solid #c2410c; }
    .badge.disconnected { background: #1a0a0a; color: #f87171; border: 1px solid #b91c1c; }
    .badge.starting     { background: #0c1a2e; color: #60a5fa; border: 1px solid #2563eb; }
    .dot { width: 8px; height: 8px; border-radius: 50%; animation: pulse 1.5s infinite; }
    .connected .dot    { background: #4ade80; }
    .waiting_qr .dot   { background: #fb923c; }
    .disconnected .dot { background: #f87171; animation: none; }
    .starting .dot     { background: #60a5fa; }
    @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
    .qr-wrap { background: #fff; border-radius: 12px; padding: 16px; display: inline-block; margin-bottom: 20px; }
    .qr-wrap img { display: block; width: 220px; height: 220px; }
    .hint { font-size: 13px; color: #94a3b8; margin-bottom: 24px; line-height: 1.6; }
    .empty-state { padding: 32px 0; color: #64748b; font-size: 14px; line-height: 1.7; }
    .spinner { width: 40px; height: 40px; border: 3px solid #334155; border-top-color: #60a5fa; border-radius: 50%; animation: spin 0.9s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    .btn { display: inline-block; padding: 10px 22px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: opacity .15s; }
    .btn:hover { opacity: 0.85; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-danger  { background: #7f1d1d; color: #fca5a5; }
    .btn-primary { background: #1e3a5f; color: #93c5fd; border: 1px solid #2563eb; }
    .stats { font-size: 12px; color: #475569; margin-top: 20px; }
    .stats span { color: #22c55e; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">PureMed</div>
    <div class="engine">⚡ Propulsé par Baileys — sans Chrome</div>
    <h1>WhatsApp Manager</h1>
    <div id="content">Chargement…</div>
    <p class="stats">Mise à jour auto toutes les 3s · RAM: <span id="ram">…</span></p>
  </div>

  <script>
    let lastStatus = null;

    async function refresh() {
      try {
        const r = await fetch('/api/whatsapp/qr');
        const data = await r.json();
        if (JSON.stringify(data) !== lastStatus) {
          lastStatus = JSON.stringify(data);
          render(data);
        }
        // Update RAM
        const h = await fetch('/api/health');
        const hd = await h.json();
        document.getElementById('ram').textContent = 
          (hd.memoryMB || '?') + ' MB · Uptime: ' + Math.floor(hd.uptime/60) + 'min';
      } catch(e) {
        document.getElementById('content').innerHTML =
          '<p style="color:#f87171;font-size:14px">Impossible de contacter le serveur.</p>';
      }
    }

    function render({ status, qr }) {
      const labels = {
        connected:    '✅ Connecté',
        waiting_qr:   '📱 En attente du QR',
        disconnected: '❌ Déconnecté',
        starting:     '⏳ Démarrage…',
      };
      const label = labels[status] || status;
      let body = '';

      if (status === 'connected') {
        body = \`
          <div class="badge connected"><span class="dot"></span>\${label}</div>
          <div class="empty-state">WhatsApp est connecté et prêt.<br>✅ Téléchargement d'images: <strong>natif</strong><br>💾 RAM: ~50 Mo (vs ~500 Mo avant)</div>
          <div class="actions">
            <button class="btn btn-danger" onclick="doLogout()">Se déconnecter</button>
          </div>
        \`;
      } else if (status === 'waiting_qr' && qr) {
        body = \`
          <div class="badge waiting_qr"><span class="dot"></span>\${label}</div>
          <div class="qr-wrap"><img src="\${qr}" alt="QR Code WhatsApp" /></div>
          <p class="hint">
            Ouvrez WhatsApp sur votre téléphone →<br>
            <strong>Appareils connectés → Connecter un appareil</strong><br>
            puis scannez ce QR code rapidement.
          </p>
          <div class="actions">
            <button class="btn btn-primary" onclick="reinit(this)">🔄 Nouveau QR code</button>
          </div>
        \`;
      } else if (status === 'waiting_qr') {
        body = \`
          <div class="badge waiting_qr"><span class="dot"></span>\${label}</div>
          <div class="empty-state"><div class="spinner"></div>Génération du QR code en cours…</div>
          <div class="actions">
            <button class="btn btn-primary" onclick="reinit(this)">🔄 Forcer le redémarrage</button>
          </div>
        \`;
      } else if (status === 'disconnected') {
        body = \`
          <div class="badge disconnected"><span class="dot"></span>\${label}</div>
          <div class="empty-state">La session WhatsApp est terminée.<br>Redémarrage automatique en cours…</div>
          <div class="actions">
            <button class="btn btn-primary" onclick="reinit(this)">🔄 Redémarrer maintenant</button>
          </div>
        \`;
      } else {
        body = \`
          <div class="badge starting"><span class="dot"></span>\${label}</div>
          <div class="empty-state"><div class="spinner"></div>Connexion en cours…</div>
        \`;
      }

      document.getElementById('content').innerHTML = body;
    }

    async function reinit(btn) {
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Redémarrage…'; }
      lastStatus = null;
      await fetch('/api/whatsapp/reinit', { method: 'POST' });
      setTimeout(refresh, 2000);
    }

    async function doLogout() {
      if (!confirm('Déconnecter WhatsApp ?')) return;
      await fetch('/api/whatsapp/logout', { method: 'POST' });
      lastStatus = null;
      setTimeout(refresh, 1000);
    }

    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ─── Self Keep-Alive (prevents Render free tier sleep) ───────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/api/health`);
      console.log("[keep-alive] ping OK");
    } catch {}
  }, 10 * 60 * 1000); // every 10 minutes
}

// ─── Start Server ────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`⚡ Engine: Baileys (no Chrome/Puppeteer)`);
  console.log(`📡 Webhook: ${process.env.LARAVEL_WEBHOOK_URL || "https://gestion.puremed.ma/api/whatsapp/webhook"}`);
  initializeWhatsApp();
});
