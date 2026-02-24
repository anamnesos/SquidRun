const {
  parseCrossDeviceTarget,
  normalizeDeviceId,
  getLocalDeviceId,
  isCrossDeviceEnabled,
} = require('../modules/cross-device-target');

describe('cross-device-target parser', () => {
  test('parses valid @device-arch targets and enforces architect role', () => {
    expect(parseCrossDeviceTarget('@peer-arch')).toEqual({
      raw: '@peer-arch',
      toDevice: 'PEER',
      targetRole: 'architect',
    });

    expect(parseCrossDeviceTarget('@team_alpha-architect')).toEqual({
      raw: '@team_alpha-architect',
      toDevice: 'TEAM_ALPHA',
      targetRole: 'architect',
    });
  });

  test('accepts mixed-case targets and normalizes device id', () => {
    expect(parseCrossDeviceTarget('@Qa-Device_1-Arch')).toEqual({
      raw: '@Qa-Device_1-Arch',
      toDevice: 'QA-DEVICE_1',
      targetRole: 'architect',
    });
  });

  test('rejects non-architect role suffixes', () => {
    expect(parseCrossDeviceTarget('@peer-builder')).toBeNull();
    expect(parseCrossDeviceTarget('@peer-oracle')).toBeNull();
    expect(parseCrossDeviceTarget('@peer-devops')).toBeNull();
  });

  test('rejects malformed targets', () => {
    expect(parseCrossDeviceTarget('peer-arch')).toBeNull();
    expect(parseCrossDeviceTarget('@-arch')).toBeNull();
    expect(parseCrossDeviceTarget('@peer-architect-extra')).toBeNull();
    expect(parseCrossDeviceTarget('@peer arch-arch')).toBeNull();
    expect(parseCrossDeviceTarget('')).toBeNull();
    expect(parseCrossDeviceTarget(null)).toBeNull();
    expect(parseCrossDeviceTarget(undefined)).toBeNull();
  });

  test('normalizes device IDs and env helpers', () => {
    expect(normalizeDeviceId(' dev-01!* ')).toBe('DEV-01');
    expect(getLocalDeviceId({ SQUIDRUN_DEVICE_ID: ' team_2 ' })).toBe('TEAM_2');
    expect(isCrossDeviceEnabled({ SQUIDRUN_CROSS_DEVICE: '1' })).toBe(true);
    expect(isCrossDeviceEnabled({ SQUIDRUN_CROSS_DEVICE: '0' })).toBe(false);
  });
});
