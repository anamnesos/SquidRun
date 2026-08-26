'use strict';

const { EXPLICIT_ROOM_SOURCES } = require('./team-room-contracts');

class TeamRoomService {
  constructor(options = {}) {
    if (!options.store) throw new Error('team_room_service_store_required');
    if (!options.auth) throw new Error('team_room_service_auth_required');
    this.store = options.store;
    this.auth = options.auth;
  }

  _authenticate(request, capability) {
    const source = String(request?.source || '').trim().toLowerCase();
    if (!EXPLICIT_ROOM_SOURCES.has(source)) return { ok: false, reason: 'room_source_invalid' };
    const authenticated = this.auth.authenticateBearer(request.authorization, {
      requiredCapability: capability,
      roomId: request.roomId,
      profileName: request.profileName,
      source,
    });
    if (!authenticated.ok) return authenticated;
    return { ...authenticated, source };
  }

  post(request = {}) {
    const authenticated = this._authenticate(request, 'post');
    if (!authenticated.ok) return authenticated;
    return this.store.postMessage({
      identity: authenticated.identity,
      payload: request.payload,
    });
  }

  readMessages(request = {}) {
    const authenticated = this._authenticate(request, 'read');
    if (!authenticated.ok) return authenticated;
    return {
      ok: true,
      messages: this.store.listMessages(
        authenticated.identity.roomId,
        authenticated.identity.profileName,
        request.window || {}
      ),
      days: this.store.listMessageDays(
        authenticated.identity.roomId,
        authenticated.identity.profileName
      ),
    };
  }

  authorizeMedia(request = {}) {
    const authenticated = this._authenticate(request, 'media');
    if (!authenticated.ok) return authenticated;
    const verified = this.store.verifyReadyAttachment(request.attachmentId, authenticated.identity);
    if (!verified.ok) return verified;
    return { ok: true, attachment: verified.attachment };
  }
}

module.exports = { TeamRoomService };
