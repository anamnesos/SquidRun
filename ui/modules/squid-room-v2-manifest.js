'use strict';

/**
 * ROOM REMODEL v2 WHITELIST (S467 charter): the room renders ONLY what this
 * manifest declares. Anything outside it does not exist — ghosts die by
 * never being imported, not by being hunted. The whitelist contract test
 * (squid-room-v2-whitelist.test.js) fails on any undeclared room class.
 *
 * Owners add their layer's classes as v2 lands. Deleting a feature means
 * deleting its line here — the corpse cannot keep rendering.
 */

module.exports = Object.freeze({
  // Class PREFIXES owned by each layer (everything under a prefix is declared).
  prefixes: Object.freeze([
    'sr2-', // v2 presentation namespace (Architect sky/sections, Builder mount)
    'sr-speech-', // Oracle speech surfaces — whitelist-built, self-injected, audited S466
  ]),
  // Exact one-off classes allowed outside the prefixes (keep SHORT; every
  // entry here is a debt against the namespace rule).
  classes: Object.freeze([
    'squid-room-creature-ocean', // Builder's canvas layer mount point
  ]),
  // Source files whose room-scoped class literals the contract scans.
  presentationSources: Object.freeze([
    'ui/modules/squid-room-speech-system.js',
    'ui/styles/squid-room-v2.css', // Builder: tokens + 4-layer skeleton (mount step 1)
    // Builder adds the v2 shell/mount module here when the DOM rebuild lands.
    // Architect extends squid-room-v2.css with sky/shore skin (layer 1+4).
  ]),
});
