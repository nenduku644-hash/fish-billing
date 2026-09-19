const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const { exec } = require('child_process');
const mqtt = require('mqtt');

const WA_STATUS_TOPIC = 'aaryan_aqua_gst_billing_2026/whatsapp_status';
const WA_COMMANDS_TOPIC = 'aaryan_aqua_gst_billing_2026/whatsapp_commands';
const WA_ACK_TOPIC = 'aaryan_aqua_gst_billing_2026/whatsapp_ack';
let mqttBridgeClient = null;

process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (msg.includes('Execution context was destroyed') || msg.includes('Target closed') || msg.includes('Session closed') || msg.includes('detached Frame')) {
    console.log('🔄 Handled WhatsApp Web navigation state change safely.');
    return;
  }
  console.error('Bot uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('Execution context was destroyed') || msg.includes('Target closed') || msg.includes('Session closed') || msg.includes('detached Frame')) {
    console.log('🔄 Handled WhatsApp Web navigation state change safely.');
    return;
  }
  console.error('Bot unhandledRejection:', reason);
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// State
let client = null;
let status = 'DISCONNECTED'; // DISCONNECTED | INITIALIZING | QR_READY | CODE_READY | AUTHENTICATING | CONNECTED | AUTH_FAILURE
let qrCodeDataUrl = null;
let rawQr = null;
let pairingCode = null;
let clientInfo = null;
let errorMessage = null;
let isInitializing = false;
let qrTimestamp = null;
let activityLogs = [];

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {}
}

const authPath = path.join(__dirname, 'data', '.wwebjs_auth');
const logsPath = path.join(__dirname, 'data', 'whatsapp_logs.json');
const invoicesPath = path.join(__dirname, 'data', 'invoices.json');
const productsPath = path.join(__dirname, 'data', 'products.json');
const partiesPath = path.join(__dirname, 'data', 'parties.json');
const settingsPath = path.join(__dirname, 'data', 'settings.json');

// Local Multi-User Instant Sync SSE subscribers
const syncSseClients = new Set();

function broadcastSyncMutation(mutation) {
  const payload = JSON.stringify(mutation);
  for (const clientRes of syncSseClients) {
    try {
      clientRes.write(`data: ${payload}\n\n`);
    } catch (e) {
      syncSseClients.delete(clientRes);
    }
  }
}

// Hydrate existing activity logs from disk
try {
  if (fs.existsSync(logsPath)) {
    const raw = fs.readFileSync(logsPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) activityLogs = parsed;
  }
} catch (e) {
  console.warn('Could not read existing whatsapp_logs.json:', e.message);
}

// Server-Sent Events subscribers
const sseClients = new Set();

function broadcastStatus() {
  const currentStatus = getStatus();
  const payload = JSON.stringify(currentStatus);
  for (const clientRes of sseClients) {
    try {
      clientRes.write(`data: ${payload}\n\n`);
    } catch (e) {
      sseClients.delete(clientRes);
    }
  }

  // Publish to EMQX MQTT cloud mesh with retain: true for instant live sync on Netlify
  if (mqttBridgeClient && mqttBridgeClient.connected) {
    try {
      mqttBridgeClient.publish(WA_STATUS_TOPIC, payload, { qos: 0, retain: true });
    } catch (e) {
      console.warn('MQTT broadcast status error:', e.message);
    }
  }
}

function killLingeringChromeProcesses() {
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      const psScript = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and ($_.CommandLine -like '*wwebjs*' -or $_.CommandLine -like '*test_auth*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`, { stdio: 'ignore', timeout: 4000 });
    } catch (e) {}
  }
}

function cleanChromiumLocks(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        cleanChromiumLocks(fullPath);
      } else if (entry.name.startsWith('Singleton') || entry.name === 'SingletonLock' || entry.name === 'SingletonCookie' || entry.name === 'SingletonSocket' || entry.name === 'lockfile' || entry.name === 'LOCK') {
        try { fs.unlinkSync(fullPath); } catch (e) {}
      }
    }
  } catch (e) {}
}

async function handleDisconnect() {
  console.log('🚪 Disconnecting & unlinking WhatsApp device...');
  try {
    if (client) {
      try { await client.logout(); } catch (e) {}
      try {
        if (client.pupBrowser) {
          const proc = client.pupBrowser.process();
          if (proc?.pid) {
            try { process.kill(proc.pid, 'SIGKILL'); } catch (e) {}
          }
          await client.pupBrowser.close();
        }
      } catch (e) {}
      try { await client.destroy(); } catch (e) {}
      client = null;
    }
  } catch (e) {}

  killLingeringChromeProcesses();
  await new Promise(r => setTimeout(r, 400));
  cleanChromiumLocks(authPath);

  try {
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
      console.log('🧹 Cleaned session auth folder on disconnect.');
    }
  } catch (e) {}
  try {
    const qrFile = path.join(__dirname, 'whatsapp_qr.png');
    if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
  } catch (e) {}

  status = 'DISCONNECTED';
  clientInfo = null;
  qrCodeDataUrl = null;
  rawQr = null;
  pairingCode = null;
  logActivity({ type: 'STATUS', status: 'DISCONNECTED', desc: 'Device unlinked by user' });
  broadcastStatus();
  console.log('🔄 Starting fresh WhatsApp engine for next connection in 1 second...');
  setTimeout(() => initClient({ forceClean: true }), 1000);
}

function initMqttBridge() {
  const brokers = [
    'wss://test.mosquitto.org:8081/mqtt',
    'ws://test.mosquitto.org:8080/mqtt'
  ];
  let brokerIdx = 0;
  let reconnectTimer = null;

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      brokerIdx = (brokerIdx + 1) % brokers.length;
      connect();
    }, 2500);
  }

  function connect() {
    if (mqttBridgeClient) {
      try { mqttBridgeClient.end(true); } catch (e) {}
      mqttBridgeClient = null;
    }
    const broker = brokers[brokerIdx];
    console.log(`🔌 Connecting WhatsApp Bot to Cloud Mesh Broker: ${broker}...`);

    mqttBridgeClient = mqtt.connect(broker, {
      clientId: 'wa_host_daemon_' + Math.random().toString(36).substring(2, 8),
      clean: true,
      keepalive: 15,
      reconnectPeriod: 3000,
      connectTimeout: 6000,
      will: {
        topic: WA_STATUS_TOPIC,
        payload: JSON.stringify({
          status: 'DISCONNECTED',
          isReady: false,
          lastHeartbeat: 0,
          timestamp: 0,
          desc: 'Bot offline (process terminated)'
        }),
        qos: 1,
        retain: true
      }
    });

    mqttBridgeClient.on('connect', () => {
      console.log(`⚡ WhatsApp Bot Cloud Mesh ACTIVE via ${broker}! Synchronizing live QR & commands to GitHub Pages / Cloud.`);
      mqttBridgeClient.subscribe(WA_COMMANDS_TOPIC, { qos: 0 });
      broadcastStatus();

      // Ensure periodic 8s heartbeat so web clients know the bot is genuinely alive
      if (!global.waHeartbeatInterval) {
        global.waHeartbeatInterval = setInterval(() => {
          if (mqttBridgeClient && mqttBridgeClient.connected) {
            broadcastStatus();
          } else {
            clearInterval(global.waHeartbeatInterval);
            global.waHeartbeatInterval = null;
          }
        }, 8000);
      }
    });

    mqttBridgeClient.on('message', async (topic, message) => {
      if (topic === WA_COMMANDS_TOPIC) {
        try {
          const cmd = JSON.parse(message.toString());
          console.log('📨 Received WhatsApp Cloud Command:', cmd.command || cmd.action);

          if (cmd.command === 'refresh_qr' || cmd.action === 'refresh_qr') {
            console.log('🔄 Remote refresh QR requested...');
            initClient({ forceClean: false });
          } else if (cmd.command === 'pair_code' || cmd.action === 'pair_code') {
            if (cmd.phone) {
              console.log('🔑 Remote pairing code requested for:', cmd.phone);
              initClient({ forceClean: true, pairPhone: cmd.phone });
            }
          } else if (cmd.command === 'get_status' || cmd.action === 'get_status') {
            broadcastStatus();
          } else if (cmd.command === 'disconnect' || cmd.action === 'disconnect') {
            await handleDisconnect();
          } else if (cmd.command === 'restart' || cmd.action === 'restart') {
            console.log('🔄 Remote restart requested with session preserved...');
            initClient({ forceRestart: true });
          } else if (cmd.command === 'send_message' || cmd.action === 'send_message') {
            if (status === 'CONNECTED' && client && cmd.phone && cmd.text) {
              const chatId = await resolveChatId(cmd.phone);
              if (chatId) {
                console.log(`💬 Sending WhatsApp Message via Cloud Mesh to +${cmd.phone}...`);
                try {
                  await safeClientSendMessage(chatId, cmd.text);
                  logActivity({ type: 'MESSAGE', phone: cmd.phone, status: 'SENT' });
                  console.log(`✅ WhatsApp Message delivered to +${cmd.phone}!`);
                  if (mqttBridgeClient && mqttBridgeClient.connected) {
                    mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                      commandId: cmd.commandId || cmd.timestamp,
                      phone: cmd.phone,
                      status: 'DELIVERED',
                      timestamp: Date.now()
                    }));
                  }
                } catch (sendErr) {
                  console.error(`❌ Send message error to +${cmd.phone}:`, sendErr.message);
                  if (mqttBridgeClient && mqttBridgeClient.connected) {
                    mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                      commandId: cmd.commandId || cmd.timestamp,
                      phone: cmd.phone,
                      status: 'FAILED',
                      error: sendErr.message,
                      timestamp: Date.now()
                    }));
                  }
                }
              } else {
                if (mqttBridgeClient && mqttBridgeClient.connected) {
                  mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                    commandId: cmd.commandId || cmd.timestamp,
                    phone: cmd.phone,
                    status: 'FAILED',
                    error: 'Invalid phone number format: ' + cmd.phone,
                    timestamp: Date.now()
                  }));
                }
              }
            } else {
              if (mqttBridgeClient && mqttBridgeClient.connected) {
                mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                  commandId: cmd.commandId || cmd.timestamp,
                  phone: cmd.phone,
                  status: 'FAILED',
                  error: 'Bot not ready (status: ' + status + ')',
                  timestamp: Date.now()
                }));
              }
            }
          } else if (cmd.command === 'send_invoice' || cmd.action === 'send_invoice') {
            if (status === 'CONNECTED' && client && cmd.phone) {
              const chatId = await resolveChatId(cmd.phone);
              if (chatId) {
                console.log(`📄 Sending WhatsApp Invoice & PDF via Cloud Mesh to +${cmd.phone}...`);
                try {
                  let mediaSent = false;
                  let textSent = false;
                  let lastErr = null;

                  let pdfData = cmd.pdfBase64;
                  if (!pdfData && cmd.pdfUrl && typeof cmd.pdfUrl === 'string' && cmd.pdfUrl.startsWith('http')) {
                    try {
                      pdfData = await fetchPdfBase64FromUrl(cmd.pdfUrl);
                    } catch (uErr) {
                      console.warn('PDF download from URL note:', uErr.message);
                    }
                  }

                  if (pdfData) {
                    try {
                      const docCaption = sanitizeCaption(cmd.caption || `📄 ${cmd.filename || 'Tax Invoice'} - Aaryan Aqua Needs`);
                      await safeClientSendPdf(chatId, cmd.filename || 'Invoice.pdf', pdfData, docCaption);
                      mediaSent = true;
                      console.log(`📄 WhatsApp Invoice (WITH PDF) delivered to +${cmd.phone}!`);
                    } catch (mediaErr) {
                      lastErr = mediaErr;
                      console.warn(`⚠️ Cloud Mesh PDF media dispatch error (${mediaErr.message}), automatically ensuring text breakdown delivery...`);
                    }
                  }

                  if (cmd.text) {
                    try {
                      await safeClientSendMessage(chatId, cmd.text);
                      textSent = true;
                      console.log(`💬 WhatsApp Invoice (GREETING & DETAILS) delivered to +${cmd.phone}!`);
                    } catch (textErr) {
                      lastErr = textErr;
                      console.error(`❌ Cloud Mesh text dispatch error to +${cmd.phone}:`, textErr.message);
                    }
                  }

                  if (mediaSent || textSent) {
                    logActivity({ type: mediaSent ? 'INVOICE_PDF' : 'MESSAGE', phone: cmd.phone, filename: cmd.filename, status: 'SENT' });
                    if (mqttBridgeClient && mqttBridgeClient.connected) {
                      mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                        commandId: cmd.commandId || cmd.timestamp,
                        phone: cmd.phone,
                        status: 'DELIVERED',
                        timestamp: Date.now()
                      }));
                    }
                  } else {
                    throw lastErr || new Error('Failed to dispatch message or PDF via bot');
                  }
                } catch (invErr) {
                  console.error(`❌ Send invoice error to +${cmd.phone}:`, invErr.message);
                  if (mqttBridgeClient && mqttBridgeClient.connected) {
                    mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                      commandId: cmd.commandId || cmd.timestamp,
                      phone: cmd.phone,
                      status: 'FAILED',
                      error: invErr.message,
                      timestamp: Date.now()
                    }));
                  }
                }
              } else {
                if (mqttBridgeClient && mqttBridgeClient.connected) {
                  mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                    commandId: cmd.commandId || cmd.timestamp,
                    phone: cmd.phone,
                    status: 'FAILED',
                    error: 'Invalid phone number format: ' + cmd.phone,
                    timestamp: Date.now()
                  }));
                }
              }
            } else {
              if (mqttBridgeClient && mqttBridgeClient.connected) {
                mqttBridgeClient.publish(WA_ACK_TOPIC, JSON.stringify({
                  commandId: cmd.commandId || cmd.timestamp,
                  phone: cmd.phone,
                  status: 'FAILED',
                  error: 'Bot not ready (status: ' + status + ')',
                  timestamp: Date.now()
                }));
              }
            }
          }
        } catch (e) {
          console.error('MQTT command error:', e.message);
        }
      }
    });

    mqttBridgeClient.on('error', (err) => {
      console.warn('MQTT mesh bridge error:', err.message);
      scheduleReconnect();
    });

    mqttBridgeClient.on('close', () => {
      console.warn('MQTT mesh bridge closed, reconnecting to mesh...');
      scheduleReconnect();
    });
  }

  connect();
}

function logActivity(entry) {
  const item = {
    id: 'wa_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    timestamp: new Date().toISOString(),
    ...entry
  };
  activityLogs.unshift(item);
  if (activityLogs.length > 100) activityLogs.pop();
  try {
    fs.writeFileSync(logsPath, JSON.stringify(activityLogs, null, 2), 'utf8');
  } catch (e) {}
  broadcastStatus();
}

function getStatus() {
  const qrAgeMs = qrTimestamp ? (Date.now() - qrTimestamp) : null;
  const qrExpiresInSec = qrTimestamp ? Math.max(0, Math.round((28000 - qrAgeMs) / 1000)) : 0;
  const isQrExpired = qrTimestamp ? (qrAgeMs > 30000) : false;

  return {
    status: (isQrExpired && status === 'QR_READY') ? 'QR_EXPIRED' : status,
    isReady: status === 'CONNECTED',
    qrCodeDataUrl: isQrExpired ? null : qrCodeDataUrl,
    rawQr: isQrExpired ? null : rawQr,
    pairingCode,
    clientInfo,
    errorMessage,
    qrTimestamp,
    qrExpiresInSec,
    isQrExpired,
    lastHeartbeat: Date.now(),
    timestamp: Date.now()
  };
}

function formatPhone(phone) {
  if (!phone) return null;
  let digits = phone.toString().replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.substring(1);
  return digits.length >= 10 ? `${digits}@c.us` : null;
}

async function resolveChatId(phone) {
  if (!phone) return null;
  let digits = phone.toString().replace(/\D/g, '');
  if (digits.length === 10) digits = '91' + digits;
  else if (digits.length === 11 && digits.startsWith('0')) digits = '91' + digits.substring(1);
  if (!digits || digits.length < 10) return null;

  if (client) {
    try {
      const numId = await client.getNumberId(digits);
      if (numId && numId._serialized) {
        return numId._serialized;
      }
    } catch (e) {
      console.warn('getNumberId note:', e?.message || e);
    }
  }
  return `${digits}@c.us`;
}

function sanitizeCaption(str) {
  if (!str || typeof str !== 'string') return '';
  let trimmed = str.trim();
  // Strip out accidental raw base64 or long payload strings from WhatsApp document caption
  if (trimmed.startsWith('data:') || trimmed.startsWith('JVBERi0')) {
    return '';
  }
  if (trimmed.length > 1024) {
    trimmed = trimmed.substring(0, 1020) + '...';
  }
  return trimmed;
}

function getChromeVersion() {
  try {
    const cp = findChromeExecutable();
    if (cp && process.platform === 'win32') {
      const { execSync } = require('child_process');
      const out = execSync(`powershell -NoProfile -Command "(Get-Item '${cp}').VersionInfo.ProductVersion"`, { timeout: 2500 }).toString().trim();
      if (out && /^\d+/.test(out)) return out;
    }
  } catch (e) {}
  return '153.0.8010.48';
}

function findChromeExecutable() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.USERPROFILE || 'C:\\Users\\ADMIN', '.cache', 'puppeteer', 'chrome', 'win64-146.0.7680.31', 'chrome-win64', 'chrome.exe'),
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return undefined;
}

async function safeClientSendMessage(chatId, content, options = {}) {
  if (!client) throw new Error('WhatsApp bot client is not initialized');
  try {
    return await client.sendMessage(chatId, content, options);
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (errMsg.includes('detached Frame') || errMsg.includes('Execution context was destroyed') || errMsg.includes('Target closed') || errMsg.includes('Session closed')) {
      console.warn('⚠️ WhatsApp Web Puppeteer frame detached. Attempting live page reload recovery...', errMsg);
      if (client && client.pupPage && !client.pupPage.isClosed()) {
        try {
          await client.pupPage.reload({ waitUntil: 'networkidle0', timeout: 25000 });
          await new Promise(r => setTimeout(r, 2000));
          return await client.sendMessage(chatId, content, options);
        } catch (reloadErr) {
          console.warn('Live page reload recovery failed, restarting engine with preserved session...', reloadErr.message);
        }
      }
      // Re-initialize client without wiping auth session
      initClient({ forceRestart: true });
    }
    throw err;
  }
}

function fetchPdfBase64FromUrl(url) {
  if (!url || !url.startsWith('http')) return Promise.resolve(null);
  const clientMod = url.startsWith('https') ? require('https') : require('http');
  return new Promise((resolve) => {
    clientMod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPdfBase64FromUrl(res.headers.location).then(resolve);
      }
      if (res.statusCode !== 200) return resolve(null);
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.toString('base64'));
      });
    }).on('error', () => resolve(null));
  });
}

async function safeClientSendPdf(chatId, filename, pdfBase64, caption = '') {
  if (!client) throw new Error('WhatsApp bot client is not initialized');
  const cleanB64 = String(pdfBase64).replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const docCaption = sanitizeCaption(caption || `📄 ${filename || 'Tax Invoice'} - Aaryan Aqua Needs`);

  console.log(`📤 Dispatching PDF document "${filename || 'Invoice.pdf'}" to ${chatId}...`);

  // Direct evaluation using WhatsApp Web's own WWebJS.sendMessage with properly formatted options.media
  if (client.pupPage && !client.pupPage.isClosed()) {
    try {
      const result = await client.pupPage.evaluate(async (targetChatId, b64, fname, cap) => {
        try {
          const chat = await window.WWebJS.getChat(targetChatId, { getAsModel: false });
          if (!chat) throw new Error('Chat not found for ' + targetChatId);
          const actualChat = (chat && chat.chat) ? chat.chat : chat;

          const mediaData = {
            mimetype: 'application/pdf',
            data: b64,
            filename: fname || 'Invoice.pdf'
          };

          const options = {
            media: mediaData,
            caption: cap || '',
            sendMediaAsDocument: true,
            waitUntilMsgSent: false
          };

          const msg = await window.WWebJS.sendMessage(actualChat, cap || '', options);
          return { ok: true, id: msg?.id?._serialized || 'sent' };
        } catch (innerErr) {
          return { ok: false, error: innerErr?.message || String(innerErr) };
        }
      }, chatId, cleanB64, filename, docCaption);

      if (result && result.ok) {
        console.log(`✅ PDF document "${filename || 'Invoice.pdf'}" successfully delivered to ${chatId}!`);
        return result;
      }
      if (result && result.error) {
        console.warn('WWebJS.sendMessage direct note:', result.error, 'Trying MessageMedia fallback...');
      }
    } catch (evalErr) {
      console.warn('Puppeteer evaluate note:', evalErr.message, 'Trying MessageMedia fallback...');
    }
  }

  // Fallback: Official MessageMedia document sending via client.sendMessage
  try {
    const media = new MessageMedia('application/pdf', cleanB64, filename || 'Invoice.pdf');
    const result = await safeClientSendMessage(chatId, media, {
      caption: docCaption,
      sendMediaAsDocument: true
    });
    console.log(`✅ PDF document successfully delivered via MessageMedia fallback to ${chatId}!`);
    return result || { ok: true, id: 'sent' };
  } catch (mediaErr) {
    console.error('MessageMedia delivery error:', mediaErr.message);
    throw mediaErr;
  }
}

async function initClient(options = {}) {
  const { forceClean = false, forceRestart = false, pairPhone = null, retryCount = 0 } = options;
  if (status === 'CONNECTED' && !forceClean && !forceRestart) return getStatus();
  if (isInitializing) return getStatus();

  isInitializing = true;
  status = 'INITIALIZING';
  qrCodeDataUrl = null;
  rawQr = null;
  pairingCode = null;
  errorMessage = null;
  broadcastStatus();

  try {
    if (client) {
      try {
        if (client.pupBrowser) {
          const proc = client.pupBrowser.process();
          if (proc?.pid) {
            try { process.kill(proc.pid, 'SIGKILL'); } catch (e) {}
          }
          await client.pupBrowser.close();
        }
      } catch (e) {}
      try { await client.destroy(); } catch (e) {}
      client = null;
    }

    killLingeringChromeProcesses();
    await new Promise(r => setTimeout(r, 400));
    cleanChromiumLocks(authPath);

    if (forceClean) {
      try {
        if (fs.existsSync(authPath)) {
          fs.rmSync(authPath, { recursive: true, force: true });
          console.log('🧹 Cleaned session auth folder.');
        }
      } catch (e) {
        console.warn('Could not remove authPath:', e.message);
      }
      try {
        const qrFile = path.join(__dirname, 'whatsapp_qr.png');
        if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
      } catch (e) {}
    }

    const chromePath = findChromeExecutable();
    const chromeVer = getChromeVersion();
    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process'
    ];

    const puppeteerConfig = {
      headless: true,
      args: puppeteerArgs
    };
    if (chromePath) {
      puppeteerConfig.executablePath = chromePath;
    }

    const clientConfig = {
      authStrategy: new LocalAuth({ dataPath: authPath }),
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer} Safari/537.36`,
      webVersionCache: {
        type: 'none'
      },
      puppeteer: puppeteerConfig
    };

    if (pairPhone) {
      let digits = pairPhone.toString().replace(/\D/g, '');
      if (digits.length === 10) digits = '91' + digits;
      clientConfig.pairWithPhoneNumber = { phoneNumber: digits, showNotification: false };
    }

    client = new Client(clientConfig);

    client.on('qr', async (qr) => {
      console.log('📱 WhatsApp QR Code Generated! Waiting for scan...');
      rawQr = qr;
      status = 'QR_READY';
      pairingCode = null;
      isInitializing = false;
      qrTimestamp = Date.now();
      try {
        qrCodeDataUrl = await qrcode.toDataURL(qr, {
          width: 320,
          margin: 2,
          color: { dark: '#0a4b5c', light: '#ffffff' }
        });
        try {
          const b64 = qrCodeDataUrl.replace(/^data:image\/png;base64,/, '');
          fs.writeFileSync(path.join(__dirname, 'whatsapp_qr.png'), b64, 'base64');
        } catch (we) {}
      } catch (err) {
        console.error('QR generate error:', err);
      }
      broadcastStatus();
    });

    client.on('code', (code) => {
      console.log('🔑 WhatsApp Pairing Code Received:', code);
      pairingCode = code;
      status = 'CODE_READY';
      qrCodeDataUrl = null;
      isInitializing = false;
      broadcastStatus();
    });

    client.on('authenticated', () => {
      console.log('🔐 Authenticated successfully!');
      status = 'AUTHENTICATING';
      qrCodeDataUrl = null;
      rawQr = null;
      pairingCode = null;
      qrTimestamp = null;
      isInitializing = false;
      broadcastStatus();

      if (global.authReadyCheck) clearInterval(global.authReadyCheck);
      global.authReadyCheck = setInterval(async () => {
        if (status === 'CONNECTED') {
          clearInterval(global.authReadyCheck);
          return;
        }
        if (client && client.pupPage && !client.pupPage.isClosed()) {
          try {
            const me = await client.pupPage.evaluate(() => {
              try {
                const pn = window.require('WAWebUserPrefsMeUser').getMaybeMePnUser();
                const lid = window.require('WAWebUserPrefsMeUser').getMaybeMeLidUser();
                const user = pn?.user || lid?.user;
                if (user) {
                  return {
                    pushname: (window.require('WAWebConnModel')?.Conn?.pushname) || 'Admin',
                    phone: user
                  };
                }
              } catch (e) {}
              return null;
            });
            if (me) {
              clearInterval(global.authReadyCheck);
              console.log('🎉 WhatsApp Bot detected active session in browser!');
              status = 'CONNECTED';
              clientInfo = me;
              logActivity({ type: 'STATUS', status: 'CONNECTED', desc: 'Bot linked successfully' });
              broadcastStatus();
            }
          } catch (e) {}
        }
      }, 1500);
    });

    client.on('ready', () => {
      console.log('🎉 WhatsApp Bot is Ready and Connected!');
      status = 'CONNECTED';
      qrCodeDataUrl = null;
      rawQr = null;
      pairingCode = null;
      qrTimestamp = null;
      isInitializing = false;
      const me = client.info || {};
      clientInfo = {
        pushname: me.pushname || 'Admin',
        phone: me.wid?.user || 'Connected'
      };
      logActivity({ type: 'STATUS', status: 'CONNECTED', desc: 'Bot linked successfully' });
      broadcastStatus();
    });

    client.on('auth_failure', (msg) => {
      console.error('❌ Auth failure:', msg);
      status = 'AUTH_FAILURE';
      errorMessage = msg || 'Authentication failed';
      isInitializing = false;
      broadcastStatus();
      console.log('🧹 Cleaning invalid auth session and restarting for fresh QR in 3 seconds...');
      setTimeout(() => initClient({ forceClean: true }), 3000);
    });

    client.on('disconnected', (reason) => {
      console.log('⚠️ Disconnected:', reason);
      status = 'DISCONNECTED';
      clientInfo = null;
      isInitializing = false;
      logActivity({ type: 'STATUS', status: 'DISCONNECTED', desc: reason });
      broadcastStatus();
      const shouldClean = (reason === 'LOGOUT' || reason === 'NAVIGATION' || !reason);
      console.log(`🔄 Attempting automatic reconnection in 4 seconds (clean: ${shouldClean})...`);
      setTimeout(() => initClient({ forceClean: shouldClean }), 4000);
    });

    await client.initialize();
  } catch (err) {
    console.error('Client init error:', err.message);
    status = 'DISCONNECTED';
    isInitializing = false;
    errorMessage = err.message;
    broadcastStatus();
    if (retryCount < 3) {
      console.log(`🔄 Retrying WhatsApp engine initialization in 3 seconds (attempt ${retryCount + 1}/3)...`);
      setTimeout(() => initClient({ ...options, retryCount: retryCount + 1 }), 3000);
    }
  }

  return getStatus();
}

// API Routes
app.get('/api/whatsapp/status', (req, res) => {
  res.json(getStatus());
});

app.get('/api/whatsapp/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true'
  });
  res.write(`data: ${JSON.stringify(getStatus())}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/api/whatsapp/connect', async (req, res) => {
  const forceClean = req.body?.forceClean || false;
  initClient({ forceClean });
  res.json({ ok: true, message: 'Initialization started', ...getStatus() });
});

app.post('/api/whatsapp/refresh-qr', async (req, res) => {
  console.log('🔄 Refreshing WhatsApp QR Code...');
  initClient({ forceClean: false });
  res.json({ ok: true, message: 'Refreshing QR code', ...getStatus() });
});

app.post('/api/whatsapp/pair-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: 'Phone number required' });
  initClient({ forceClean: true, pairPhone: phone });
  res.json({ ok: true, message: 'Pairing requested' });
});

app.post('/api/whatsapp/disconnect', async (req, res) => {
  await handleDisconnect();
  res.json({ ok: true });
});

app.post('/api/whatsapp/restart', async (req, res) => {
  console.log('🔄 Restarting WhatsApp Bot engine with session preserved...');
  initClient({ forceRestart: true });
  res.json({ ok: true, message: 'Restarting WhatsApp engine with session preserved' });
});

app.post('/api/whatsapp/send-message', async (req, res) => {
  const { phone, text } = req.body;
  if (status !== 'CONNECTED' || !client) {
    return res.status(503).json({ ok: false, error: 'WhatsApp Bot not connected' });
  }
  const chatId = await resolveChatId(phone);
  if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid phone number' });

  try {
    const result = await safeClientSendMessage(chatId, text);
    logActivity({ type: 'MESSAGE', phone, status: 'SENT' });
    res.json({ ok: true, messageId: result?.id?._serialized || 'sent' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/whatsapp/send-invoice', async (req, res) => {
  const { phone, text, filename, pdfBase64, pdfUrl, caption } = req.body;
  if (status !== 'CONNECTED' || !client) {
    return res.status(503).json({ ok: false, error: 'WhatsApp Bot not connected' });
  }
  const chatId = await resolveChatId(phone);
  if (!chatId) return res.status(400).json({ ok: false, error: 'Invalid phone number' });

  let mediaSent = false;
  let textSent = false;
  let lastErr = null;

  let pdfData = pdfBase64;
  if (!pdfData && pdfUrl && typeof pdfUrl === 'string' && pdfUrl.startsWith('http')) {
    try {
      pdfData = await fetchPdfBase64FromUrl(pdfUrl);
    } catch (uErr) {
      console.warn('PDF download from URL note:', uErr.message);
    }
  }

  // 1. If PDF base64 is provided, try sending PDF document
  if (pdfData) {
    try {
      const docCaption = sanitizeCaption(caption || `📄 ${filename || 'Tax Invoice'} - Aaryan Aqua Needs`);
      await safeClientSendPdf(chatId, filename || 'Invoice.pdf', pdfData, docCaption);
      mediaSent = true;
      console.log(`📄 WhatsApp Invoice PDF document successfully delivered to +${phone}!`);
    } catch (mediaErr) {
      lastErr = mediaErr;
      console.warn(`⚠️ WhatsApp PDF media dispatch note for +${phone} (${mediaErr.message}). Automatically delivering complete text breakdown...`);
    }
  }

  // 2. Deliver complete text greeting, salutations & items breakdown
  if (text) {
    try {
      await safeClientSendMessage(chatId, text);
      textSent = true;
      console.log(`💬 WhatsApp Invoice complete text breakdown & Drive PDF link delivered to +${phone}!`);
    } catch (textErr) {
      lastErr = textErr;
      console.error(`❌ Send text error to +${phone}:`, textErr.message);
    }
  }

  if (mediaSent || textSent) {
    logActivity({
      type: mediaSent ? 'INVOICE_PDF' : 'MESSAGE',
      phone,
      filename: mediaSent ? filename : undefined,
      status: 'SENT'
    });
    return res.json({ ok: true, mediaSent, textSent });
  }

  res.status(500).json({ ok: false, error: lastErr ? lastErr.message : 'Failed to send WhatsApp invoice' });
});

app.get('/api/whatsapp/activity', (req, res) => {
  res.json(activityLogs);
});

// ============================================================================
// LOCAL MULTI-USER INSTANT SYNC ENGINE (< 2ms LOCAL / LAN SYNC & DISK PERSISTENCE)
// ============================================================================
app.get('/api/sync/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  syncSseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'SYNC_CONNECTED', timestamp: Date.now() })}\n\n`);

  req.on('close', () => {
    syncSseClients.delete(res);
  });
});

app.get('/api/sync/state', (req, res) => {
  try {
    const invoices = fs.existsSync(invoicesPath) ? JSON.parse(fs.readFileSync(invoicesPath, 'utf8') || '[]') : [];
    const products = fs.existsSync(productsPath) ? JSON.parse(fs.readFileSync(productsPath, 'utf8') || '[]') : [];
    const parties = fs.existsSync(partiesPath) ? JSON.parse(fs.readFileSync(partiesPath, 'utf8') || '[]') : [];
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8') || '{}') : {};
    res.json({ ok: true, invoices, products, parties, settings, timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/sync/push', (req, res) => {
  const { action, type, payload, senderId } = req.body;
  try {
    if (action === 'save_invoice' && payload?.invoice) {
      let invs = fs.existsSync(invoicesPath) ? JSON.parse(fs.readFileSync(invoicesPath, 'utf8') || '[]') : [];
      const idx = invs.findIndex(i => i && (i.id === payload.invoice.id || i.invoiceNo === payload.invoice.invoiceNo));
      if (idx > -1) invs[idx] = payload.invoice;
      else invs.push(payload.invoice);
      fs.writeFileSync(invoicesPath, JSON.stringify(invs, null, 2), 'utf8');
    }
    if (payload?.products && Array.isArray(payload.products)) {
      fs.writeFileSync(productsPath, JSON.stringify(payload.products, null, 2), 'utf8');
    }
    if (payload?.parties && Array.isArray(payload.parties)) {
      fs.writeFileSync(partiesPath, JSON.stringify(payload.parties, null, 2), 'utf8');
    }
    if (payload?.settings && typeof payload.settings === 'object') {
      fs.writeFileSync(settingsPath, JSON.stringify(payload.settings, null, 2), 'utf8');
    }
    if (action === 'delete_record') {
      if (payload?.type === 'invoice' || type === 'invoice') {
        let invs = fs.existsSync(invoicesPath) ? JSON.parse(fs.readFileSync(invoicesPath, 'utf8') || '[]') : [];
        const delId = String(payload?.id || payload?.recordId || '').trim().toLowerCase();
        const delNo = String(payload.invoiceNo || '').trim().toLowerCase();
        invs = invs.filter(i => {
          if (!i) return false;
          const iId = String(i.id || '').trim().toLowerCase();
          const iNo = String(i.invoiceNo || (i.details && i.details.invoiceNo) || '').trim().toLowerCase();
          if (delId && (iId === delId || iId.replace(/^inv_/, '') === delId.replace(/^inv_/, '') || iNo === delId || iNo.replace(/^#/, '') === delId)) return false;
          if (delNo && (iNo === delNo || iNo.replace(/^#/, '') === delNo.replace(/^#/, ''))) return false;
          return true;
        });
        fs.writeFileSync(invoicesPath, JSON.stringify(invs, null, 2), 'utf8');
      } else if (payload?.type === 'product' || type === 'product') {
        let prods = fs.existsSync(productsPath) ? JSON.parse(fs.readFileSync(productsPath, 'utf8') || '[]') : [];
        prods = prods.filter(p => p && p.id !== payload.id);
        fs.writeFileSync(productsPath, JSON.stringify(prods, null, 2), 'utf8');
      } else if (payload?.type === 'party' || type === 'party') {
        let parts = fs.existsSync(partiesPath) ? JSON.parse(fs.readFileSync(partiesPath, 'utf8') || '[]') : [];
        parts = parts.filter(p => p && p.id !== payload.id);
        fs.writeFileSync(partiesPath, JSON.stringify(parts, null, 2), 'utf8');
      }
    }
    // Broadcast mutation to all other connected clients immediately
    broadcastSyncMutation({ action, type, payload, senderId, timestamp: Date.now() });
    res.json({ ok: true, syncedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Serve full billing application (with built-in WhatsApp QR scanner modal)
app.use(express.static(__dirname));

// Standalone companion card
app.get('/companion', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aaryan Aqua Needs - WhatsApp Bot Companion</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 28px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    h2 { margin: 0 0 4px 0; color: #38bdf8; font-size: 20px; }
    p.sub { color: #94a3b8; font-size: 13px; margin: 0 0 20px 0; }
    .qr-box { background: #ffffff; padding: 14px; border-radius: 12px; display: inline-flex; justify-content: center; align-items: center; min-width: 250px; min-height: 250px; margin-bottom: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
    .qr-box img { width: 240px; height: 240px; display: block; }
    .status-pill { display: inline-flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
    .status-pill.connected { background: #064e3b; color: #34d399; }
    .status-pill.waiting { background: #451a03; color: #fbbf24; }
    .status-pill.loading { background: #1e3a8a; color: #60a5fa; }
    .btn { background: #0284c7; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 13px; transition: 0.2s; }
    .btn:hover { background: #0369a1; }
    .instructions { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px; text-align: left; font-size: 12px; color: #cbd5e1; margin-top: 16px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 36px; color: #22c55e; margin-bottom: 8px;"><i class="fa-brands fa-whatsapp"></i></div>
    <h2>Aaryan Aqua Needs</h2>
    <p class="sub">Office PC WhatsApp Bot Companion</p>

    <div id="status-pill" class="status-pill loading">
      <i class="fa-solid fa-spinner fa-spin"></i> <span id="status-text">Initializing WhatsApp Web...</span>
    </div>

    <div class="qr-box" id="qr-container">
      <div id="loading-spinner" style="color: #64748b;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><br><span style="font-size: 12px; display: block; margin-top: 8px;">Generating QR Code...</span></div>
      <img id="qr-image" style="display: none;" alt="WhatsApp QR Code">
    </div>

    <div id="connected-box" style="display: none; margin-bottom: 16px;">
      <div style="font-size: 40px; color: #22c55e; margin-bottom: 8px;"><i class="fa-solid fa-circle-check"></i></div>
      <h3 style="margin: 0; color: #34d399; font-size: 16px;">WhatsApp Successfully Linked!</h3>
      <p style="font-size: 12px; color: #94a3b8; margin: 4px 0 14px 0;" id="device-info">Invoices will now be sent automatically in background.</p>
      <button class="btn" onclick="disconnectBot()" style="background: #dc2626;"><i class="fa-solid fa-right-from-bracket"></i> Disconnect / Unlink</button>
    </div>

    <div style="display: flex; gap: 8px; justify-content: center; margin-bottom: 14px;" id="actions-bar">
      <button class="btn" onclick="forceRefreshQR()"><i class="fa-solid fa-rotate"></i> Refresh QR</button>
    </div>

    <div class="instructions">
      <strong>📲 How to Pair:</strong><br>
      1. Open <strong>WhatsApp</strong> on your phone.<br>
      2. Tap <strong>Menu (⋮)</strong> or <strong>Settings</strong> &gt; <strong>Linked Devices</strong>.<br>
      3. Tap <strong>Link a Device</strong> and point your camera at this QR code.<br>
      <em>(Session is saved permanently on this computer - you only scan once!)</em>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/api/whatsapp/status');
        const data = await res.json();
        const pill = document.getElementById('status-pill');
        const statusText = document.getElementById('status-text');
        const qrImg = document.getElementById('qr-image');
        const qrLoading = document.getElementById('loading-spinner');
        const qrContainer = document.getElementById('qr-container');
        const connectedBox = document.getElementById('connected-box');
        const actionsBar = document.getElementById('actions-bar');

        if (data.status === 'CONNECTED') {
          pill.className = 'status-pill connected';
          statusText.textContent = 'Active & Connected (' + (data.clientInfo?.phone ? '+' + data.clientInfo.phone : 'Bot') + ')';
          qrContainer.style.display = 'none';
          actionsBar.style.display = 'none';
          connectedBox.style.display = 'block';
          if (data.clientInfo?.pushname) {
            document.getElementById('device-info').textContent = 'Linked as ' + data.clientInfo.pushname + ' (+' + data.clientInfo.phone + '). Silent background dispatch is active!';
          }
        } else if (data.status === 'QR_READY' && data.qrCodeDataUrl) {
          pill.className = 'status-pill waiting';
          statusText.textContent = 'Point Phone Camera at QR Code';
          qrContainer.style.display = 'inline-flex';
          qrLoading.style.display = 'none';
          qrImg.src = data.qrCodeDataUrl;
          qrImg.style.display = 'block';
          connectedBox.style.display = 'none';
          actionsBar.style.display = 'flex';
        } else if (data.status === 'AUTHENTICATING') {
          pill.className = 'status-pill loading';
          statusText.textContent = 'Authenticating Session...';
          qrLoading.style.display = 'block';
          qrImg.style.display = 'none';
        } else {
          pill.className = 'status-pill loading';
          statusText.textContent = 'Starting WhatsApp Engine...';
          qrLoading.style.display = 'block';
          qrImg.style.display = 'none';
        }
      } catch (e) {}
    }

    async function forceRefreshQR() {
      try {
        await fetch('/api/whatsapp/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ forceClean: true })
        });
        checkStatus();
      } catch (e) {}
    }

    async function disconnectBot() {
      if (!confirm('Are you sure you want to disconnect WhatsApp?')) return;
      try {
        await fetch('/api/whatsapp/disconnect', { method: 'POST' });
        location.reload();
      } catch (e) {}
    }

    setInterval(checkStatus, 2000);
    checkStatus();
  </script>
</body>
</html>`);
});

// Start Server & Initialize Client
const server = app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 AARYAN AQUA NEEDS - WhatsApp Bot Companion Running!`);
  console.log(`📡 Web Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
  
  // Launch initial client
  initClient();

  // Launch Cloud Mesh MQTT Bridge
  initMqttBridge();

  // Only open browser if explicitly instructed via AUTO_OPEN='true' and not in daemon mode
  if (process.env.NO_AUTO_OPEN !== 'true' && process.env.DAEMON !== 'true' && process.env.AUTO_OPEN === 'true') {
    const startCmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${startCmd} http://localhost:${PORT}`);
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use by another WhatsApp Bot instance. Exiting duplicate process.`);
    process.exit(0);
  }
  console.error('Server error:', err);
});

function publishShutdownStatus() {
  if (mqttBridgeClient && mqttBridgeClient.connected) {
    try {
      mqttBridgeClient.publish(WA_STATUS_TOPIC, JSON.stringify({
        status: 'DISCONNECTED',
        isReady: false,
        lastHeartbeat: 0,
        timestamp: 0,
        desc: 'Bot host stopped'
      }), { qos: 1, retain: true });
    } catch (e) {}
  }
}
process.on('SIGINT', () => { publishShutdownStatus(); process.exit(0); });
process.on('SIGTERM', () => { publishShutdownStatus(); process.exit(0); });

