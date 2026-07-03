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
    // Link swap complete (mount step 3): the three legacy debt entries
    // (body gates + drawer pane) resolved - sr2-room is the only body gate.
  ]),
  // Source files whose room-scoped class literals the contract scans.
  presentationSources: Object.freeze([
    'ui/modules/squid-room-speech-system.js',
    'ui/styles/squid-room-v2.css', // Builder: tokens + 4-layer skeleton (mount step 1)
    'ui/modules/workspace-pane-shell.js', // Builder: v2 shell DOM (mount step 2)
    // Architect extends squid-room-v2.css with sky/shore skin (layer 1+4).
  ]),
});
