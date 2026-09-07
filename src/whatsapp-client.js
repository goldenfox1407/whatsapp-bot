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
const messageStore = new Map(); // key.id -> message (for answering Signal retry receipts to prevent 'waiting for this message')
const processedMsgIds = new Set(); // deduplication of incoming messages

export function getBotUser() {
  return activeSock?.user || null;
}

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
    getMessage: async (key) => {
      const msg = messageStore.get(key.id);
      return msg || undefined;
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
      const msgId = msg.key?.id;

      // Store message in cache for answering Signal retry receipts (both incoming and outgoing)
      if (msgId && msg.message) {
        messageStore.set(msgId, msg.message);
        if (messageStore.size > 3000) {
          const oldest = messageStore.keys().next().value;
          messageStore.delete(oldest);
        }
      }

      // Skip status broadcasts and own messages for webhook forwarding
      if (msg.key.remoteJid === "status@broadcast") continue;
      if (msg.key.fromMe) continue;

      // Unwrap any nested message layers (ephemeralMessage, viewOnceMessage, etc.)
      let messageContent = msg.message;
      while (
        messageContent?.ephemeralMessage?.message ||
        messageContent?.viewOnceMessage?.message ||
        messageContent?.viewOnceMessageV2?.message ||
        messageContent?.documentWithCaptionMessage?.message
      ) {
        messageContent =
          messageContent?.ephemeralMessage?.message ||
          messageContent?.viewOnceMessage?.message ||
          messageContent?.viewOnceMessageV2?.message ||
          messageContent?.documentWithCaptionMessage?.message;
      }

      const from = msg.key.remoteJid;
      const body =
        messageContent?.conversation ||
        messageContent?.extendedTextMessage?.text ||
        messageContent?.imageMessage?.caption ||
        messageContent?.videoMessage?.caption ||
        "";

      const hasImage = !!messageContent?.imageMessage;
      const hasVideo = !!messageContent?.videoMessage;
      const hasDocument = !!messageContent?.documentMessage;
      const hasMedia = hasImage || hasVideo || hasDocument;

      // CRITICAL: If message has no body and no media, it is an undecrypted envelope, typing notification, or stub.
      // NEVER forward empty messages to Laravel, and NEVER mark msgId in processedMsgIds!
      // This allows the full decrypted message to be processed when Baileys receives it.
      if (!body.trim() && !hasMedia) {
        logger.info({ msgId }, "Ignoring empty/stub/pending-decryption message upsert");
        continue;
      }

      // Deduplicate: do not forward the same incoming message with content multiple times
      if (msgId && processedMsgIds.has(msgId)) {
        logger.info({ msgId }, "Skipping duplicate message upsert");
        continue;
      }
      if (msgId) {
        processedMsgIds.add(msgId);
        if (processedMsgIds.size > 3000) {
          const oldest = processedMsgIds.values().next().value;
          processedMsgIds.delete(oldest);
        }
      }

      logger.info(
        { msgId, from, hasMedia, body: body.substring(0, 80) },
        "📩 Incoming message"
      );

      // ─── Download media if present ────────────────────────
      let mediaData = null;
      if (hasMedia) {
        try {
          logger.info({ from }, "Downloading media...");
          const buffer = await downloadMediaMessage(
            { key: msg.key, message: messageContent },
            "buffer",
            {},
            {
              logger: pino({ level: "silent" }),
              reuploadRequest: sock.updateMediaMessage,
            }
          );

          const mimetype =
            messageContent?.imageMessage?.mimetype ||
            messageContent?.videoMessage?.mimetype ||
            messageContent?.documentMessage?.mimetype ||
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
                messageContent?.documentMessage?.fileName || null,
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
            id: msgId,
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
  const sent = await activeSock.sendMessage(jid, { text });
  if (sent?.key?.id && sent?.message) {
    messageStore.set(sent.key.id, sent.message);
    if (messageStore.size > 3000) {
      const oldest = messageStore.keys().next().value;
      messageStore.delete(oldest);
    }
  }
  return sent;
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
  const sent = await activeSock.sendMessage(jid, {
    image: buffer,
    caption: text,
  });
  if (sent?.key?.id && sent?.message) {
    messageStore.set(sent.key.id, sent.message);
    if (messageStore.size > 3000) {
      const oldest = messageStore.keys().next().value;
      messageStore.delete(oldest);
    }
  }
  return sent;
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
