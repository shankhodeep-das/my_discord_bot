// ============================================================
//  ALPHABOTICS BACKEND — server.js
//  Stack : Express · Discord OAuth2 · MongoDB · JWT
//  Version: 1.2.0 — Live Log Monitor
// ============================================================

require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const cookieParser = require("cookie-parser");
const mongoose     = require("mongoose");
const axios        = require("axios");
const jwt          = require("jsonwebtoken");

const app = express();

// ─── ENV VALIDATION ──────────────────────────────────────────────────────────
const REQUIRED_ENV = [
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_REDIRECT_URI",
  "MONGODB_URI",
  "JWT_SECRET",
  "FRONTEND_URL",
];
REQUIRED_ENV.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌  Missing env variable: ${key}`);
    process.exit(1);
  }
});

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 5000;
const DISCORD_API    = "https://discord.com/api/v10";
const DISCORD_CDN    = "https://cdn.discordapp.com";
const JWT_EXPIRES    = "7d";
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// ─── BOT REGISTRY ─────────────────────────────────────────────────────────────
const BOTS = {
  "alpha-scrim-manager": {
    id:    process.env.ALPHA_SCRIM_BOT_ID || "YOUR_ALPHA_SCRIM_BOT_ID",
    name:  "Alpha Scrim Manager",
    token: process.env.DISCORD_BOT_TOKEN,
  },
  // Add more bots here later
};

// ─── LIVE LOG SYSTEM ──────────────────────────────────────────────────────────
// Stores last 200 logs in memory
// Streams to browser via Server-Sent Events (SSE)

const logs = [];
const MAX_LOGS = 200;
const sseClients = [];

function log(type, message, extra = null) {
  const entry = {
    id:        Date.now() + Math.random(),
    type,      // success | error | warning | info | request | step
    message,
    extra,
    time:      new Date().toLocaleTimeString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" }),
    timestamp: Date.now(),
  };

  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.pop();

  // Also log to Render console
  const icons = { success:"✅", error:"❌", warning:"⚠️ ", info:"ℹ️ ", request:"📥", step:"🔄" };
  console.log(`${icons[type]||"•"} ${message}${extra ? " | "+JSON.stringify(extra) : ""}`);

  // Stream to all connected SSE clients
  const data = JSON.stringify(entry);
  sseClients.forEach(client => {
    try { client.write(`data: ${data}\n\n`); }
    catch { /* client disconnected */ }
  });
}

// Log server start
log("info", "Alphabotics API starting up...");

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Request logger middleware
app.use((req, res, next) => {
  // Skip SSE and static routes from logging
  if (req.path === "/logs/stream" || req.path === "/") {
    return next();
  }
  log("request", `${req.method} ${req.path}`, {
    ip: req.ip,
    query: Object.keys(req.query).length ? req.query : undefined,
  });
  next();
});

// ─── MONGODB CONNECTION ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => log("success", "MongoDB connected successfully"))
  .catch((err) => {
    log("error", "MongoDB connection failed", { error: err.message });
    process.exit(1);
  });

// ─── SCHEMAS & MODELS ─────────────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  discordId:     { type: String, required: true, unique: true },
  username:      { type: String, required: true },
  discriminator: { type: String, default: "0" },
  avatar:        { type: String, default: null },
  email:         { type: String, default: null },
  accessToken:   { type: String },
  refreshToken:  { type: String },
  createdAt:     { type: Date, default: Date.now },
  lastLogin:     { type: Date, default: Date.now },
});
const User = mongoose.model("User", UserSchema);

const GuildSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  guildId:    { type: String, required: true },
  name:       { type: String, required: true },
  icon:       { type: String, default: null },
  isOwner:    { type: Boolean, default: false },
  botPresent: { type: Boolean, default: false },
  updatedAt:  { type: Date, default: Date.now },
});
GuildSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const Guild = mongoose.model("Guild", GuildSchema);

const BotSessionSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  botId:     { type: String, required: true },
  guildId:   { type: String, required: true },
  guildName: { type: String },
  startedAt: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now },
});
const BotSession = mongoose.model("BotSession", BotSessionSchema);

const ActivityLogSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  guildId:   { type: String, default: null },
  botId:     { type: String, default: null },
  type:      {
    type: String,
    enum: [
      "login","logout","bot_selected","server_selected","bot_invited",
      "command_used","scrim_created","scrim_joined","match_scheduled",
      "role_updated","settings_changed","invite_generated",
    ],
    required: true,
  },
  meta:      { type: mongoose.Schema.Types.Mixed, default: {} },
  ip:        { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});
const ActivityLog = mongoose.model("ActivityLog", ActivityLogSchema);

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function logActivity(userId, type, meta = {}, guildId = null, botId = null, ip = null) {
  try {
    await ActivityLog.create({ userId, type, meta, guildId, botId, ip });
  } catch (err) {
    log("error", "Activity log failed", { error: err.message });
  }
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(req) {
  const token = req.cookies?.token || req.headers?.authorization?.replace("Bearer ", "");
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch { return null; }
}

function requireAuth(req, res, next) {
  const payload = verifyToken(req);
  if (!payload) {
    log("warning", "Unauthorized request rejected", { path: req.path });
    return res.status(401).json({ error: "Unauthorized — please login again" });
  }
  req.user = payload;
  next();
}

function guildIconUrl(guildId, icon) {
  if (!icon) return null;
  return `${DISCORD_CDN}/icons/${guildId}/${icon}.png`;
}

async function exchangeCode(code) {
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    client_secret: process.env.DISCORD_CLIENT_SECRET,
    grant_type:    "authorization_code",
    code,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
  });
  const res = await axios.post(`${DISCORD_API}/oauth2/token`, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return res.data;
}

async function fetchDiscordUser(accessToken) {
  const res = await axios.get(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data;
}

async function fetchDiscordGuilds(accessToken) {
  const res = await axios.get(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data;
}

async function checkBotInGuild(botToken, guildId) {
  try {
    await axios.get(`${DISCORD_API}/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    return true;
  } catch (err) {
    if (err.response?.status === 403 || err.response?.status === 404) return false;
    throw err;
  }
}

// ─── BOT INFO SMART CACHE ─────────────────────────────────────────────────────
const botInfoCache = {};

async function loadBotInfo(botId = null) {
  const botsToLoad = botId ? { [botId]: BOTS[botId] } : BOTS;
  for (const [id, bot] of Object.entries(botsToLoad)) {
    if (!bot || !bot.token) {
      log("error", `No token for bot: ${id}`);
      continue;
    }
    try {
      log("step", `Loading bot info for: ${id}`);
      const response = await axios.get(`${DISCORD_API}/users/@me`, {
        headers: { Authorization: `Bot ${bot.token}` },
      });
      const botData = response.data;
      botInfoCache[id] = {
        id:       botData.id,
        name:     botData.username,
        avatar:   botData.avatar
          ? `${DISCORD_CDN}/avatars/${botData.id}/${botData.avatar}.png?size=256`
          : null,
        cachedAt: Date.now(),
      };
      log("success", `Bot info loaded: ${botData.username}`);
    } catch (err) {
      log("error", `Failed to load bot info for ${id}`, {
        status: err.response?.status,
        error:  err.response?.data?.message || err.message,
      });
      if (botInfoCache[id]) log("warning", `Using cached data for ${id}`);
    }
  }
}

loadBotInfo();
setInterval(() => {
  log("info", "Auto-refreshing bot info cache (24h interval)");
  loadBotInfo();
}, 24 * 60 * 60 * 1000);

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// ── LIVE LOG MONITOR PAGE ─────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Alphabotics — Live Monitor</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#06061A;color:#fff;font-family:'Plus Jakarta Sans',sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-thumb{background:#6C63FF;border-radius:2px}
  @keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
  @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:0}}

  /* Header */
  .header{background:rgba(8,8,28,.98);border-bottom:1px solid rgba(255,255,255,.07);padding:12px 24px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
  .brand{display:flex;align-items:center;gap:10px}
  .brand-icon{width:32px;height:32px;border-radius:9px;background:linear-gradient(135deg,#6C63FF,#00D4FF);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900}
  .brand-name{font-size:16px;font-weight:800;letter-spacing:-.3px}
  .brand-sub{font-size:10px;color:rgba(255,255,255,.3);margin-top:1px}
  .status-pill{display:flex;align-items:center;gap:6px;padding:5px 13px;border-radius:999px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);font-size:12px;font-weight:600;color:#10B981}
  .dot{width:7px;height:7px;border-radius:50%;background:#10B981;animation:pulse 2s ease infinite;flex-shrink:0}
  .dot.red{background:#EF4444;animation:blink 1s ease infinite}
  .header-right{display:flex;align-items:center;gap:10px}
  .btn{padding:6px 14px;border-radius:8px;border:1px solid rgba(108,99,255,.3);background:rgba(108,99,255,.1);color:#a78bfa;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;transition:all .2s}
  .btn:hover{background:rgba(108,99,255,.2)}
  .btn.danger{border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.08);color:#f87171}
  .btn.danger:hover{background:rgba(239,68,68,.15)}

  /* Stats bar */
  .stats-bar{display:flex;gap:0;background:rgba(255,255,255,.02);border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .stat-item{flex:1;padding:10px 18px;border-right:1px solid rgba(255,255,255,.05);text-align:center}
  .stat-item:last-child{border-right:none}
  .stat-val{font-size:20px;font-weight:800;font-family:'JetBrains Mono',monospace}
  .stat-label{font-size:10px;color:rgba(255,255,255,.35);margin-top:2px;text-transform:uppercase;letter-spacing:1px}

  /* Main layout */
  .main{display:flex;flex:1;overflow:hidden}

  /* Sidebar */
  .sidebar{width:220px;border-right:1px solid rgba(255,255,255,.07);background:rgba(8,8,24,.6);display:flex;flex-direction:column;flex-shrink:0}
  .sidebar-title{font-size:10px;font-weight:700;color:rgba(255,255,255,.25);letter-spacing:1.5px;padding:14px 16px 8px;text-transform:uppercase}
  .env-list{padding:0 10px;flex:1;overflow-y:auto}
  .env-row{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:8px;margin-bottom:3px;font-family:'JetBrains Mono',monospace;font-size:11px}
  .env-key{color:rgba(255,255,255,.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
  .env-val-set{color:#10B981;font-weight:700;flex-shrink:0;margin-left:6px}
  .env-val-miss{color:#EF4444;font-weight:700;flex-shrink:0;margin-left:6px}
  .sidebar-section{padding:10px;border-top:1px solid rgba(255,255,255,.06)}
  .conn-item{padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);margin-bottom:6px}
  .conn-label{font-size:9px;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:1px;margin-bottom:3px}
  .conn-val{font-size:10px;font-family:'JetBrains Mono',monospace;color:#00D4FF;word-break:break-all}

  /* Log area */
  .log-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
  .log-toolbar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,.06);flex-shrink:0}
  .log-title{font-size:13px;font-weight:700;flex:1}
  .filter-btn{padding:4px 12px;border-radius:6px;border:1px solid rgba(255,255,255,.1);background:transparent;color:rgba(255,255,255,.45);cursor:pointer;font-size:11px;font-family:inherit;font-weight:600;transition:all .15s}
  .filter-btn.active{background:rgba(108,99,255,.2);border-color:rgba(108,99,255,.4);color:#a78bfa}
  .live-badge{display:flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);font-size:11px;color:#10B981;font-weight:600}
  .logs{flex:1;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:4px}

  /* Log entries */
  .log-entry{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;border-radius:9px;border:1px solid transparent;animation:fadeIn .25s ease both;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.5}
  .log-entry.success{background:rgba(16,185,129,.05);border-color:rgba(16,185,129,.15)}
  .log-entry.error  {background:rgba(239,68,68,.06);border-color:rgba(239,68,68,.2)}
  .log-entry.warning{background:rgba(245,158,11,.05);border-color:rgba(245,158,11,.15)}
  .log-entry.info   {background:rgba(108,99,255,.05);border-color:rgba(108,99,255,.15)}
  .log-entry.request{background:rgba(56,189,248,.05);border-color:rgba(56,189,248,.15)}
  .log-entry.step   {background:rgba(167,139,250,.05);border-color:rgba(167,139,250,.12)}
  .log-icon{font-size:14px;flex-shrink:0;margin-top:1px;width:18px;text-align:center}
  .log-body{flex:1;min-width:0}
  .log-msg{color:rgba(255,255,255,.85);word-break:break-word}
  .log-extra{font-size:10px;color:rgba(255,255,255,.35);margin-top:3px;word-break:break-all}
  .log-time{font-size:10px;color:rgba(255,255,255,.25);flex-shrink:0;white-space:nowrap;margin-top:2px}
  .log-type-badge{font-size:9px;font-weight:700;padding:1px 6px;border-radius:4px;text-transform:uppercase;flex-shrink:0;margin-top:2px}
  .badge-success{background:rgba(16,185,129,.15);color:#10B981}
  .badge-error  {background:rgba(239,68,68,.15);color:#EF4444}
  .badge-warning{background:rgba(245,158,11,.15);color:#F59E0B}
  .badge-info   {background:rgba(108,99,255,.15);color:#a78bfa}
  .badge-request{background:rgba(56,189,248,.15);color:#38BDF8}
  .badge-step   {background:rgba(167,139,250,.15);color:#C4B5FD}

  /* Empty state */
  .empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:rgba(255,255,255,.2);gap:10px}
  .empty-icon{font-size:40px;opacity:.3}

  /* Connecting indicator */
  .connecting{display:flex;align-items:center;gap:8px;font-size:12px;color:rgba(255,255,255,.4)}
  .spinner{width:12px;height:12px;border:2px solid rgba(255,255,255,.1);border-top-color:#6C63FF;border-radius:50%;animation:spin .6s linear infinite}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="brand">
    <div class="brand-icon">α</div>
    <div>
      <div class="brand-name">Alphabotics API</div>
      <div class="brand-sub">Live Request Monitor · v1.2.0</div>
    </div>
  </div>
  <div class="header-right">
    <div class="connecting" id="conn-status">
      <div class="spinner"></div>
      <span>Connecting...</span>
    </div>
    <button class="btn" onclick="togglePause()" id="pause-btn">⏸ Pause</button>
    <button class="btn danger" onclick="clearLogs()">🗑 Clear</button>
    <button class="btn" onclick="location.reload()">↻ Refresh</button>
    <div class="status-pill" id="status-pill">
      <div class="dot"></div>
      <span id="status-text">Connecting...</span>
    </div>
  </div>
</div>

<!-- Stats bar -->
<div class="stats-bar">
  <div class="stat-item">
    <div class="stat-val" id="total-count" style="color:#6C63FF">0</div>
    <div class="stat-label">Total Logs</div>
  </div>
  <div class="stat-item">
    <div class="stat-val" id="success-count" style="color:#10B981">0</div>
    <div class="stat-label">Success</div>
  </div>
  <div class="stat-item">
    <div class="stat-val" id="error-count" style="color:#EF4444">0</div>
    <div class="stat-label">Errors</div>
  </div>
  <div class="stat-item">
    <div class="stat-val" id="request-count" style="color:#38BDF8">0</div>
    <div class="stat-label">Requests</div>
  </div>
  <div class="stat-item">
    <div class="stat-val" id="uptime" style="color:#A78BFA">0s</div>
    <div class="stat-label">Uptime</div>
  </div>
</div>

<!-- Main -->
<div class="main">

  <!-- Sidebar -->
  <div class="sidebar">
    <div class="sidebar-title">Environment</div>
    <div class="env-list">
      ${[
        "DISCORD_CLIENT_ID",
        "DISCORD_CLIENT_SECRET",
        "DISCORD_BOT_TOKEN",
        "DISCORD_REDIRECT_URI",
        "MONGODB_URI",
        "JWT_SECRET",
        "FRONTEND_URL",
        "ALPHA_SCRIM_BOT_ID",
        "REFRESH_SECRET",
      ].map(k =>
        '<div class="env-row">' +
        '<span class="env-key" title="' + k + '">' + k.replace("DISCORD_","D_").replace("MONGODB_","MDB_").replace("ALPHA_SCRIM_","AS_") + '</span>' +
        (process.env[k]
          ? '<span class="env-val-set">✓</span>'
          : '<span class="env-val-miss">✗</span>') +
        '</div>'
      ).join("")}
    </div>
    <div class="sidebar-section">
      <div class="conn-item">
        <div class="conn-label">Frontend</div>
        <div class="conn-val">${process.env.FRONTEND_URL || "Not set"}</div>
      </div>
      <div class="conn-item">
        <div class="conn-label">Redirect URI</div>
        <div class="conn-val">${process.env.DISCORD_REDIRECT_URI || "Not set"}</div>
      </div>
      <div class="conn-item">
        <div class="conn-label">Server Time (IST)</div>
        <div class="conn-val" style="color:#A78BFA" id="server-time">${new Date().toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})}</div>
      </div>
    </div>
  </div>

  <!-- Log area -->
  <div class="log-area">
    <div class="log-toolbar">
      <span class="log-title">📡 Live Request Logs</span>
      <button class="filter-btn active" onclick="setFilter('all', this)">All</button>
      <button class="filter-btn" onclick="setFilter('request', this)">Requests</button>
      <button class="filter-btn" onclick="setFilter('error', this)">Errors</button>
      <button class="filter-btn" onclick="setFilter('success', this)">Success</button>
      <button class="filter-btn" onclick="setFilter('step', this)">Steps</button>
      <div class="live-badge" id="live-badge">
        <div class="dot"></div> LIVE
      </div>
    </div>
    <div class="logs" id="logs">
      <div class="empty">
        <div class="empty-icon">📡</div>
        <div>Waiting for requests...</div>
        <div style="font-size:11px">Try logging in from the frontend</div>
      </div>
    </div>
  </div>

</div>

<script>
  const icons = {
    success: "✅", error: "❌", warning: "⚠️",
    info: "ℹ️", request: "📥", step: "🔄"
  };

  let allLogs = [];
  let currentFilter = "all";
  let paused = false;
  let counts = { total:0, success:0, error:0, request:0 };
  let startTime = Date.now();

  // Update uptime
  setInterval(() => {
    const s = Math.floor((Date.now()-startTime)/1000);
    const m = Math.floor(s/60);
    const h = Math.floor(m/60);
    document.getElementById("uptime").textContent =
      h > 0 ? h+"h "+m%60+"m" : m > 0 ? m+"m "+s%60+"s" : s+"s";
    document.getElementById("server-time").textContent =
      new Date().toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"});
  }, 1000);

  function setFilter(f, btn) {
    currentFilter = f;
    document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderLogs();
  }

  function togglePause() {
    paused = !paused;
    const btn = document.getElementById("pause-btn");
    btn.textContent = paused ? "▶ Resume" : "⏸ Pause";
    btn.style.background = paused ? "rgba(245,158,11,.15)" : "";
    btn.style.color = paused ? "#F59E0B" : "";
    document.getElementById("live-badge").style.opacity = paused ? ".4" : "1";
  }

  function clearLogs() {
    allLogs = [];
    counts = { total:0, success:0, error:0, request:0 };
    updateCounts();
    renderLogs();
  }

  function updateCounts() {
    document.getElementById("total-count").textContent   = counts.total;
    document.getElementById("success-count").textContent = counts.success;
    document.getElementById("error-count").textContent   = counts.error;
    document.getElementById("request-count").textContent = counts.request;
  }

  function renderLogs() {
    const container = document.getElementById("logs");
    const filtered = currentFilter === "all"
      ? allLogs
      : allLogs.filter(l => l.type === currentFilter);

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">📡</div><div>No logs yet</div><div style="font-size:11px">Try logging in from the frontend</div></div>';
      return;
    }

    container.innerHTML = filtered.map(entry =>
      '<div class="log-entry ' + entry.type + '">' +
        '<span class="log-icon">' + (icons[entry.type]||"•") + '</span>' +
        '<div class="log-body">' +
          '<div class="log-msg">' + entry.message + '</div>' +
          (entry.extra ? '<div class="log-extra">' + JSON.stringify(entry.extra) + '</div>' : "") +
        '</div>' +
        '<span class="log-type-badge badge-' + entry.type + '">' + entry.type + '</span>' +
        '<span class="log-time">' + entry.time + '</span>' +
      '</div>'
    ).join("");
  }

  function addEntry(entry) {
    allLogs.unshift(entry);
    if (allLogs.length > 200) allLogs.pop();
    counts.total++;
    if (entry.type === "success")  counts.success++;
    if (entry.type === "error")    counts.error++;
    if (entry.type === "request")  counts.request++;
    updateCounts();
    if (!paused) renderLogs();
  }

  // Connect to SSE stream
  function connectSSE() {
    const evtSource = new EventSource("/logs/stream");

    evtSource.onopen = () => {
      document.getElementById("conn-status").innerHTML = '<div class="dot" style="width:8px;height:8px;border-radius:50%;background:#10B981;animation:pulse 2s ease infinite;flex-shrink:0"></div><span style="color:#10B981;font-size:12px">Connected</span>';
      document.getElementById("status-text").textContent = "Live";
    };

    evtSource.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data);
        addEntry(entry);
      } catch {}
    };

    evtSource.onerror = () => {
      document.getElementById("conn-status").innerHTML = '<div style="width:8px;height:8px;border-radius:50%;background:#EF4444;flex-shrink:0"></div><span style="color:#EF4444;font-size:12px">Reconnecting...</span>';
      document.getElementById("status-text").textContent = "Reconnecting...";
      setTimeout(connectSSE, 3000);
      evtSource.close();
    };
  }

  // Load existing logs first
  fetch("/logs/recent")
    .then(r => r.json())
    .then(data => {
      if (data.logs) {
        data.logs.reverse().forEach(addEntry);
      }
      connectSSE();
    })
    .catch(() => connectSSE());
</script>
</body>
</html>`);
});

// ── SSE: Stream live logs to browser ─────────────────────────────────────────
app.get("/logs/stream", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  // Send heartbeat every 25 seconds to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write(": heartbeat\n\n"); }
    catch { clearInterval(heartbeat); }
  }, 25000);

  sseClients.push(res);
  log("info", `Monitor connected (${sseClients.length} viewer${sseClients.length>1?"s":""} watching)`);

  req.on("close", () => {
    clearInterval(heartbeat);
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

// ── GET: Recent logs (last 100) ───────────────────────────────────────────────
app.get("/logs/recent", (req, res) => {
  res.json({ logs: logs.slice(0, 100) });
});

// ── AUTH: Redirect to Discord OAuth2 ─────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  const { bot } = req.query;
  log("info", `OAuth2 login initiated`, { bot: bot || "none" });

  const state = bot ? Buffer.from(JSON.stringify({ bot })).toString("base64") : "";
  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope:         "identify guilds email",
    state,
  });

  log("step", `Redirecting to Discord OAuth2`);
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── AUTH: Discord OAuth2 Callback ────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  log("request", "OAuth2 callback received from Discord");

  if (error) {
    log("error", `Discord returned error: ${error}`);
    return res.redirect(`${process.env.FRONTEND_URL}?error=access_denied`);
  }

  if (!code) {
    log("error", "No authorization code received from Discord");
    return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  }

  log("success", "Authorization code received from Discord");

  try {
    // Step 1 — Exchange code
    log("step", "Step 1: Exchanging code for Discord token...");
    const tokens = await exchangeCode(code);
    log("success", "Step 1: Discord token received successfully");

    // Step 2 — Fetch user
    log("step", "Step 2: Fetching user profile from Discord...");
    const discordUser = await fetchDiscordUser(tokens.access_token);
    log("success", `Step 2: User profile fetched → ${discordUser.username}#${discordUser.discriminator}`);

    // Step 3 — Save to MongoDB
    log("step", "Step 3: Saving user to MongoDB...");
    await User.findOneAndUpdate(
      { discordId: discordUser.id },
      {
        discordId:     discordUser.id,
        username:      discordUser.username,
        discriminator: discordUser.discriminator || "0",
        avatar:        discordUser.avatar,
        email:         discordUser.email || null,
        accessToken:   tokens.access_token,
        refreshToken:  tokens.refresh_token,
        lastLogin:     new Date(),
      },
      { upsert: true, new: true }
    );
    log("success", "Step 3: User saved to MongoDB");

    // Step 4 — Log activity
    log("step", "Step 4: Logging activity...");
    await logActivity(
      discordUser.id, "login",
      { username: discordUser.username, source: "discord_oauth" },
      null, null, req.ip
    );
    log("success", "Step 4: Activity logged");

    // Step 5 — Decode state
    log("step", "Step 5: Decoding state parameter...");
    let botId = null;
    if (state) {
      try {
        const decoded = JSON.parse(Buffer.from(state, "base64").toString());
        botId = decoded.bot || null;
        log("success", `Step 5: Bot ID decoded → ${botId}`);
      } catch {
        log("warning", "Step 5: Could not decode state parameter");
      }
    }

    // Step 6 — Create JWT
    log("step", "Step 6: Creating JWT token...");
    const token = signToken({
      userId:        discordUser.id,
      username:      discordUser.username,
      discriminator: discordUser.discriminator || "0",
      avatar:        discordUser.avatar,
    });
    log("success", "Step 6: JWT token created");

    // Step 7 — Set cookie
    log("step", "Step 7: Setting HTTP-only cookie...");
    res.cookie("token", token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge:   COOKIE_MAX_AGE,
    });
    log("success", "Step 7: Cookie set successfully");

    // Step 8 — Redirect
    const redirectUrl = botId
      ? `${process.env.FRONTEND_URL}?bot=${botId}`
      : process.env.FRONTEND_URL;

    log("success", `🎉 OAuth2 LOGIN SUCCESS! Redirecting → ${redirectUrl}`);
    res.redirect(redirectUrl);

  } catch (err) {
    const status  = err.response?.status;
    const errData = err.response?.data;
    log("error", `OAuth2 FAILED!`, {
      status,
      error:   errData?.error || err.message,
      details: errData?.error_description || errData?.message || null,
    });
    res.redirect(`${process.env.FRONTEND_URL}?error=oauth_failed`);
  }
});

// ── AUTH: Get current user ────────────────────────────────────────────────────
app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.userId }).select("-accessToken -refreshToken");
    if (!user) {
      log("warning", "User not found in database", { userId: req.user.userId });
      return res.status(404).json({ error: "User not found" });
    }
    const avatarUrl = user.avatar
      ? `${DISCORD_CDN}/avatars/${user.discordId}/${user.avatar}.png`
      : `${DISCORD_CDN}/embed/avatars/0.png`;

    log("success", `User profile returned → ${user.username}`);
    res.json({
      id:            user.discordId,
      username:      user.username,
      discriminator: user.discriminator,
      avatar:        avatarUrl,
      email:         user.email,
      createdAt:     user.createdAt,
      lastLogin:     user.lastLogin,
    });
  } catch (err) {
    log("error", "Failed to fetch user profile", { error: err.message });
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ── AUTH: Logout ──────────────────────────────────────────────────────────────
app.post("/auth/logout", requireAuth, async (req, res) => {
  log("info", `User logged out`, { userId: req.user.userId });
  await logActivity(req.user.userId, "logout", {}, null, null, req.ip);
  res.clearCookie("token");
  res.json({ success: true, message: "Logged out successfully" });
});

// ── GUILDS: Get user's servers ────────────────────────────────────────────────
app.get("/guilds", requireAuth, async (req, res) => {
  try {
    log("step", `Fetching guilds for user: ${req.user.username}`);
    const user = await User.findOne({ discordId: req.user.userId });
    if (!user) return res.status(404).json({ error: "User not found" });

    const discordGuilds    = await fetchDiscordGuilds(user.accessToken);
    const manageableGuilds = discordGuilds.filter(
      (g) => (parseInt(g.permissions) & 0x20) !== 0 || g.owner
    );

    log("success", `Found ${manageableGuilds.length} manageable guilds`);

    const guildDocs = await Promise.all(
      manageableGuilds.map((g) =>
        Guild.findOneAndUpdate(
          { userId: req.user.userId, guildId: g.id },
          { userId: req.user.userId, guildId: g.id, name: g.name, icon: g.icon, isOwner: g.owner || false, updatedAt: new Date() },
          { upsert: true, new: true }
        )
      )
    );

    res.json({
      guilds: guildDocs.map((g) => ({
        id: g.guildId, name: g.name,
        icon: guildIconUrl(g.guildId, g.icon), isOwner: g.isOwner,
      })),
    });

  } catch (err) {
    log("error", "Failed to fetch guilds", {
      status: err.response?.status,
      error:  err.message,
    });
    if (err.response?.status === 401) {
      return res.status(401).json({ error: "Discord session expired — please login again" });
    }
    res.status(500).json({ error: "Failed to fetch servers" });
  }
});

// ── BOTS: Get bot info from cache ─────────────────────────────────────────────
app.get("/bots/:botId/info", (req, res) => {
  const info = botInfoCache[req.params.botId];
  if (!info) {
    log("warning", `Bot info not cached yet for: ${req.params.botId}`);
    return res.status(404).json({ error: "Bot info not loaded yet — try again in a moment" });
  }
  res.json(info);
});

// ── BOTS: Manual refresh ──────────────────────────────────────────────────────
app.get("/bots/:botId/refresh", async (req, res) => {
  if (req.query.secret !== process.env.REFRESH_SECRET) {
    log("warning", "Unauthorized refresh attempt");
    return res.status(401).json({ error: "Unauthorized — wrong secret" });
  }
  log("info", `Manual bot info refresh triggered for: ${req.params.botId}`);
  await loadBotInfo(req.params.botId);
  res.json({ success: true, message: "Bot info refreshed!", data: botInfoCache[req.params.botId] || null });
});

// ── BOTS: Check if bot is in server ──────────────────────────────────────────
app.get("/bots/:botId/check/:guildId", requireAuth, async (req, res) => {
  const { botId, guildId } = req.params;
  const bot = BOTS[botId];
  if (!bot) return res.status(404).json({ error: `Bot "${botId}" not found` });

  try {
    log("step", `Checking if ${botId} is in guild ${guildId}`);
    const present = await checkBotInGuild(bot.token, guildId);
    log(present ? "success" : "warning",
      present ? `Bot IS in guild ${guildId}` : `Bot NOT in guild ${guildId}`
    );

    await Guild.findOneAndUpdate(
      { userId: req.user.userId, guildId },
      { botPresent: present, updatedAt: new Date() }
    );

    await logActivity(req.user.userId, "server_selected", { botId, guildId, botPresent: present }, guildId, botId, req.ip);

    if (present) {
      await BotSession.findOneAndUpdate(
        { userId: req.user.userId, botId, guildId },
        { lastSeen: new Date(), guildName: req.query.guildName || "" },
        { upsert: true, new: true }
      );
      await logActivity(req.user.userId, "bot_selected", { botId, botName: bot.name }, guildId, botId, req.ip);
    }

    res.json({
      present, botId, botName: bot.name, guildId,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${bot.id}&permissions=8&scope=bot+applications.commands`,
    });

  } catch (err) {
    log("error", "Bot guild check failed", { error: err.message });
    res.status(500).json({ error: "Failed to check bot status" });
  }
});

// ── BOTS: Get all bots ────────────────────────────────────────────────────────
app.get("/bots", (req, res) => {
  res.json({
    bots: Object.entries(BOTS).map(([id, b]) => ({
      id, name: b.name,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${b.id}&permissions=8&scope=bot+applications.commands`,
    })),
  });
});

// ── BOTS: Invite link ─────────────────────────────────────────────────────────
app.get("/bots/:botId/invite", requireAuth, async (req, res) => {
  const bot = BOTS[req.params.botId];
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  await logActivity(req.user.userId, "invite_generated", { botId: req.params.botId }, req.query.guildId||null, req.params.botId, req.ip);
  log("info", `Invite link generated for ${req.params.botId}`);
  res.json({ inviteUrl: `https://discord.com/oauth2/authorize?client_id=${bot.id}&permissions=8&scope=bot+applications.commands` });
});

// ── DASHBOARD: Stats ──────────────────────────────────────────────────────────
app.get("/dashboard/:botId/:guildId/stats", requireAuth, async (req, res) => {
  const { botId, guildId } = req.params;
  if (!BOTS[botId]) return res.status(404).json({ error: "Bot not found" });
  try {
    const totalCommands  = await ActivityLog.countDocuments({ guildId, botId });
    const todayStart     = new Date(); todayStart.setHours(0,0,0,0);
    const commandsToday  = await ActivityLog.countDocuments({ guildId, botId, createdAt: { $gte: todayStart } });
    const activeSessions = await BotSession.countDocuments({ botId, guildId });
    res.json({ totalCommands, commandsToday, activeSessions, botId, guildId });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── ACTIVITY: Get logs ────────────────────────────────────────────────────────
app.get("/activity/:guildId", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const dbLogs = await ActivityLog.find({ guildId: req.params.guildId })
      .sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ activity: dbLogs });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

// ── ACTIVITY: Log event from frontend ────────────────────────────────────────
app.post("/activity/log", requireAuth, async (req, res) => {
  const { type, guildId, botId, meta } = req.body;
  const allowed = ["command_used","scrim_created","scrim_joined","match_scheduled","role_updated","settings_changed"];
  if (!allowed.includes(type)) return res.status(400).json({ error: "Invalid activity type" });
  await logActivity(req.user.userId, type, meta||{}, guildId, botId, req.ip);
  res.json({ success: true });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────
app.get("/settings/:botId/:guildId", requireAuth, async (req, res) => {
  res.json({
    botId: req.params.botId, guildId: req.params.guildId,
    settings: { prefix:"/", welcomeMessage:"Welcome {user}! 🎉", logChannel:null, autoAnnounce:true, dmOnScrimInvite:true },
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  log("warning", `404 — Route not found: ${req.method} ${req.path}`);
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  log("error", "Unhandled server error", { error: err.message });
  res.status(500).json({ error: "Internal server error" });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log("success", `Alphabotics API running on port ${PORT} in ${process.env.NODE_ENV||"development"} mode`);
  log("info", `Monitor dashboard: http://localhost:${PORT}`);
  log("info", `Registered bots: ${Object.keys(BOTS).join(", ")}`);
});
