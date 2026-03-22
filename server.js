// ============================================================
//  ALPHABOTICS BACKEND — server.js
//  Stack : Express · Discord OAuth2 · MongoDB · JWT
//  Author: Alphabotics Platform
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
const PORT             = process.env.PORT || 5000;
const DISCORD_API      = "https://discord.com/api/v10";
const DISCORD_CDN      = "https://cdn.discordapp.com";
const JWT_EXPIRES      = "7d";
const COOKIE_MAX_AGE   = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

// ─── BOT REGISTRY ─────────────────────────────────────────────────────────────
//  Add every new bot here — backend auto-supports it
const BOTS = {
  "alpha-scrim-manager": {
    id:       process.env.ALPHA_SCRIM_BOT_ID || "YOUR_ALPHA_SCRIM_BOT_ID",
    name:     "Alpha Scrim Manager",
    token:    process.env.DISCORD_BOT_TOKEN,   // use separate tokens per bot if needed
  },
  // "server-spy": {
  //   id:    process.env.SERVER_SPY_BOT_ID,
  //   name:  "ServerSpy",
  //   token: process.env.SERVER_SPY_BOT_TOKEN,
  // },
  // Add more bots here later — zero backend changes required
};

console.log("Bot token loaded:", process.env.DISCORD_BOT_TOKEN ? "YES ✅" : "NO ❌");
console.log("Bot ID loaded:", process.env.ALPHA_SCRIM_BOT_ID ? "YES ✅" : "NO ❌");


// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ─── MONGODB CONNECTION ───────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅  MongoDB connected"))
  .catch((err) => { console.error("❌  MongoDB error:", err.message); process.exit(1); });

// ─── SCHEMAS & MODELS ─────────────────────────────────────────────────────────

// User — stores Discord profile
const UserSchema = new mongoose.Schema({
  discordId:     { type: String, required: true, unique: true },
  username:      { type: String, required: true },
  discriminator: { type: String, default: "0" },
  avatar:        { type: String, default: null },
  email:         { type: String, default: null },
  accessToken:   { type: String },   // Discord access token
  refreshToken:  { type: String },   // Discord refresh token
  createdAt:     { type: Date, default: Date.now },
  lastLogin:     { type: Date, default: Date.now },
});
const User = mongoose.model("User", UserSchema);

// Guild — stores server info per user
const GuildSchema = new mongoose.Schema({
  userId:    { type: String, required: true },   // Discord user ID
  guildId:   { type: String, required: true },
  name:      { type: String, required: true },
  icon:      { type: String, default: null },
  isOwner:   { type: Boolean, default: false },
  botPresent:{ type: Boolean, default: false },  // is any Alphabotics bot in this server?
  updatedAt: { type: Date, default: Date.now },
});
GuildSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const Guild = mongoose.model("Guild", GuildSchema);

// BotSession — tracks which bot + server a user is managing
const BotSessionSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  botId:     { type: String, required: true },   // e.g. "alpha-scrim-manager"
  guildId:   { type: String, required: true },
  guildName: { type: String },
  startedAt: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now },
});
const BotSession = mongoose.model("BotSession", BotSessionSchema);


// GET /bots/:botId/info
// Fetches real bot name and avatar from Discord
app.get("/bots/:botId/info", async (req, res) => {
  const bot = BOTS[req.params.botId];
  if (!bot) return res.status(404).json({ error: "Bot not found" });

  try {
    const response = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${bot.token}` },
    });

    const botData = response.data;
    const avatarUrl = botData.avatar
      ? `https://cdn.discordapp.com/avatars/${botData.id}/${botData.avatar}.png?size=256`
      : null;

    res.json({
      id:       botData.id,
      name:     botData.username,
      avatar:   avatarUrl,
      tag:      botData.discriminator,
    });
  } catch (err) {
  console.error("Bot info error full:", err.response?.data || err.message);
  console.error("Bot info status:", err.response?.status);
  res.status(500).json({ 
    error: "Failed to fetch bot info",
    details: err.response?.data || err.message,
    status: err.response?.status
  });
}
});

// ActivityLog — logs every notable action
const ActivityLogSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  guildId:   { type: String, default: null },
  botId:     { type: String, default: null },
  type:      {
    type: String,
    enum: ["login","logout","bot_selected","server_selected","bot_invited",
           "command_used","scrim_created","scrim_joined","match_scheduled",
           "role_updated","settings_changed","invite_generated"],
    required: true,
  },
  meta:      { type: mongoose.Schema.Types.Mixed, default: {} },  // extra details
  ip:        { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});
const ActivityLog = mongoose.model("ActivityLog", ActivityLogSchema);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Log an activity event
async function logActivity(userId, type, meta = {}, guildId = null, botId = null, ip = null) {
  try {
    await ActivityLog.create({ userId, type, meta, guildId, botId, ip });
  } catch (err) {
    console.error("Log error:", err.message);
  }
}

// Generate a signed JWT
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// Verify JWT from cookie or Authorization header
function verifyToken(req) {
  const token =
    req.cookies?.token ||
    req.headers?.authorization?.replace("Bearer ", "");
  if (!token) return null;
  try { return jwt.verify(token, process.env.JWT_SECRET); }
  catch { return null; }
}

// Auth middleware — attach user to request
function requireAuth(req, res, next) {
  const payload = verifyToken(req);
  if (!payload) return res.status(401).json({ error: "Unauthorized — please login again" });
  req.user = payload;
  next();
}

// Get guild icon URL
function guildIconUrl(guildId, icon) {
  if (!icon) return null;
  return `${DISCORD_CDN}/icons/${guildId}/${icon}.png`;
}

// Exchange Discord code for tokens
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
  return res.data; // { access_token, refresh_token, expires_in, token_type }
}

// Fetch Discord user profile
async function fetchDiscordUser(accessToken) {
  const res = await axios.get(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data;
}

// Fetch user's guilds from Discord
async function fetchDiscordGuilds(accessToken) {
  const res = await axios.get(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.data; // array of guild objects
}

// Check if a specific bot is in a guild using the bot token
async function checkBotInGuild(botToken, guildId) {
  try {
    await axios.get(`${DISCORD_API}/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    return true;  // bot is in the guild
  } catch (err) {
    if (err.response?.status === 403 || err.response?.status === 404) return false;
    throw err;
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({
    status:  "ok",
    service: "Alphabotics API",
    version: "1.0.0",
    bots:    Object.keys(BOTS),
  });
});

// ── AUTH: Redirect to Discord OAuth2 ─────────────────────────────────────────
//  GET /auth/login?bot=alpha-scrim-manager
app.get("/auth/login", (req, res) => {
  const { bot } = req.query;
  const state = bot ? Buffer.from(JSON.stringify({ bot })).toString("base64") : "";

  const params = new URLSearchParams({
    client_id:     process.env.DISCORD_CLIENT_ID,
    redirect_uri:  process.env.DISCORD_REDIRECT_URI,
    response_type: "code",
    scope:         "identify guilds email",
    state,
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── AUTH: Discord OAuth2 Callback ────────────────────────────────────────────
//  GET /auth/callback?code=xxx&state=xxx
app.get("/auth/callback", async (req, res) => {
  const { code, state, error } = req.query;

  // User denied OAuth
  if (error) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=access_denied`);
  }

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=no_code`);
  }

  try {
    // 1. Exchange code for Discord tokens
    const tokens = await exchangeCode(code);

    // 2. Fetch Discord user profile
    const discordUser = await fetchDiscordUser(tokens.access_token);

    // 3. Upsert user in MongoDB
    const user = await User.findOneAndUpdate(
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

    // 4. Log login activity
    await logActivity(
      discordUser.id,
      "login",
      { username: discordUser.username, source: "discord_oauth" },
      null, null,
      req.ip
    );

    // 5. Decode state to get selected bot
    let botId = null;
    if (state) {
      try {
        const decoded = JSON.parse(Buffer.from(state, "base64").toString());
        botId = decoded.bot || null;
      } catch { /* ignore bad state */ }
    }

    // 6. Sign JWT
    const token = signToken({
      userId:        discordUser.id,
      username:      discordUser.username,
      discriminator: discordUser.discriminator || "0",
      avatar:        discordUser.avatar,
    });

    // 7. Set HTTP-only cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge:   COOKIE_MAX_AGE,
    });

    // 8. Redirect to frontend with botId if present
    const redirectUrl = botId
      ? `${process.env.FRONTEND_URL}/dashboard?bot=${botId}`
      : `${process.env.FRONTEND_URL}/dashboard`;

    res.redirect(redirectUrl);

  } catch (err) {
    console.error("OAuth callback error:", err.message?.data || err.message);
    console.error("0Auth callback status:", err.response?.status);
    console.error("OAuth callback config:", {
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
    });
    res.redirect(`${process.env.FRONTEND_URL}?error=${err.response?.data?.error || "oauth_failed"}`);
  }
});

// ── AUTH: Get current logged-in user ─────────────────────────────────────────
//  GET /auth/me
app.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.userId }).select("-accessToken -refreshToken");
    if (!user) return res.status(404).json({ error: "User not found" });

    const avatarUrl = user.avatar
      ? `${DISCORD_CDN}/avatars/${user.discordId}/${user.avatar}.png`
      : `${DISCORD_CDN}/embed/avatars/0.png`;

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
    res.status(500).json({ error: "Failed to fetch user" });
  }
});

// ── AUTH: Logout ──────────────────────────────────────────────────────────────
//  POST /auth/logout
app.post("/auth/logout", requireAuth, async (req, res) => {
  await logActivity(req.user.userId, "logout", {}, null, null, req.ip);
  res.clearCookie("token");
  res.json({ success: true, message: "Logged out successfully" });
});

// ── GUILDS: Get user's servers ────────────────────────────────────────────────
//  GET /guilds
app.get("/guilds", requireAuth, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.userId });
    if (!user) return res.status(404).json({ error: "User not found" });

    // Fetch guilds from Discord
    const discordGuilds = await fetchDiscordGuilds(user.accessToken);

    // Filter: only guilds where user has Manage Server (permission bit 32)
    const manageableGuilds = discordGuilds.filter(
      (g) => (parseInt(g.permissions) & 0x20) !== 0 || g.owner
    );

    // Save/update guilds in MongoDB
    const guildDocs = await Promise.all(
      manageableGuilds.map((g) =>
        Guild.findOneAndUpdate(
          { userId: req.user.userId, guildId: g.id },
          {
            userId:     req.user.userId,
            guildId:    g.id,
            name:       g.name,
            icon:       g.icon,
            isOwner:    g.owner || false,
            updatedAt:  new Date(),
          },
          { upsert: true, new: true }
        )
      )
    );

    // Return formatted list
    res.json({
      guilds: guildDocs.map((g) => ({
        id:       g.guildId,
        name:     g.name,
        icon:     guildIconUrl(g.guildId, g.icon),
        isOwner:  g.isOwner,
      })),
    });

  } catch (err) {
    console.error("Guilds error:", err.message);
    if (err.response?.status === 401) {
      return res.status(401).json({ error: "Discord session expired — please login again" });
    }
    res.status(500).json({ error: "Failed to fetch servers" });
  }
});

// ── BOTS: Check if a bot is in a specific server ──────────────────────────────
//  GET /bots/:botId/check/:guildId
app.get("/bots/:botId/check/:guildId", requireAuth, async (req, res) => {
  const { botId, guildId } = req.params;

  // Validate bot exists in registry
  const bot = BOTS[botId];
  if (!bot) return res.status(404).json({ error: `Bot "${botId}" not found in registry` });

  try {
    const present = await checkBotInGuild(bot.token, guildId);

    // Update guild record in MongoDB
    await Guild.findOneAndUpdate(
      { userId: req.user.userId, guildId },
      { botPresent: present, updatedAt: new Date() }
    );

    // Log the check
    await logActivity(
      req.user.userId,
      "server_selected",
      { botId, guildId, botPresent: present },
      guildId,
      botId,
      req.ip
    );

    if (present) {
      // Create or update bot session
      await BotSession.findOneAndUpdate(
        { userId: req.user.userId, botId, guildId },
        { lastSeen: new Date(), guildName: req.query.guildName || "" },
        { upsert: true, new: true }
      );
      await logActivity(req.user.userId, "bot_selected", { botId, botName: bot.name }, guildId, botId, req.ip);
    }

    res.json({
      present,
      botId,
      botName:   bot.name,
      guildId,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${bot.id}&permissions=8&scope=bot+applications.commands`,
    });

  } catch (err) {
    console.error("Bot check error:", err.message);
    res.status(500).json({ error: "Failed to check bot status" });
  }
});

// ── BOTS: Get all registered bots ────────────────────────────────────────────
//  GET /bots
app.get("/bots", (req, res) => {
  res.json({
    bots: Object.entries(BOTS).map(([id, b]) => ({
      id,
      name:      b.name,
      inviteUrl: `https://discord.com/oauth2/authorize?client_id=${b.id}&permissions=8&scope=bot+applications.commands`,
    })),
  });
});

// ── BOTS: Generate invite link for a bot ─────────────────────────────────────
//  GET /bots/:botId/invite
app.get("/bots/:botId/invite", requireAuth, async (req, res) => {
  const bot = BOTS[req.params.botId];
  if (!bot) return res.status(404).json({ error: "Bot not found" });

  await logActivity(
    req.user.userId,
    "invite_generated",
    { botId: req.params.botId, botName: bot.name },
    req.query.guildId || null,
    req.params.botId,
    req.ip
  );

  res.json({
    inviteUrl: `https://discord.com/oauth2/authorize?client_id=${bot.id}&permissions=8&scope=bot+applications.commands`,
  });
});

// ── DASHBOARD: Stats for a bot in a guild ────────────────────────────────────
//  GET /dashboard/:botId/:guildId/stats
app.get("/dashboard/:botId/:guildId/stats", requireAuth, async (req, res) => {
  const { botId, guildId } = req.params;
  if (!BOTS[botId]) return res.status(404).json({ error: "Bot not found" });

  try {
    // Count activity logs for this guild
    const totalCommands = await ActivityLog.countDocuments({ guildId, botId });
    const todayStart    = new Date(); todayStart.setHours(0,0,0,0);
    const commandsToday = await ActivityLog.countDocuments({
      guildId, botId, createdAt: { $gte: todayStart },
    });
    const activeSessions = await BotSession.countDocuments({ botId, guildId });

    res.json({
      totalCommands,
      commandsToday,
      activeSessions,
      botId,
      guildId,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// ── ACTIVITY: Get recent activity for a guild ─────────────────────────────────
//  GET /activity/:guildId?limit=20
app.get("/activity/:guildId", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const logs = await ActivityLog.find({ guildId: req.params.guildId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ activity: logs });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch activity" });
  }
});

// ── ACTIVITY: Log a custom event from frontend ────────────────────────────────
//  POST /activity/log
app.post("/activity/log", requireAuth, async (req, res) => {
  const { type, guildId, botId, meta } = req.body;
  const allowed = [
    "command_used","scrim_created","scrim_joined","match_scheduled",
    "role_updated","settings_changed",
  ];
  if (!allowed.includes(type)) {
    return res.status(400).json({ error: "Invalid activity type" });
  }
  await logActivity(req.user.userId, type, meta || {}, guildId, botId, req.ip);
  res.json({ success: true });
});

// ── SETTINGS: Get bot settings for a guild ────────────────────────────────────
//  GET /settings/:botId/:guildId
app.get("/settings/:botId/:guildId", requireAuth, async (req, res) => {
  // Placeholder — connect to your bot's own settings collection later
  res.json({
    botId:   req.params.botId,
    guildId: req.params.guildId,
    settings: {
      prefix:          "/",
      welcomeMessage:  "Welcome {user}! 🎉",
      logChannel:      null,
      autoAnnounce:    true,
      dmOnScrimInvite: true,
    },
  });
});

// ── 404 Handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║   🤖  Alphabotics API is running     ║
  ║   Port : ${PORT}                        ║
  ║   Mode : ${process.env.NODE_ENV || "development"}                 ║
  ╚══════════════════════════════════════╝
  `);
});
