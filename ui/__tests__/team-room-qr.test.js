'use strict';

const { buildPairingUrl, renderPairingQrDataUrl } = require('../modules/main/team-room-qr');

describe('Team Room QR pairing transport', () => {
  test('puts the one-use code in a fragment instead of the request or referrer surface', () => {
    const pairingUrl = buildPairingUrl('http://192.168.0.200:9910', '123456');
    const parsed = new URL(pairingUrl);

    expect(parsed.origin).toBe('http://192.168.0.200:9910');
    expect(parsed.pathname).toBe('/');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('#pair=123456');
  });

  test('renders a self-contained offline PNG data URL', async () => {
    const pairingUrl = buildPairingUrl('http://192.168.0.200:9910', '654321');
    const qrDataUrl = await renderPairingQrDataUrl(pairingUrl);

    expect(qrDataUrl).toMatch(/^data:image\/png;base64,/u);
    expect(Buffer.from(qrDataUrl.split(',')[1], 'base64').subarray(0, 8))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  test('rejects malformed pairing codes before QR generation', () => {
    expect(() => buildPairingUrl('http://192.168.0.200:9910', '12345'))
      .toThrow('team_room_pairing_code_invalid');
  });
});
