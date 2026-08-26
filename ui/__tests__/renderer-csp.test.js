const fs = require('fs');
const path = require('path');

describe('renderer content security policy', () => {
  test('allows voice broker and OpenAI Realtime fetches', () => {
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const match = indexHtml.match(/Content-Security-Policy" content="([^"]+)"/);

    expect(match).toBeTruthy();
    const csp = match[1];
    expect(csp).toContain('connect-src');
    expect(csp).toContain('ws://127.0.0.1:*');
    expect(csp).toContain('http://127.0.0.1:*');
    expect(csp).toContain('https://api.openai.com');
  });
});
