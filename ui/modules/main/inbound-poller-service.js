/**
 * Owns inbound channel poller lifecycle for the main process.
 *
 * This keeps SquidRunApp focused on message handling while giving pollers a
 * single boundary that can later move out of the Electron process.
 */

const smsPoller = require('../sms-poller');
const telegramPoller = require('../telegram-poller');

class InboundPollerService {
  constructor(dependencies = {}) {
    this.smsPoller = dependencies.smsPoller || smsPoller;
    this.telegramPoller = dependencies.telegramPoller || telegramPoller;
  }

  startSms(options = {}) {
    return this.smsPoller.start(options);
  }

  startTelegram(options = {}) {
    return this.telegramPoller.start(options);
  }

  stopSms() {
    if (this.smsPoller && typeof this.smsPoller.stop === 'function') {
      this.smsPoller.stop();
    }
  }

  stopTelegram() {
    if (this.telegramPoller && typeof this.telegramPoller.stop === 'function') {
      this.telegramPoller.stop();
    }
  }

  stopAll() {
    this.stopSms();
    this.stopTelegram();
  }
}

function createInboundPollerService(dependencies = {}) {
  return new InboundPollerService(dependencies);
}

module.exports = {
  InboundPollerService,
  createInboundPollerService,
};
