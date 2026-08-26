const {
  buildInjectMessageIpcPackets,
  splitUtf8TextByBytes,
  getUtf8ByteLength,
  DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
  DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES,
} = require('../modules/inject-message-ipc');

describe('inject-message-ipc', () => {
  test('splits utf8 text without breaking multi-byte characters', () => {
    const message = 'alpha-beta-gamma-🙂-delta';
    const pieces = splitUtf8TextByBytes(message, 8);

    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join('')).toBe(message);
    for (const piece of pieces) {
      expect(getUtf8ByteLength(piece)).toBeLessThanOrEqual(8);
    }
  });

  test('builds pane-specific packet groups before IPC for oversized messages', () => {
    const message = 'chunk-🙂-'.repeat(700);
    const packets = buildInjectMessageIpcPackets(
      {
        panes: ['1', '3'],
        message,
        deliveryId: 'delivery-123',
        meta: { source: 'test' },
      },
      {
        chunkThresholdBytes: 256,
        chunkSizeBytes: 256,
      }
    );

    expect(packets.length).toBeGreaterThan(2);

    const pane1Packets = packets.filter((packet) => packet.panes[0] === '1');
    const pane3Packets = packets.filter((packet) => packet.panes[0] === '3');
    expect(pane1Packets.length).toBeGreaterThan(1);
    expect(pane3Packets.length).toBe(pane1Packets.length);

    const pane1GroupId = pane1Packets[0].ipcChunk.groupId;
    const pane3GroupId = pane3Packets[0].ipcChunk.groupId;
    expect(pane1GroupId).not.toBe(pane3GroupId);

    const reconstructed = pane1Packets
      .sort((left, right) => left.ipcChunk.index - right.ipcChunk.index)
      .map((packet) => packet.message)
      .join('');

    expect(reconstructed).toBe(message);
    for (const packet of packets) {
      expect(packet.meta).toEqual(expect.objectContaining({
        source: 'test',
        ipcChunked: true,
        ipcOriginalBytes: getUtf8ByteLength(message),
      }));
      expect(packet.messageBytes).toBe(getUtf8ByteLength(packet.message));
      expect(packet.ipcChunk.chunkBytes).toBe(packet.messageBytes);
      expect(packet.ipcChunk.totalBytes).toBe(getUtf8ByteLength(message));
      expect(packet.messageBytes).toBeLessThanOrEqual(256);
    }
  });

  test('chunks exact-threshold messages by default to preserve delivery order', () => {
    const message = 'Z'.repeat(DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES);

    const packets = buildInjectMessageIpcPackets({
      panes: ['2'],
      message,
    });

    expect(packets).toHaveLength(1);
    expect(packets[0].ipcChunk).toEqual(expect.objectContaining({
      index: 0,
      count: 1,
      totalBytes: DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
    }));
    expect(packets[0].meta).toEqual(expect.objectContaining({
      ipcChunked: true,
      ipcOriginalBytes: DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES,
    }));
  });

  test('default IPC packet size stays within the PTY-safe write budget', () => {
    expect(DEFAULT_INJECT_IPC_CHUNK_THRESHOLD_BYTES).toBeLessThanOrEqual(256);
    expect(DEFAULT_INJECT_IPC_CHUNK_SIZE_BYTES).toBeLessThanOrEqual(256);

    const message = 'head-marker '.repeat(80);
    const packets = buildInjectMessageIpcPackets({
      panes: ['3'],
      message,
    });

    expect(packets.length).toBeGreaterThan(1);
    expect(packets.map((packet) => packet.message).join('')).toBe(message);
    for (const packet of packets) {
      expect(packet.messageBytes).toBeLessThanOrEqual(256);
    }
  });

  test.each([3900, 4096, 4100, 7500])(
    'preserves head/middle/tail sentinels across %i byte payloads',
    (targetBytes) => {
      const head = `HEAD-${targetBytes}-`;
      const middle = `-MIDDLE-${targetBytes}-`;
      const tail = `-TAIL-${targetBytes}`;
      const fillerBytes = targetBytes
        - Buffer.byteLength(head, 'utf8')
        - Buffer.byteLength(middle, 'utf8')
        - Buffer.byteLength(tail, 'utf8');
      const left = 'A'.repeat(Math.floor(fillerBytes / 2));
      const right = 'B'.repeat(Math.max(0, fillerBytes - left.length));
      const message = `${head}${left}${middle}${right}${tail}`;
      const packets = buildInjectMessageIpcPackets({
        panes: ['1'],
        message,
      });
      const reassembled = packets.map((packet) => packet.message).join('');

      expect(getUtf8ByteLength(message)).toBe(targetBytes);
      expect(reassembled).toBe(message);
      expect(reassembled.indexOf(head)).toBe(0);
      expect(reassembled.indexOf(middle)).toBeGreaterThan(0);
      expect(reassembled.endsWith(tail)).toBe(true);
      expect(packets.length).toBeGreaterThan(1);
      for (const packet of packets) {
        expect(packet.messageBytes).toBeLessThanOrEqual(256);
      }
    }
  );
});
