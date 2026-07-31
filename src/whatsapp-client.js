import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import axios from "axios";
import QRCode from "qrcode";

// ─── Configuration ───────────────────────────────────────────────
const LARAVEL_WEBHOOK_URL =
  process.env.LARAVEL_WEBHOOK_URL ||
  "https://gestion.puremed.ma/api/whatsapp/webhook";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ─── State ───────────────────────────────────────────────────────
export const state = {
  isReady: false,
  currentQr: null,
  clientStatus: "starting", // starting | waiting_qr | connected | disconnected
};

let activeSock = null;
let reconnectTimer = null;

// ─── Create & Start WhatsApp Connection ──────────────────────────
async function startBot() {
  state.clientStatus = "starting";
  state.isReady = false;
  state.currentQr = null;

  const { state: authState, saveCreds } =
    await useMultiFileAuthState("auth_info");

  const { version } = await fetchLatestBaileysVersion();
  logger.info({ version }, "Using WA version");

  const sock = makeWASocket({
    version,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    logger: pino({ level: "silent" }),
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: undefined,
  });

  activeSock = sock;

  // ─── Save credentials on update ─────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ─── Connection lifecycle ───────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("QR Code received — scan with WhatsApp");
      try {
        state.currentQr = await QRCode.toDataURL(qr);
      } catch {
        state.currentQr = qr;
      }
      state.clientStatus = "waiting_qr";
    }

    if (connection === "close") {
      state.isReady = false;
      state.currentQr = null;
      state.clientStatus = "disconnected";

      const statusCode =
        (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      logger.warn(
        { statusCode, shouldReconnect },
        "Connection closed"
      );

      if (shouldReconnect) {
        scheduleReconnect(5000);
      } else {
        logger.info("Logged out — delete auth_info folder and restart to re-scan QR");
      }
    }

    if (connection === "open") {
      logger.info("✅ WhatsApp connected and ready");
      state.isReady = true;
      state.currentQr = null;
      state.clientStatus = "connected";
    }
  });

  // ─── Incoming messages → forward to Laravel webhook ─────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip status broadcasts and own messages
      if (msg.key.remoteJid === "status@broadcast") continue;
      if (msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      const hasImage = !!msg.message?.imageMessage;
      const hasVideo = !!msg.message?.videoMessage;
      const hasDocument = !!msg.message?.documentMessage;
      const hasMedia = hasImage || hasVideo || hasDocument;

      logger.info(
        { from, hasMedia, body: body.substring(0, 80) },
        "📩 Incoming message"
      );

      // ─── Download media if present ────────────────────────
      let mediaData = null;
      if (hasMedia) {
        try {
          logger.info({ from }, "Downloading media...");
          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            {
              logger: pino({ level: "silent" }),
              reuploadRequest: sock.updateMediaMessage,
            }
          );

          const mimetype =
            msg.message?.imageMessage?.mimetype ||
            msg.message?.videoMessage?.mimetype ||
            msg.message?.documentMessage?.mimetype ||
            "application/octet-stream";

          const sizeInMB = buffer.length / (1024 * 1024);
          logger.info(
            { sizeInMB: sizeInMB.toFixed(2), mimetype },
            "✅ Media downloaded"
          );

          if (sizeInMB > 15) {
            logger.warn("Media too large (>15MB) — skipping");
          } else {
            mediaData = {
              mimetype,
              data: buffer.toString("base64"),
              filename:
                msg.message?.documentMessage?.fileName || null,
            };
          }
        } catch (err) {
          logger.error(
            { err: err.message },
            "❌ Failed to download media"
          );
        }
      }

      // ─── Forward to Laravel webhook ───────────────────────
      try {
        await axios.post(
          LARAVEL_WEBHOOK_URL,
          {
            from,
            to: msg.key.participant || from,
            body,
            timestamp: msg.messageTimestamp,
            hasMedia: hasMedia && mediaData !== null,
            media: mediaData,
            isForwarded: !!msg.message?.extendedTextMessage?.contextInfo
              ?.isForwarded,
          },
          {
            timeout: 30000,
            maxBodyLength: 50 * 1024 * 1024,
            maxContentLength: 50 * 1024 * 1024,
          }
        );
        logger.info({ hasMedia: mediaData !== null }, "✅ Forwarded to Laravel");
      } catch (err) {
        const status = err?.response?.status ?? "N/A";
        logger.error(
          { status, err: err.message },
          "❌ Failed to forward to webhook"
        );
      }
    }
  });
}

// ─── Reconnection Logic ──────────────────────────────────────────
function scheduleReconnect(delayMs) {
  if (reconnectTimer) return;
  logger.info({ delayMs }, "Scheduling reconnection...");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, delayMs);
}

// ─── Public API ──────────────────────────────────────────────────

/** Send a text message */
export async function sendMessage(jid, text) {
  if (!activeSock || !state.isReady) {
    throw new Error("WhatsApp not connected");
  }
  await activeSock.sendMessage(jid, { text });
}

/** Send a message with an image from URL */
export async function sendMediaFromUrl(jid, text, mediaUrl) {
  if (!activeSock || !state.isReady) {
    throw new Error("WhatsApp not connected");
  }
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
  });
  const buffer = Buffer.from(response.data);
  await activeSock.sendMessage(jid, {
    image: buffer,
    caption: text,
  });
}

/** Reinitialize (force reconnect) */
export async function reinitialize() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    await activeSock?.end();
  } catch {}
  activeSock = null;
  await startBot();
}

/** Logout (clear session) */
export async function logout() {
  try {
    await activeSock?.logout();
  } catch {}
  state.isReady = false;
  state.currentQr = null;
  state.clientStatus = "disconnected";
}

/** Initialize the bot */
export function initializeWhatsApp() {
  process.on("uncaughtException", (err) => {
    logger.error({ err: err.message }, "Uncaught exception — reconnecting in 10s");
    state.clientStatus = "disconnected";
    state.isReady = false;
    scheduleReconnect(10000);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(
      { reason: reason?.message ?? reason },
      "Unhandled rejection — reconnecting in 10s"
    );
    state.clientStatus = "disconnected";
    state.isReady = false;
    scheduleReconnect(10000);
  });

  startBot();
}
