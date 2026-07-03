'use strict';

/**
 * Squid Room Speech System (wave 4) — Oracle-owned subsystem.
 *
 * ARCHITECTURAL INVERSION (James 00:21 / wave-4 addendum, row 73836):
 * the box is anchored to the VIEWPORT, the tail is anchored to the CREATURE.
 * The box position is solved as a viewport-constrained problem (flip+shift,
 * >=16px inside every edge — offscreen is mathematically impossible while
 * the viewport can hold the box). The tail is a chain of small rising
 * bubbles from the creature's mouth to the planted box, re-solved every
 * frame as the creature swims.
 *
 * HONESTY (cosmos constitution row 8): this module NEVER generates text.
 * It renders exactly what setSpeech() receives from the real face pipeline,
 * and the expanded state carries the verbatim raw line. Typewriter reveals
 * real text over time; reduced motion reveals it instantly.
 *
 * PERF LAW: all DOM nodes are created once per pet and pooled (fixed-size
 * bubble chain). The frame path allocates no objects and no closures; the
 * only unavoidable allocation while a message is actively typing is the
 * revealed-substring, which is small, bounded, and stops at full reveal.
 */

const SPEECH_INSET_PX = 16;
const SPEECH_GAP_PX = 22;
const TYPEWRITER_CHARS_PER_SEC = 35;
const CHAIN_DOT_COUNT = 7;
const SWAY_AMPLITUDE_PX = 2.4;
const SWAY_PERIOD_MS = 4200;
const GLIDE_EASE_PER_SEC = 6; // exponential approach rate toward solved spot
// Polish lane (James 10:49): boxes have weight, tails flow.
const SOLVE_DEADBAND_PX = 28; // anchor must move this far to trigger a re-solve
const MOUTH_SMOOTH_PER_SEC = 14; // chain-base lerp: tracks swimming, absorbs facing flips
const DOT_FLOW_PER_SEC = 10; // dot render-state approach rate toward layout

/**
 * Pure viewport solver — the testable heart of the system.
 * Picks the opening quadrant from where the anchor sits (left half opens
 * rightward, near-top opens below), then shift-clamps fully inside the
 * inset frame. Returns coordinates for the box's top-left corner.
 */
const BODY_EXCLUSION_PAD_PX = 44;

function rectIntersectsPad(x, y, boxW, boxH, anchorX, anchorY, pad) {
  return x < anchorX + pad
    && x + boxW > anchorX - pad
    && y < anchorY + pad
    && y + boxH > anchorY - pad;
}

function rectIntersectsRect(x, y, w, h, r) {
  return r && x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y;
}

/**
 * LAST-LINE JARGON GUARD (defense-in-depth, S463: the typewriter spoke a
 * commit hash to James). The face pipeline de-jargonizes upstream; this
 * guard makes the FACE structurally unable to speak machine identifiers
 * even if that wiring regresses. It strips — it NEVER invents; if stripping
 * empties the line, the bubble simply doesn't show (fail-dark for text).
 */
function sanitizeSpeechText(value) {
  return String(value || '')
    // shell-escape artifact from hm-send payloads: '\'' is an escaped
    // apostrophe, not speech ("label'\''s offsets" on a live face)
    .replace(/'\\''/g, "'")
    .replace(/\bsha256[:=]?\s*[0-9a-f]{8,64}\b/gi, '')
    .replace(/\b(?=[0-9a-f]{7,40}\b)[a-f]*\d[0-9a-f]*\b/g, '')
    .replace(/(?:[A-Za-z]:)?(?:[\w.-]+[\\/]){1,}[\w.-]+\.\w{1,6}\b/g, '')
    // bare filenames without a path prefix (verify-frame 1 left "capture-.png"
    // debris after the hex strip ate the digits)
    .replace(/\b[\w.-]+\.(?:png|jpe?g|gif|md|js|ts|tsx|json|css|html|txt|log|pdf|woff2?)\b/gi, '')
    .replace(/\.squidrun\/[\w/.-]+/g, '')
    .replace(/\bwi-[a-z0-9][\w-]{5,}\b/gi, '')
    .replace(/\bhm-\d{10,}-[a-z0-9]+\b/gi, '')
    .replace(/\b(?:rowId|messageId|deliveryId)\s*[:#=]?\s*[A-Za-z0-9._:-]+\b/gi, '')
    // Husk removal (drop the CLAUSE, not just the token): slash-number runs
    // left by stripped filenames ("/ 133332 / 153552"), dangling slashes,
    // and parentheticals reduced to digits/punctuation with no letters.
    .replace(/(?:\s*\/\s*\d{4,}\b)+/g, '')
    .replace(/\s*\/\s*(?=[,.;:)\s]|$)/g, '')
    .replace(/\(\s*[\d\s/\\.,:;·–—-]*\s*\)/g, '')
    .replace(/\(\s*[,:;-]*\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function solveSpeechBox(input = {}) {
  const inset = Number.isFinite(input.inset) ? input.inset : SPEECH_INSET_PX;
  const gap = Number.isFinite(input.gap) ? input.gap : SPEECH_GAP_PX;
  const pad = Number.isFinite(input.bodyPad) ? input.bodyPad : BODY_EXCLUSION_PAD_PX;
  const viewportW = Math.max(0, Number(input.viewportW) || 0);
  const viewportH = Math.max(0, Number(input.viewportH) || 0);
  const boxW = Math.max(0, Number(input.boxW) || 0);
  const boxH = Math.max(0, Number(input.boxH) || 0);
  const anchorX = Number(input.anchorX) || 0;
  const anchorY = Number(input.anchorY) || 0;

  const preferRight = anchorX < viewportW / 2;
  const preferBelow = anchorY < Math.max(inset + boxH + gap, viewportH * 0.28);

  const maxX = viewportW - inset - boxW;
  const maxY = viewportH - inset - boxH;
  const clampX = (v) => Math.min(Math.max(v, inset), Math.max(inset, maxX));
  const clampY = (v) => Math.min(Math.max(v, inset), Math.max(inset, maxY));
  const effGap = Math.max(gap, pad);

  // Floating-ui-style fallback chain: preferred quadrant first, then flips.
  // CONTAINMENT ALWAYS WINS over body exclusion — the never-offscreen
  // guarantee is the contract; staying out of the creature bodies
  // (cross-review finding + directive: a box may never cover a creature,
  // especially not its own speaker) is best-effort within it.
  const avoidRects = Array.isArray(input.avoidRects) ? input.avoidRects : null;
  let chosen = null;
  let first = null;
  const isClear = (x, y) => {
    if (rectIntersectsPad(x, y, boxW, boxH, anchorX, anchorY, pad)) return false;
    if (avoidRects) {
      for (let i = 0; i < avoidRects.length; i += 1) {
        if (rectIntersectsRect(x, y, boxW, boxH, avoidRects[i])) return false;
      }
    }
    return true;
  };
  // Least-harm score for blocked-everywhere geometry (the 10:07 face-landing:
  // every candidate blocked -> old code took `first` blindly, which can PARK
  // on the other creature's face). Weighted overlap area: rects carry
  // `weight` (own body cheap, other creatures expensive) so a forced
  // compromise leans onto the speaker's own tentacles, never a face.
  const harmOf = (x, y) => {
    let harm = 0;
    if (avoidRects) {
      for (let i = 0; i < avoidRects.length; i += 1) {
        const r = avoidRects[i];
        const ox = Math.min(x + boxW, r.x + r.w) - Math.max(x, r.x);
        const oy = Math.min(y + boxH, r.y + r.h) - Math.max(y, r.y);
        if (ox > 0 && oy > 0) harm += ox * oy * (r.weight || 1);
      }
    }
    return harm;
  };
  const recordHarm = (x, y, horiz, vert) => {
    const harm = harmOf(x, y);
    if (!first.leastHarm || harm < first.leastHarm.harm) {
      first.leastHarm = { x, y, opensRight: horiz, opensBelow: vert, harm };
    }
  };
  for (const horiz of [preferRight, !preferRight]) {
    for (const vert of [preferBelow, !preferBelow]) {
      let x = clampX(horiz ? anchorX + effGap : anchorX - effGap - boxW);
      let y = clampY(vert ? anchorY + effGap : anchorY - effGap - boxH);
      if (!first) first = { x, y, opensRight: horiz, opensBelow: vert };
      // Score the PRE-slide position too: a slide can push DEEPER into a
      // large rect, and the un-slid spot may be the least-harmful of all.
      if (!isClear(x, y)) recordHarm(x, y, horiz, vert);
      // SLIDE-OUT: fixed anchor offsets aren't enough when a body rect
      // extends past the gap — push the box beyond every blocking rect's
      // edge in the opening direction, then re-clamp and recheck.
      if (!isClear(x, y) && avoidRects) {
        let slidX = x;
        for (let i = 0; i < avoidRects.length; i += 1) {
          const r = avoidRects[i];
          if (!rectIntersectsRect(slidX, y, boxW, boxH, r)) continue;
          slidX = horiz ? r.x + r.w + 8 : r.x - boxW - 8;
        }
        slidX = clampX(slidX);
        if (isClear(slidX, y)) {
          x = slidX;
        } else {
          let slidY = y;
          for (let i = 0; i < avoidRects.length; i += 1) {
            const r = avoidRects[i];
            if (!rectIntersectsRect(x, slidY, boxW, boxH, r)) continue;
            slidY = vert ? r.y + r.h + 8 : r.y - boxH - 8;
          }
          slidY = clampY(slidY);
          if (isClear(x, slidY)) y = slidY;
        }
      }
      if (isClear(x, y)) {
        chosen = { x, y, opensRight: horiz, opensBelow: vert };
        break;
      }
      // Blocked after slide: remember the least-harmful spot seen so far.
      recordHarm(x, y, horiz, vert);
    }
    if (chosen) break;
  }
  // CORNER ESCAPE HATCHES: when every anchor-derived candidate is blocked
  // (creatures parked mid-room), the viewport corners are the spots most
  // likely to be clear — a long chain to a far corner beats a face-landing.
  if (!chosen) {
    const cx = [inset, Math.max(inset, maxX)];
    const cy = [inset, Math.max(inset, maxY)];
    for (let i = 0; i < 2 && !chosen; i += 1) {
      for (let j = 0; j < 2 && !chosen; j += 1) {
        const horiz = i === 0; // left corners "open rightward"
        if (isClear(cx[i], cy[j])) chosen = { x: cx[i], y: cy[j], opensRight: horiz, opensBelow: j === 0 };
        else recordHarm(cx[i], cy[j], horiz, j === 0);
      }
    }
  }
  const result = chosen || first.leastHarm || first;

  return {
    x: result.x,
    y: result.y,
    opensRight: result.opensRight,
    opensBelow: result.opensBelow,
    clearsBody: chosen !== null,
    contained: boxW + inset * 2 <= viewportW && boxH + inset * 2 <= viewportH,
  };
}

/** Deterministic per-dot bob phase — no randomness, stable across frames. */
function chainDotPhase(index) {
  return (index * 0.83) % (Math.PI * 2);
}

/**
 * Fills `out` (a pooled array of {x,y,scale}) with chain dot positions along
 * a gentle quadratic arc from the mouth to the box tail point. Zero alloc:
 * mutates the pooled entries in place.
 */
function layoutChainDots(out, mouthX, mouthY, tailX, tailY, nowMs, reducedMotion) {
  const count = out.length;
  // Control point bows the chain slightly upward (bubbles rise).
  const cx = (mouthX + tailX) / 2;
  const cy = Math.min(mouthY, tailY) - 26;
  for (let i = 0; i < count; i += 1) {
    const t = (i + 1) / (count + 1);
    const omt = 1 - t;
    let x = omt * omt * mouthX + 2 * omt * t * cx + t * t * tailX;
    let y = omt * omt * mouthY + 2 * omt * t * cy + t * t * tailY;
    if (!reducedMotion) {
      const phase = chainDotPhase(i) + (nowMs / 900);
      x += Math.sin(phase) * 1.6;
      y += Math.cos(phase * 0.8) * 1.2;
    }
    const dot = out[i];
    dot.x = x;
    dot.y = y;
    dot.scale = 0.55 + t * 0.65; // grows toward the box, classic idiom
  }
}

const SPEECH_STYLE_ID = 'squid-room-speech-system-style';
const SPEECH_CSS = `
.sr-speech-layer { position: absolute; inset: 0; pointer-events: none; z-index: 6; }
.sr-speech-box {
  position: absolute; left: 0; top: 0; max-width: 340px; min-width: 60px;
  padding: 10px 14px 11px; pointer-events: auto; cursor: default;
  color: rgba(224, 252, 248, 0.94); font-size: 13px; line-height: 1.45;
  background: rgba(7, 16, 27, 0.88);
  border: 1px solid rgba(94, 234, 212, 0.30);
  border-radius: 3px;
  /* pixel-skin: stepped corner notches, no smooth curves */
  clip-path: polygon(
    0 6px, 3px 6px, 3px 3px, 6px 3px, 6px 0,
    calc(100% - 6px) 0, calc(100% - 6px) 3px, calc(100% - 3px) 3px, calc(100% - 3px) 6px, 100% 6px,
    100% calc(100% - 6px), calc(100% - 3px) calc(100% - 6px), calc(100% - 3px) calc(100% - 3px), calc(100% - 6px) calc(100% - 3px), calc(100% - 6px) 100%,
    6px 100%, 6px calc(100% - 3px), 3px calc(100% - 3px), 3px calc(100% - 6px), 0 calc(100% - 6px)
  );
  box-shadow: 0 0 18px rgba(94, 234, 212, 0.10), inset 0 0 12px rgba(94, 234, 212, 0.05);
  will-change: transform; transition: opacity 240ms ease;
}
.sr-speech-box[data-visible="false"] { opacity: 0; pointer-events: none; }
.sr-speech-box[data-pet="oracle"] { border-color: rgba(192, 132, 252, 0.32); }
.sr-speech-cursor {
  display: inline-block; width: 7px; height: 13px; margin-left: 2px;
  vertical-align: -2px; background: rgba(94, 234, 212, 0.85);
}
.sr-speech-box[data-pet="oracle"] .sr-speech-cursor { background: rgba(192, 132, 252, 0.85); }
.sr-speech-box[data-typing="false"] .sr-speech-cursor { display: none; }
@keyframes sr-cursor-glint { 0%, 45% { opacity: 1; } 55%, 100% { opacity: 0.15; } }
.sr-speech-cursor { animation: sr-cursor-glint 0.9s steps(2, start) infinite; }
.sr-speech-full { display: none; }
.sr-speech-raw {
  display: none; margin-top: 8px; padding-top: 7px;
  border-top: 1px dashed rgba(94, 234, 212, 0.22);
  font-family: var(--squid-room-mono-font, monospace); font-size: 11px;
  color: rgba(170, 210, 205, 0.72); word-break: break-word;
}
.sr-speech-box.is-expanded { max-width: 480px; z-index: 7; }
.sr-speech-box.is-expanded .sr-speech-text { display: none; }
.sr-speech-box.is-expanded .sr-speech-full { display: block; }
.sr-speech-box.is-expanded .sr-speech-raw[data-has-raw="true"] { display: block; }
.sr-speech-dot {
  position: absolute; left: 0; top: 0; width: 7px; height: 7px;
  border-radius: 999px; pointer-events: none;
  background: rgba(168, 255, 244, 0.55);
  box-shadow: 0 0 7px rgba(114, 240, 224, 0.45);
  will-change: transform; image-rendering: pixelated;
}
.sr-speech-dot[data-pet="oracle"] { background: rgba(216, 180, 254, 0.55); box-shadow: 0 0 7px rgba(192, 132, 252, 0.45); }
@media (prefers-reduced-motion: reduce) {
  .sr-speech-cursor { animation: none; opacity: 1; }
  .sr-speech-box { transition: none; }
}
`;

function ensureSpeechStyle(doc) {
  if (!doc || doc.getElementById?.(SPEECH_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = SPEECH_STYLE_ID;
  style.textContent = SPEECH_CSS;
  doc.head?.appendChild?.(style);
}

function createSquidRoomSpeechSystem(options = {}) {
  const layerEl = options.layerEl || null;
  const doc = options.document || layerEl?.ownerDocument || (typeof document !== 'undefined' ? document : null);
  let reducedMotion = options.reducedMotion === true;
  let viewportW = Math.max(0, Number(options.viewportW) || layerEl?.clientWidth || 0);
  let viewportH = Math.max(0, Number(options.viewportH) || layerEl?.clientHeight || 0);

  ensureSpeechStyle(doc);

  /** @type {Map<string, ReturnType<typeof buildPetEntry>>} */
  const pets = new Map();
  /** Pooled avoid-rect scratch — reused every frame, zero alloc. */
  const avoidPool = [];

  function buildPetEntry(petId) {
    const box = doc.createElement('div');
    box.className = 'sr-speech-box';
    box.dataset.pet = petId;
    box.dataset.visible = 'false';
    box.dataset.typing = 'false';
    const text = doc.createElement('span');
    text.className = 'sr-speech-text';
    const cursor = doc.createElement('span');
    cursor.className = 'sr-speech-cursor';
    const full = doc.createElement('div');
    full.className = 'sr-speech-full';
    const raw = doc.createElement('div');
    raw.className = 'sr-speech-raw';
    raw.dataset.hasRaw = 'false';
    box.appendChild(text);
    box.appendChild(cursor);
    box.appendChild(full);
    box.appendChild(raw);
    box.addEventListener('mouseenter', () => box.classList.add('is-expanded'));
    box.addEventListener('mouseleave', () => box.classList.remove('is-expanded'));
    layerEl?.appendChild?.(box);

    const dots = [];
    const dotStates = [];
    const dotRender = [];
    for (let i = 0; i < CHAIN_DOT_COUNT; i += 1) {
      const dot = doc.createElement('div');
      dot.className = 'sr-speech-dot';
      dot.dataset.pet = petId;
      dot.style.opacity = '0';
      layerEl?.appendChild?.(dot);
      dots.push(dot);
      dotStates.push({ x: 0, y: 0, scale: 1 });
      dotRender.push({ x: 0, y: 0, scale: 1, opacity: 0 });
    }

    return {
      petId,
      box,
      textEl: text,
      fullEl: full,
      rawEl: raw,
      dots,
      dotStates,
      dotRender,
      faceText: '',
      fullText: '',
      rawText: '',
      rowIdentity: '',
      revealedChars: 0,
      typingDone: true,
      lastFrameMs: NaN,
      // planted position (current, eased) and solved target
      posX: 0,
      posY: 0,
      targetX: 0,
      targetY: 0,
      hasPosition: false,
      visible: false,
      swayPhase: petId === 'oracle' ? Math.PI : 0,
      // Hysteresis memory (James: collision flicker): the anchor/dims that
      // produced the current solve. Re-solve only on real change.
      solveAnchorX: NaN,
      solveAnchorY: NaN,
      lastBoxW: 0,
      lastBoxH: 0,
      // Smoothed mouth (James: tail jank): absorbs facing-flip teleports.
      mouthSX: NaN,
      mouthSY: NaN,
      // Seniority for asymmetric box avoidance: junior boxes yield to
      // senior ones; seniors ignore junior BOXES (still avoid creatures).
      // Mutual dodging is what made two boxes thrash.
      priority: pets.size,
    };
  }

  function ensurePet(petId) {
    let entry = pets.get(petId);
    if (!entry) {
      entry = buildPetEntry(petId);
      pets.set(petId, entry);
    }
    return entry;
  }

  function setViewport(width, height) {
    viewportW = Math.max(0, Number(width) || 0);
    viewportH = Math.max(0, Number(height) || 0);
  }

  function setReducedMotion(value) {
    reducedMotion = value === true;
  }

  /**
   * Feed REAL text from the face pipeline. Same rowIdentity = no restart
   * (idempotent — exactly-once consumption at this seam); new identity
   * restarts the typewriter from zero.
   * @param {string} petId
   * @param {import('../types/contracts').SpeechPayload} [payload]
   */
  function setSpeech(petId, payload = {}) {
    const entry = ensurePet(petId);
    const rowIdentity = String(payload.rowIdentity || '');
    // Last-line guard: strip, never invent. Empty after stripping = silent.
    const face = sanitizeSpeechText(payload.face);
    if (!face) {
      entry.visible = false;
      entry.box.dataset.visible = 'false';
      return;
    }
    if (rowIdentity && rowIdentity === entry.rowIdentity) return;
    entry.rowIdentity = rowIdentity;
    // Single-frame settle (Builder's cross-review): a NEW message must SNAP
    // to its freshly-solved spot on its first frame — gliding from the old
    // message's position drew the chain to a box still in flight.
    entry.hasPosition = false;
    entry.faceText = face;
    entry.fullText = String(payload.full || face);
    entry.rawText = String(payload.raw || '');
    entry.revealedChars = reducedMotion ? face.length : 0;
    entry.typingDone = reducedMotion;
    entry.visible = true;
    entry.box.dataset.visible = 'true';
    entry.box.dataset.typing = entry.typingDone ? 'false' : 'true';
    entry.textEl.textContent = reducedMotion ? face : '';
    entry.fullEl.textContent = entry.fullText;
    entry.rawEl.textContent = entry.rawText;
    entry.rawEl.dataset.hasRaw = entry.rawText && entry.rawText !== entry.fullText ? 'true' : 'false';
  }

  /**
   * Advance one frame. Missing anchor for a visible pet = fail-dark.
   * @param {number} nowMs
   * @param {import('../types/contracts').CreatureAnchors} [anchors]
   */
  function frame(nowMs, anchors = {}) {
    for (const entry of pets.values()) {
      const anchor = anchors[entry.petId];
      if (!entry.visible || !anchor) {
        // fail-dark: no anchor -> hide, never guess (instant, honesty first)
        entry.box.dataset.visible = 'false';
        for (let i = 0; i < entry.dots.length; i += 1) {
          entry.dots[i].style.opacity = '0';
          if (entry.dotRender[i]) entry.dotRender[i].opacity = 0;
        }
        continue;
      }
      entry.box.dataset.visible = 'true';

      // NaN sentinel (not 0): a first frame at t=0 is a real frame with no
      // predecessor — `> 0` here was a live bug my own contract caught.
      const rawDtSec = Number.isFinite(entry.lastFrameMs)
        ? Math.max(0, (nowMs - entry.lastFrameMs) / 1000)
        : 0;
      // Physics (glide) clamps big gaps; the TYPEWRITER must not — after a
      // stalled tab the text catches up instead of crawling.
      const dtSec = Math.min(0.25, rawDtSec);
      entry.lastFrameMs = nowMs;

      // Typewriter — driven by frame time, no timers.
      if (!entry.typingDone) {
        entry.revealedChars = Math.min(
          entry.faceText.length,
          entry.revealedChars + rawDtSec * TYPEWRITER_CHARS_PER_SEC
        );
        const shown = Math.floor(entry.revealedChars);
        entry.textEl.textContent = entry.faceText.slice(0, shown);
        if (shown >= entry.faceText.length) {
          entry.typingDone = true;
          entry.box.dataset.typing = 'false';
        }
      }

      // Solve the planted spot from the CURRENT box size (expanded inherits).
      const mouthX = Number(anchor.mouthX ?? anchor.headX) || 0;
      const mouthY = Number(anchor.mouthY ?? anchor.headY) || 0;
      const boxW = entry.box.offsetWidth || 0;
      const boxH = entry.box.offsetHeight || 0;
      // A box may never cover ANY creature — and (verify-frame 1) never
      // another pet's box either. Collect every anchor's body rect plus the
      // OTHER pets' current box rects (pooled — entries mutated in place).
      let avoidCount = 0;
      for (const key in anchors) {
        const a = anchors[key];
        if (!a || !Number.isFinite(a.bodyX)) continue;
        const slot = avoidPool[avoidCount] || (avoidPool[avoidCount] = { x: 0, y: 0, w: 0, h: 0, weight: 1 });
        slot.x = a.bodyX; slot.y = a.bodyY; slot.w = a.bodyW; slot.h = a.bodyH;
        // Least-harm weights: when geometry forces contact, land on the
        // speaker's own tentacles (1) before the OTHER creature's face (3).
        slot.weight = key === entry.petId ? 1 : 3;
        avoidCount += 1;
      }
      for (const other of pets.values()) {
        if (other === entry || !other.visible || !other.hasPosition) continue;
        // ASYMMETRIC YIELD (James: collision flicker): only JUNIOR boxes
        // dodge senior boxes. Mutual dodging re-solved both every frame and
        // they thrashed; with seniority exactly one box ever has the duty
        // to move, so a stable arrangement always exists.
        if (other.priority > entry.priority) continue;
        const slot = avoidPool[avoidCount] || (avoidPool[avoidCount] = { x: 0, y: 0, w: 0, h: 0, weight: 1 });
        slot.x = other.posX; slot.y = other.posY;
        slot.w = other.box.offsetWidth || 0; slot.h = other.box.offsetHeight || 0;
        slot.weight = 2;
        avoidCount += 1;
      }
      avoidPool.length = avoidCount;

      // Is the CURRENT planted spot actually blocked right now?
      let blocked = false;
      if (entry.hasPosition) {
        for (let i = 0; i < avoidCount; i += 1) {
          if (rectIntersectsRect(entry.posX, entry.posY, boxW, boxH, avoidPool[i])) { blocked = true; break; }
        }
      }

      // HYSTERESIS (James: 'flickering shaking like crazy'): the solve has
      // MEMORY. Re-solve only when something real changed — anchor moved
      // past the deadband, box resized (expand), or the planted spot is
      // hard-blocked. Otherwise the box keeps its ground: weight, not jitter.
      const dimsChanged = boxW !== entry.lastBoxW || boxH !== entry.lastBoxH;
      const anchorMoved = !Number.isFinite(entry.solveAnchorX)
        || Math.abs(mouthX - entry.solveAnchorX) > SOLVE_DEADBAND_PX
        || Math.abs(mouthY - entry.solveAnchorY) > SOLVE_DEADBAND_PX;
      if (!entry.hasPosition || dimsChanged || anchorMoved || blocked) {
        const solved = solveSpeechBox({
          anchorX: mouthX, anchorY: mouthY, boxW, boxH, viewportW, viewportH,
          avoidRects: avoidCount ? avoidPool : null,
        });
        entry.targetX = solved.x;
        entry.targetY = solved.y;
        entry.solveAnchorX = mouthX;
        entry.solveAnchorY = mouthY;
        entry.lastBoxW = boxW;
        entry.lastBoxH = boxH;
      }
      if (!entry.hasPosition || reducedMotion) {
        entry.posX = entry.targetX;
        entry.posY = entry.targetY;
        entry.hasPosition = true;
      } else {
        // Eased glide toward the solved spot — planted, never jumpy. BUT if
        // the CURRENT spot is actually blocked (a creature swam into the
        // box — 3-frame verification caught the slow-eviction brush), evict
        // with urgency: calm glide is for aesthetics, not for violations.
        const rate = blocked ? GLIDE_EASE_PER_SEC * 4 : GLIDE_EASE_PER_SEC;
        const k = Math.min(1, rate * dtSec);
        entry.posX += (entry.targetX - entry.posX) * k;
        entry.posY += (entry.targetY - entry.posY) * k;
      }

      let sway = 0;
      if (!reducedMotion) {
        sway = Math.sin((nowMs / SWAY_PERIOD_MS) * Math.PI * 2 + entry.swayPhase) * SWAY_AMPLITUDE_PX;
      }
      entry.box.style.transform = `translate3d(${entry.posX}px, ${entry.posY + sway}px, 0)`;

      // SMOOTHED MOUTH (James: tail jank): the raw mouth anchor teleports
      // ~12px*scale on a facing flip; the chain base must not. Lerp fast
      // enough to track swimming, slow enough to absorb the flip.
      if (!Number.isFinite(entry.mouthSX) || reducedMotion) {
        entry.mouthSX = mouthX;
        entry.mouthSY = mouthY;
      } else {
        const mk = Math.min(1, MOUTH_SMOOTH_PER_SEC * dtSec);
        entry.mouthSX += (mouthX - entry.mouthSX) * mk;
        entry.mouthSY += (mouthY - entry.mouthSY) * mk;
      }

      // Chain: mouth -> nearest point on the box edge facing the anchor.
      const tailX = Math.min(Math.max(entry.mouthSX, entry.posX), entry.posX + boxW);
      const tailY = entry.posY + boxH / 2 <= entry.mouthSY ? entry.posY + boxH : entry.posY;
      layoutChainDots(entry.dotStates, entry.mouthSX, entry.mouthSY, tailX, tailY, nowMs, reducedMotion);
      // DOTS FLOW (James: 'go in and out, weird positions'): render state
      // lerps toward the layout, opacity eases in — dots move like beads on
      // a string instead of popping to freshly computed spots.
      const dk = reducedMotion ? 1 : Math.min(1, DOT_FLOW_PER_SEC * dtSec);
      for (let i = 0; i < entry.dots.length; i += 1) {
        const s = entry.dotStates[i];
        const r = entry.dotRender[i];
        if (r.opacity <= 0.001) { r.x = s.x; r.y = s.y; r.scale = s.scale; } // invisible dots snap
        r.x += (s.x - r.x) * dk;
        r.y += (s.y - r.y) * dk;
        r.scale += (s.scale - r.scale) * dk;
        r.opacity += (1 - r.opacity) * dk;
        const dot = entry.dots[i];
        dot.style.opacity = r.opacity.toFixed(3);
        dot.style.transform = `translate3d(${r.x}px, ${r.y}px, 0) scale(${r.scale})`;
      }
    }
  }

  function destroy() {
    for (const entry of pets.values()) {
      entry.box.remove?.();
      for (const dot of entry.dots) dot.remove?.();
    }
    pets.clear();
  }

  return {
    setSpeech,
    frame,
    setViewport,
    setReducedMotion,
    destroy,
    _pets: pets, // exposed for tests only
  };
}

module.exports = {
  BODY_EXCLUSION_PAD_PX,
  CHAIN_DOT_COUNT,
  SPEECH_GAP_PX,
  SPEECH_INSET_PX,
  TYPEWRITER_CHARS_PER_SEC,
  chainDotPhase,
  createSquidRoomSpeechSystem,
  layoutChainDots,
  sanitizeSpeechText,
  solveSpeechBox,
};
