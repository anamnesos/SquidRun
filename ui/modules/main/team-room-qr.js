'use strict';

const QRCode = require('qrcode');

const PAIRING_CODE_PATTERN = /^\d{6}$/u;

function buildPairingUrl(origin, code) {
  const pairingCode = String(code || '').trim();
  if (!PAIRING_CODE_PATTERN.test(pairingCode)) throw new Error('team_room_pairing_code_invalid');
  const url = new URL('/', String(origin || ''));
  url.hash = `pair=${pairingCode}`;
  return url.href;
}

async function renderPairingQrDataUrl(pairingUrl) {
  return QRCode.toDataURL(String(pairingUrl || ''), {
    errorCorrectionLevel: 'Q',
    margin: 2,
    width: 256,
    color: {
      dark: '#10151aff',
      light: '#ffffffff',
    },
  });
}

module.exports = {
  PAIRING_CODE_PATTERN,
  buildPairingUrl,
  renderPairingQrDataUrl,
};
