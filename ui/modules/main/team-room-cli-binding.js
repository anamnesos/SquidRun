'use strict';

const { TelegramAdmissionWriter } = require('./telegram-admission-writer');
const { findActivePaneLaunch } = require('./telegram-launch-registry');
const { DEFAULT_PROFILE_NAME, DEFAULT_ROOM_MEMBERS, MEMBER_KINDS } = require('./team-room-contracts');

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PANE_LAUNCH_PATTERN = /^pl_[a-f0-9]{32}$/u;
const PROCESS_ID_PATTERN = /^[1-9][0-9]*$/u;

function createTeamRoomCliBindingResolver(options = {}) {
  const getProfileName = typeof options.getProfileName === 'function'
    ? options.getProfileName
    : () => 'main';
  const writerFactory = typeof options.writerFactory === 'function'
    ? options.writerFactory
    : () => new TelegramAdmissionWriter({});
  const lookupPaneLaunch = typeof options.lookupPaneLaunch === 'function'
    ? options.lookupPaneLaunch
    : findActivePaneLaunch;
  const getDaemonProcessId = typeof options.getDaemonProcessId === 'function'
    ? options.getDaemonProcessId
    : () => process.pid;

  return ({ appGeneration } = {}) => {
    const profileName = String(getProfileName() || '').trim().toLowerCase();
    if (!PROFILE_PATTERN.test(profileName)) {
      return { ok: false, reason: 'team_room_cli_profile_binding_invalid' };
    }
    if (profileName !== DEFAULT_PROFILE_NAME) {
      return { ok: false, reason: 'team_room_cli_profile_binding_mismatch' };
    }
    // A generation label is shared state, not process ownership. Recovery and
    // side-launch helpers can inherit it and leave newer incomplete rows behind.
    // The Team Room runtime may mint a CLI credential only for a pane launched
    // by the same app process that owns this runtime.
    const daemonProcessId = String(getDaemonProcessId() ?? '').trim();
    if (!PROCESS_ID_PATTERN.test(daemonProcessId)) {
      return { ok: false, reason: 'team_room_cli_daemon_binding_invalid' };
    }
    const writer = writerFactory();
    const opened = writer?.open?.();
    if (!opened?.ok || !writer.db) {
      writer?.close?.();
      return { ok: false, reason: 'team_room_cli_launch_registry_unavailable' };
    }
    try {
      const bindings = {};
      for (const member of DEFAULT_ROOM_MEMBERS.filter((candidate) => candidate.memberKind === MEMBER_KINDS.AGENT)) {
        const found = lookupPaneLaunch(writer.db, {
          appGeneration,
          paneId: String(member.paneId),
          daemonProcessId,
          allowIncomplete: true,
        });
        if (!found?.ok) {
          return {
            ok: false,
            reason: 'team_room_cli_launch_binding_unavailable',
            detail: { role: member.role, registryReason: found?.reason || 'unknown' },
          };
        }
        const paneLaunchId = String(found.launchId || '').trim();
        if (String(found.appGeneration) !== String(appGeneration)
          || String(found.paneId) !== String(member.paneId)
          || String(found.role).trim().toLowerCase() !== member.role
          || String(found.daemonProcessId) !== daemonProcessId
          || !PANE_LAUNCH_PATTERN.test(paneLaunchId)) {
          return {
            ok: false,
            reason: 'team_room_cli_launch_binding_mismatch',
            detail: { role: member.role },
          };
        }
        bindings[member.role] = Object.freeze({
          role: member.role,
          paneId: String(member.paneId),
          profileName,
          paneLaunchId,
          appGeneration: String(appGeneration),
        });
      }
      return { ok: true, profileName, bindings: Object.freeze(bindings) };
    } finally {
      writer.close();
    }
  };
}

module.exports = {
  PANE_LAUNCH_PATTERN,
  PROCESS_ID_PATTERN,
  PROFILE_PATTERN,
  createTeamRoomCliBindingResolver,
};
