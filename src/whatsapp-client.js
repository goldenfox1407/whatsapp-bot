import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  fetchLatestBaileysVersion,
  Browsers,
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
  currentWaVersion: null,
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

  let version = [2, 3000, 1046941822];
  try {
    const waVer = await fetchLatestWaWebVersion();
    if (waVer?.version) {
      version = waVer.version;
      logger.info({ version, isLatest: waVer.isLatest }, "Using official WA Web version");
    }
  } catch (err) {
    try {
      const bVer = await fetchLatestBaileysVersion();
      version = bVer.version;
      logger.warn({ version, err: err.message }, "Fallback to Baileys version");
    } catch {}
  }
  state.currentWaVersion = version;

  const sock = makeWASocket({
    version,
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    auth: {
      creds: authState.creds,
      keys: makeCacheableSignalKeyStore(authState.keys, logger),
    },
    getMessage: async (key) => {
      const msg = messageStore.get(key.id);
      return msg || undefined;
    },
    logger: pino({ level: process.env.LOG_LEVEL === "debug" ? "debug" : "warn" }),
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 60000,
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
      logger.info({ user: sock.user }, "✅ WhatsApp connected and ready");
      state.isReady = true;
      state.currentQr = null;
      state.clientStatus = "connected";

      // Mark as available/online — critical for outbound delivery
      try {
        await sock.sendPresenceUpdate("available");
        logger.info("🟢 Presence set to 'available'");
      } catch (e) {
        logger.warn({ err: e.message }, "Failed to set presence");
      }
    }
  });

  // ─── Message status updates (ACKs: delivery, read) ───────────
  sock.ev.on("messages.update", (updates) => {
    for (const update of updates) {
      if (update.update?.status) {
        logger.info(
          { keyId: update.key?.id, remoteJid: update.key?.remoteJid, status: update.update.status },
          "📊 Message status update (ack)"
        );
      }
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
  logger.info({ jid, length: text?.length }, "📤 Baileys sending text message");

  // Ensure we appear online and subscribe to the recipient's presence
  try {
    await activeSock.sendPresenceUpdate("available");
    if (jid.endsWith("@s.whatsapp.net")) {
      await activeSock.presenceSubscribe(jid);
      await new Promise(r => setTimeout(r, 200));
      await activeSock.sendPresenceUpdate("composing", jid);
      await new Promise(r => setTimeout(r, 300));
      await activeSock.sendPresenceUpdate("paused", jid);
    }
  } catch (e) {
    logger.warn({ err: e.message }, "Presence setup warning (non-fatal)");
  }

  const sent = await activeSock.sendMessage(jid, { text });
  logger.info({ jid, msgId: sent?.key?.id, status: sent?.status }, "✅ Dispatched to WhatsApp socket");
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
  logger.info({ jid, mediaUrl }, "📤 Baileys sending media message");
  const response = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
  });
  const buffer = Buffer.from(response.data);
  const sent = await activeSock.sendMessage(jid, {
    image: buffer,
    caption: text,
  });
  logger.info({ jid, msgId: sent?.key?.id, status: sent?.status }, "✅ Media dispatched to WhatsApp socket");
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

/** Check if a number is registered on WhatsApp and get its JID */
export async function checkNumberOnWhatsApp(number) {
  if (!activeSock || !state.isReady) {
    throw new Error("WhatsApp not connected");
  }
  const cleanNumber = number.replace(/[^0-9]/g, "");
  const results = await activeSock.onWhatsApp(cleanNumber);
  logger.info({ number: cleanNumber, results }, "🔍 onWhatsApp check");
  return results;
}

/** Send with ACK tracking — waits up to 10s for server acknowledgement */
export async function sendMessageWithAckWait(jid, text) {
  if (!activeSock || !state.isReady) {
    throw new Error("WhatsApp not connected");
  }

  logger.info({ jid, length: text?.length }, "📤 Sending with ACK wait");

  const sent = await activeSock.sendMessage(jid, { text });
  const sentMsgId = sent?.key?.id;

  logger.info(
    { jid, msgId: sentMsgId, sentKey: sent?.key, status: sent?.status },
    "📨 Message dispatched, waiting for server ACK..."
  );

  if (sent?.key?.id && sent?.message) {
    messageStore.set(sent.key.id, sent.message);
  }

  // Wait for server ACK (messages.update event with status >= 2)
  const ackResult = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      activeSock.ev.off("messages.update", handler);
      resolve({ acked: false, reason: "timeout_10s" });
    }, 10000);

    function handler(updates) {
      for (const update of updates) {
        if (update.key?.id === sentMsgId && update.update?.status) {
          clearTimeout(timeout);
          activeSock.ev.off("messages.update", handler);
          resolve({ acked: true, status: update.update.status, statusName: getStatusName(update.update.status) });
          return;
        }
      }
    }
    activeSock.ev.on("messages.update", handler);
  });

  logger.info({ jid, msgId: sentMsgId, ackResult }, "📊 ACK result");
  return { sent, ackResult };
}

function getStatusName(status) {
  const names = { 0: "ERROR", 1: "PENDING", 2: "SERVER_ACK", 3: "DELIVERY_ACK", 4: "READ", 5: "PLAYED" };
  return names[status] || `UNKNOWN(${status})`;
}
