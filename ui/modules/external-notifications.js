const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');
const readline = require('readline');
const { URL } = require('url');

const DEFAULT_DEDUPE_WINDOW_MS = 30000;

function createExternalNotifier(options = {}) {
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => ({});
  const log = options.log || console;
  const appName = options.appName || 'SquidRun';
  const dedupeWindowMs = options.dedupeWindowMs || DEFAULT_DEDUPE_WINDOW_MS;
  const recentNotifications = new Map();

  function shouldSend(category, settings) {
    if (!settings.externalNotificationsEnabled) return false;
    if (category === 'alert' && settings.notifyOnAlerts === false) return false;
    if (category === 'completion' && settings.notifyOnCompletions === false) return false;
    return true;
  }

  function isDuplicate(key) {
    const now = Date.now();
    const last = recentNotifications.get(key);
    if (last && (now - last) < dedupeWindowMs) {
      return true;
    }
    recentNotifications.set(key, now);
    return false;
  }

  function formatMessage(payload) {
    const category = (payload.category || 'info').toUpperCase();
    const title = payload.title ? String(payload.title) : '';
    const message = payload.message ? String(payload.message) : '';
    const parts = [`${appName} ${category}${title ? `: ${title}` : ''}`];

    if (message && message !== title) {
      parts.push(message);
    }

    if (payload.meta) {
      if (payload.meta.paneId) {
        parts.push(`Pane: ${payload.meta.paneId}`);
      }
      if (payload.meta.state) {
        parts.push(`State: ${payload.meta.state}`);
      }
    }

    parts.push(`Time: ${new Date().toISOString()}`);
    return parts.join('\n');
  }

  function postJson(targetUrl, payload) {
    return new Promise((resolve) => {
      if (!targetUrl) {
        resolve({ success: false, error: 'missing_url' });
        return;
      }

      let url;
      try {
        url = new URL(targetUrl);
      } catch (_err) {
        resolve({ success: false, error: 'invalid_url' });
        return;
      }

      const data = JSON.stringify(payload);
      const client = url.protocol === 'http:' ? http : https;
      const req = client.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      }, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const success = res.statusCode >= 200 && res.statusCode < 300;
          resolve({ success, statusCode: res.statusCode });
        });
      });

      req.on('error', (err) => resolve({ success: false, error: err.message }));
      req.write(data);
      req.end();
    });
  }

  async function sendWebhookNotifications(settings, text) {
    const results = [];

    if (settings.slackWebhookUrl) {
      results.push({
        channel: 'slack',
        ...(await postJson(settings.slackWebhookUrl, { text })),
      });
    }

    if (settings.discordWebhookUrl) {
      results.push({
        channel: 'discord',
        ...(await postJson(settings.discordWebhookUrl, { content: text })),
      });
    }

    return results;
  }

  function readSmtpResponse(reader, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const lines = [];
      let timeout = null;

      const onLine = (line) => {
        lines.push(line);
        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve(lines);
        }
      };

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        reader.removeListener('line', onLine);
      };

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('SMTP timeout'));
      }, timeoutMs);

      reader.on('line', onLine);
    });
  }

  async function sendSmtpCommand(socket, reader, command, expectedCodes) {
    if (command) {
      socket.write(`${command}\r\n`);
    }

    const lines = await readSmtpResponse(reader);
    const last = lines[lines.length - 1] || '';
    const code = parseInt(last.slice(0, 3), 10);
    if (expectedCodes && !expectedCodes.includes(code)) {
      throw new Error(`SMTP unexpected response: ${last}`);
    }
    return { code, lines };
  }

  async function sendEmailNotification(settings, subject, body) {
    if (!settings.emailNotificationsEnabled) {
      return { success: false, skipped: true, reason: 'email_disabled' };
    }

    const host = settings.smtpHost;
    const from = settings.smtpFrom;
    const to = settings.smtpTo;

    if (!host || !from || !to) {
      return { success: false, skipped: true, reason: 'missing_email_config' };
    }

    const port = Number(settings.smtpPort) || (settings.smtpSecure ? 465 : 587);
    const secure = Boolean(settings.smtpSecure);
    const rejectUnauthorized = settings.smtpRejectUnauthorized !== false;
    const user = settings.smtpUser;
    const pass = settings.smtpPass;

    const recipients = String(to).split(',').map(v => v.trim()).filter(Boolean);
    if (recipients.length === 0) {
      return { success: false, skipped: true, reason: 'missing_recipients' };
    }

    return new Promise((resolve) => {
      const socket = secure
        ? tls.connect(port, host, { rejectUnauthorized })
        : net.connect(port, host);

      const reader = readline.createInterface({ input: socket });
      const hostname = os.hostname() || 'squidrun';

      const finalize = (result) => {
        try { reader.close(); } catch (_e) { /* ignore */ }
        try { socket.end(); } catch (_e) { /* ignore */ }
        resolve(result);
      };

      const run = async () => {
        try {
          await sendSmtpCommand(socket, reader, null, [220]);
          await sendSmtpCommand(socket, reader, `EHLO ${hostname}`, [250]);

          if (user && pass) {
            await sendSmtpCommand(socket, reader, 'AUTH LOGIN', [334]);
            await sendSmtpCommand(socket, reader, Buffer.from(user).toString('base64'), [334]);
            await sendSmtpCommand(socket, reader, Buffer.from(pass).toString('base64'), [235]);
          }

          await sendSmtpCommand(socket, reader, `MAIL FROM:<${from}>`, [250]);
          for (const recipient of recipients) {
            await sendSmtpCommand(socket, reader, `RCPT TO:<${recipient}>`, [250, 251]);
          }

          await sendSmtpCommand(socket, reader, 'DATA', [354]);

          const headers = [
            `From: ${from}`,
            `To: ${recipients.join(', ')}`,
            `Subject: ${subject}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=utf-8',
          ].join('\r\n');

          const message = `${headers}\r\n\r\n${body}\r\n.`;
          socket.write(`${message}\r\n`);

          await sendSmtpCommand(socket, reader, null, [250]);
          await sendSmtpCommand(socket, reader, 'QUIT', [221]);
          finalize({ success: true });
        } catch (err) {
          finalize({ success: false, error: err.message });
        }
      };

      socket.on('error', (err) => finalize({ success: false, error: err.message }));
      run();
    });
  }

  async function notify(payload = {}) {
    const settings = getSettings() || {};
    const category = payload.category || 'info';

    if (!shouldSend(category, settings)) {
      return { success: false, skipped: true, reason: 'disabled' };
    }

    const hasWebhook = Boolean(settings.slackWebhookUrl || settings.discordWebhookUrl);
    const hasEmail = Boolean(settings.emailNotificationsEnabled && settings.smtpHost && settings.smtpFrom && settings.smtpTo);
    if (!hasWebhook && !hasEmail) {
      return { success: false, skipped: true, reason: 'no_channels' };
    }

    const message = formatMessage(payload);
    const dedupeKey = `${category}|${payload.title || ''}|${payload.message || ''}`;
    if (isDuplicate(dedupeKey)) {
      return { success: false, skipped: true, reason: 'duplicate' };
    }

    const webhookResults = await sendWebhookNotifications(settings, message);
    const emailResult = await sendEmailNotification(
      settings,
      `[${appName}] ${payload.title || category.toUpperCase()}`,
      message
    );

    const results = [...webhookResults];
    if (!emailResult.skipped) {
      results.push({ channel: 'email', ...emailResult });
    }

    const success = results.some(r => r.success);
    if (!success) {
      log.warn('ExternalNotify', 'All external notifications failed or skipped', results);
    }

    return { success, results };
  }

  return { notify };
}

module.exports = {
  createExternalNotifier,
};
