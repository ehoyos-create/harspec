/**
 * Brief: turn a capture into an evidence pack an agent can rebuild from.
 *
 * The generator in `reproduce` is deterministic, and that ceiling is real: no
 * template will ever look like a bespoke app. So this module stops pretending.
 * It collects what a person would look at — the layout tree, the live computed
 * styles, the design tokens, a full-page image, the interactions, the data and
 * the endpoints — and writes a BRIEF that tells an agent to rebuild the UI with
 * original code.
 *
 * It is the same shape of evidence a reverse-engineering tool hands to a model,
 * except the target is a web app and the output is a runnable project.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyChromeIdentity, Cdp, openBrowser, pinViewport, sleep } from './browser.ts';

// ---------------------------------------------------------------------------
// The in-page probe
//
// Runs inside the target page. Reads the rendered result, not the source: the
// same information a person gets by looking at the screen with devtools open.
// Nothing here is used to copy markup — it is a measurement.
// ---------------------------------------------------------------------------

const PROBE = `(() => {
  var MAX = 6000;
  var doc = document.documentElement;
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, SVG: 1, PATH: 1, LINK: 1, META: 1, HEAD: 1, TEMPLATE: 1, BASE: 1, TITLE: 1 };
  var evidence = {
    meta: {
      url: location.href,
      title: document.title,
      lang: doc.getAttribute('lang') || null,
      description: (document.querySelector('meta[name="description"]') || {}).content || null,
      themeColor: (document.querySelector('meta[name="theme-color"]') || {}).content || null,
      favicon: (function () { var l = document.querySelector('link[rel~="icon"]'); return l ? l.href : null; })(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { width: doc.scrollWidth, height: doc.scrollHeight }
    },
    nodes: [],
    interactions: null,
    tokens: null
  };

  // "can this render at all" is different from "does this have a box".
  // A container with 0 height whose children overflow is common in app shells
  // (and is exactly where the content lives), so it must be walked, just not
  // recorded. Only a display:none or invisible subtree is truly a dead end.
  function canRender(cs) {
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (parseFloat(cs.opacity || '1') < 0.05) return false;
    return true;
  }

  function textOf(el) {
    var t = '';
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) t += n.nodeValue;
    }
    return t.replace(/[ \\t\\n\\r]+/g, ' ').trim().slice(0, 240);
  }

  // Only record style keys that differ from the parent, so the file reads as
  // "what is special about this element" instead of 6000 copies of a default.
  function styleOf(el, cs, parentStyle) {
    var s = {};
    var v;
    function put(key, value) {
      if (value === undefined || value === null || value === '') return;
      if (parentStyle && parentStyle[key] === value) return;
      s[key] = value;
    }
    put('display', cs.display);
    put('direction', cs.flexDirection !== 'row' ? cs.flexDirection : '');
    put('wrap', cs.flexWrap !== 'nowrap' ? cs.flexWrap : '');
    put('align', cs.alignItems !== 'normal' ? cs.alignItems : '');
    put('justify', cs.justifyContent !== 'normal' ? cs.justifyContent : '');
    put('cols', cs.gridTemplateColumns !== 'none' ? cs.gridTemplateColumns : '');
    put('rows', cs.gridTemplateRows !== 'none' ? cs.gridTemplateRows : '');
    put('gap', cs.gap !== 'normal' && cs.gap !== '0px' ? cs.gap : '');
    put('pad', cs.padding !== '0px' ? cs.padding : '');
    put('margin', cs.margin !== '0px' ? cs.margin : '');
    put('position', cs.position !== 'static' ? cs.position : '');
    put('fontFamily', cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    put('fontSize', cs.fontSize);
    put('fontWeight', cs.fontWeight);
    put('lineHeight', cs.lineHeight !== 'normal' ? cs.lineHeight : '');
    put('letterSpacing', cs.letterSpacing !== 'normal' ? cs.letterSpacing : '');
    put('textTransform', cs.textTransform !== 'none' ? cs.textTransform : '');
    put('textAlign', cs.textAlign !== 'start' ? cs.textAlign : '');
    put('color', cs.color);
    put('background', cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '');
    put('backgroundImage', cs.backgroundImage !== 'none' ? String(cs.backgroundImage).slice(0, 200) : '');
    put('radius', cs.borderRadius !== '0px' ? cs.borderRadius : '');
    put('border', cs.borderTopWidth !== '0px' ? cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor : '');
    put('shadow', cs.boxShadow !== 'none' ? cs.boxShadow : '');
    put('overflow', cs.overflow !== 'visible' ? cs.overflow : '');
    put('opacity', cs.opacity !== '1' ? cs.opacity : '');
    put('transform', cs.transform !== 'none' ? String(cs.transform).slice(0, 120) : '');
    put('filter', cs.filter !== 'none' ? cs.filter : '');
    put('objectFit', cs.objectFit !== 'fill' ? cs.objectFit : '');
    void v;
    return s;
  }

  var tokens = {
    fontFamilies: {}, fontSizes: {}, fontWeights: {}, colors: {},
    backgrounds: {}, radii: {}, shadows: {}, gaps: {}, paddings: {},
    borderColors: {}, customProperties: {}
  };
  function bump(bag, value) {
    if (!value) return;
    value = String(value);
    if (value === 'rgba(0, 0, 0, 0)' || value === 'none' || value === 'normal' || value === 'auto') return;
    bag[value] = (bag[value] || 0) + 1;
  }
  // A palette is a ranked list, not a raw dump.
  function palette(bag) {
    var list = Object.keys(bag).map(function (k) { return { value: k, count: bag[k] }; });
    list.sort(function (a, b) { return b.count - a.count; });
    return list.slice(0, 28);
  }

  var index = new Map();
  var nodes = [];
  var count = 0;

  function walk(el, depth, parentIndex, parentStyle, region) {
    if (count >= MAX) return null;
    if (SKIP[el.tagName]) return null;
    var cs = window.getComputedStyle(el);
    if (!canRender(cs)) return null;
    var rect = el.getBoundingClientRect();
    var measurable = rect.width >= 1 && rect.height >= 1;

    // Which landmark an element lives in decides whether it is content or
    // chrome. A repeated nav entry and a repeated card look identical to a
    // shape detector, and only one of them belongs in the content outline.
    var tagName = el.tagName.toLowerCase();
    var landmarkRole = el.getAttribute('role');
    var here =
      tagName === 'nav' || tagName === 'aside' || tagName === 'header' || tagName === 'footer' ||
      landmarkRole === 'navigation' || landmarkRole === 'complementary'
        ? tagName === 'header' || tagName === 'footer' ? tagName : 'nav'
        : null;
    var inRegion = here || region;

    var node = measurable
      ? { i: count++, depth: depth, tag: tagName }
      : null;
    if (!node) {
      // Not recordable, but its children may still be: descend with the same
      // parent so the tree stays connected.
      var shared = el.shadowRoot || el;
      for (var bare = shared.firstElementChild; bare; bare = bare.nextElementSibling) {
        walk(bare, depth, parentIndex, parentStyle, inRegion);
      }
      return null;
    }
    if (parentIndex >= 0) node.parent = parentIndex;
    if (here) node.region = here;

    var text = textOf(el);
    if (text) {
      node.text = text;
      node.fs = Math.round(parseFloat(cs.fontSize) || 0);
    }
    var role = el.getAttribute('role');
    if (role) node.role = role;
    var aria = el.getAttribute('aria-label');
    if (aria) node.aria = aria.slice(0, 120);
    if (el.tagName === 'A') {
      node.href = el.getAttribute('href');
      if (el.getAttribute('target')) node.target = el.getAttribute('target');
    }
    if (el.tagName === 'IMG') {
      node.src = el.currentSrc || el.src;
      node.alt = el.getAttribute('alt') || '';
      if (el.naturalWidth) node.natural = el.naturalWidth + 'x' + el.naturalHeight;
    }
    if (el.tagName === 'INPUT') {
      node.input = el.type;
      node.name = el.getAttribute('name') || '';
      node.placeholder = el.getAttribute('placeholder') || '';
      if (el.type !== 'password') node.value = String(el.value || '').slice(0, 80);
    }
    if (el.tagName === 'BUTTON') node.button = el.getAttribute('type') || 'submit';
    if (el.tagName === 'IFRAME') node.src = el.getAttribute('src') || '';
    if (el.id) node.anchor = el.id;
    if (el.hasAttribute('disabled')) node.disabled = true;
    if (el.hasAttribute('contenteditable')) node.editable = true;

    // Document coordinates, rounded: 1px of noise is not evidence.
    node.box = [
      Math.round(rect.left + window.scrollX),
      Math.round(rect.top + window.scrollY),
      Math.round(rect.width),
      Math.round(rect.height)
    ];

    var style = styleOf(el, cs, parentStyle);
    if (Object.keys(style).length) node.style = style;

    bump(tokens.fontFamilies, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    bump(tokens.fontSizes, cs.fontSize);
    bump(tokens.fontWeights, cs.fontWeight);
    if (text) bump(tokens.colors, cs.color);
    bump(tokens.backgrounds, cs.backgroundColor);
    if (cs.borderRadius !== '0px') bump(tokens.radii, cs.borderRadius);
    if (cs.boxShadow !== 'none') bump(tokens.shadows, String(cs.boxShadow).slice(0, 120));
    if (cs.gap !== 'normal' && cs.gap !== '0px') bump(tokens.gaps, cs.gap);
    if (cs.padding !== '0px') bump(tokens.paddings, cs.padding);
    if (cs.borderTopWidth !== '0px') bump(tokens.borderColors, cs.borderTopColor);

    var at = nodes.length;
    nodes.push(node);
    index.set(el, node.i);

    if (el.tagName === 'IFRAME') return node;

    var merged = parentStyle ? Object.assign({}, parentStyle, style) : style;
    // Modern apps put the entire UI inside shadow roots. If we only walk the
    // light DOM we measure an empty shell, which is exactly the failure mode
    // this tool exists to avoid.
    var host = el.shadowRoot || el;
    for (var c = host.firstElementChild; c; c = c.nextElementSibling) {
      walk(c, depth + 1, node.i, merged, inRegion);
    }
    void at;
    return node;
  }

  if (document.body) walk(document.body, 0, -1, null, null);

  // Design tokens that the app declares for itself are the cheapest fidelity
  // win there is: a palette of names the site already uses.
  try {
    var rootStyle = window.getComputedStyle(doc);
    var seen = 0;
    for (var i = 0; i < rootStyle.length && seen < 80; i++) {
      var prop = rootStyle[i];
      if (prop.indexOf('--') !== 0) continue;
      var value = rootStyle.getPropertyValue(prop).trim();
      if (!value || value.length > 120) continue;
      tokens.customProperties[prop] = value;
      seen++;
    }
  } catch (e) { /* not every engine exposes these */ }

  // Repeated siblings are the app's component system: 20 cards in a grid, 8
  // rows in a table. Detect them so the agent knows what to build once.
  var kidsOf = {};
  for (var b = 0; b < nodes.length; b++) {
    if (nodes[b].parent === undefined) continue;
    (kidsOf[nodes[b].parent] = kidsOf[nodes[b].parent] || []).push(nodes[b]);
  }
  var repeats = [];
  for (var n = 0; n < nodes.length; n++) {
    var parent = nodes[n];
    var kids = kidsOf[parent.i] || [];
    if (kids.length < 3) continue;
    var groups = {};
    for (var k = 0; k < kids.length; k++) {
      var kid = kids[k];
      var sig = kid.tag + '|' + (kid.role || '') + '|' + Math.round(kid.box[2] / 10) + 'x' + Math.round(kid.box[3] / 10);
      (groups[sig] = groups[sig] || []).push(kid.i);
    }
    for (var key in groups) {
      var ids = groups[key];
      if (ids.length < 3) continue;
      repeats.push({ parent: parent.i, count: ids.length, sample: ids[0], members: ids.slice(0, 40), area: parent.box[2] * parent.box[3] });
    }
  }
  repeats.sort(function (a, b) { return b.count - a.count || b.area - a.area; });
  repeats = repeats.slice(0, 12);

  // A component is only useful if you know what it displays. Pull the first
  // few strings out of the sample item so the brief can say "this is a song
  // row", not "this is a custom element".
  function inside(idx, ancestor) {
    var cur = idx;
    while (cur !== undefined && cur !== null) {
      if (cur === ancestor) return true;
      cur = nodes[cur].parent;
    }
    return false;
  }
  for (var r = 0; r < repeats.length; r++) {
    var texts = [];
    var picture = null;
    var family = repeats[r].members;
    for (var d = repeats[r].sample; d < nodes.length && texts.length < 4; d++) {
      if (!inside(d, repeats[r].sample)) continue;
      if (nodes[d].text) texts.push(nodes[d].text);
      if (!picture && nodes[d].tag === 'img') picture = nodes[d].src;
    }
    repeats[r].texts = texts;
    if (picture) repeats[r].image = picture;
    repeats[r].box = nodes[repeats[r].sample].box;
    void family;
  }
  repeats = repeats.filter(function (x) { return x.texts.length > 0 || x.image; });

  var interactions = [];
  for (var m = 0; m < nodes.length; m++) {
    var node = nodes[m];
    var kind = null;
    if (node.tag === 'a' && node.href) kind = 'link';
    else if (node.tag === 'button') kind = 'button';
    else if (node.tag === 'input') kind = 'input';
    else if (node.tag === 'select') kind = 'select';
    else if (node.tag === 'textarea') kind = 'textarea';
    else if (node.role === 'button' || node.role === 'tab' || node.role === 'menuitem' || node.role === 'switch') kind = 'button';
    else if (node.editable) kind = 'editable';
    if (!kind) continue;
    interactions.push({
      node: node.i,
      kind: kind,
      label: node.aria || node.text || node.placeholder || node.name || '',
      href: node.href || undefined,
      input: node.input || undefined,
      box: node.box,
      depth: node.depth
    });
  }

  // Images are listed separately: a rebuild needs to know which pictures carry
  // meaning and how big they are rendered.
  var images = [];
  for (var q = 0; q < nodes.length; q++) {
    var im = nodes[q];
    if (im.tag !== 'img') continue;
    images.push({ node: im.i, src: im.src, alt: im.alt, box: im.box, natural: im.natural });
  }

  // Landmarks and the first screen: what a person sees before scrolling.
  var landmarks = [];
  var tags = ['header', 'nav', 'main', 'aside', 'footer', 'section', 'article'];
  for (var t = 0; t < nodes.length; t++) {
    var lm = nodes[t];
    if (tags.indexOf(lm.tag) === -1) continue;
    landmarks.push({ node: lm.i, tag: lm.tag, box: lm.box, text: (lm.text || '').slice(0, 80) });
  }

  // Sections: a repeated group plus the heading above it. This is what turns
  // a box tree into "the page has eleven shelves, here are their names".
  var sections = [];
  for (var sr = 0; sr < repeats.length && sections.length < 24; sr++) {
    var rp = repeats[sr];
    var box = rp.box;
    var title = '';
    var bestI = -1;
    for (var c2 = 0; c2 < nodes.length; c2++) {
      var cand = nodes[c2];
      if (cand.i >= rp.sample || !cand.text || (cand.fs || 0) < 15) continue;
      var gap = box[1] - cand.box[1];
      if (gap < 0 || gap > 120) continue;
      // A heading sits on the same left edge as the cards it names. Anything
      // further away is chrome that happens to be above it (a nav label, a
      // promo banner), and picking it is how "Explore" ends up as the title of
      // a music shelf.
      if (Math.abs(cand.box[0] - box[0]) > 120) continue;
      if (inside(c2, rp.sample)) continue;
      if (cand.i > bestI) {
        bestI = cand.i;
        title = cand.text;
      }
    }
    var items = [];
    for (var m2 = 0; m2 < rp.members.length && items.length < 16; m2++) {
      var member = nodes[rp.members[m2]];
      var itemTexts = [];
      var itemImage = null;
      for (var d2 = member.i; d2 < nodes.length && itemTexts.length < 3; d2++) {
        if (!inside(d2, member.i)) continue;
        if (nodes[d2].text) itemTexts.push(nodes[d2].text);
        if (!itemImage && nodes[d2].tag === 'img') itemImage = nodes[d2].src;
      }
      items.push({ texts: itemTexts, image: itemImage, box: member.box });
    }
    sections.push({
      title: title || null,
      region: regionOf(rp.sample),
      itemCount: rp.count,
      kind: nodes[rp.sample].tag + (nodes[rp.sample].role ? '[role=' + nodes[rp.sample].role + ']' : ''),
      box: box,
      items: items
    });
  }
  function regionOf(idx) {
    var cur = nodes[idx];
    while (cur) {
      if (cur.region) return cur.region;
      cur = cur.parent === undefined ? null : nodes[cur.parent];
    }
    return null;
  }

  var kept = sections.filter(function (x) { return x.title || x.items.length > 2; });
  // Navigation, sidebars and footers are controls, not content: they are
  // already in interactions.json. Listing them as sections makes a rebuild
  // build three fake card rows at the top of the page.
  kept = kept.filter(function (x) { return x.region !== 'nav' && x.region !== 'header' && x.region !== 'footer'; });
  // A container (a shelf, a carousel) and the cards inside it both look like
  // repeats, and listing both describes the page twice. Keep the inner one:
  // the cards are what a rebuild needs, the shelf is already their box.
  kept = kept.filter(function (a) {
    for (var b2 = 0; b2 < kept.length; b2++) {
      var other = kept[b2];
      if (other === a) continue;
      if (
        other.box[0] >= a.box[0] &&
        other.box[1] >= a.box[1] &&
        other.box[0] + other.box[2] <= a.box[0] + a.box[2] &&
        other.box[1] + other.box[3] <= a.box[1] + a.box[3]
      ) {
        return false;
      }
    }
    return true;
  });
  evidence.sections = kept
    .sort(function (a, b) { return a.box[1] - b.box[1]; })
    .slice(0, 14);

  evidence.nodes = nodes;
  evidence.repeats = repeats;
  evidence.interactions = interactions;
  evidence.images = images;
  evidence.landmarks = landmarks;
  evidence.tokens = {
    fontFamilies: palette(tokens.fontFamilies),
    fontSizes: palette(tokens.fontSizes),
    fontWeights: palette(tokens.fontWeights),
    colors: palette(tokens.colors),
    backgrounds: palette(tokens.backgrounds),
    radii: palette(tokens.radii),
    shadows: palette(tokens.shadows),
    gaps: palette(tokens.gaps),
    paddings: palette(tokens.paddings),
    borderColors: palette(tokens.borderColors),
    customProperties: tokens.customProperties
  };
  evidence.header = null;
  if (document.querySelector('header')) {
    var hr = document.querySelector('header').getBoundingClientRect();
    evidence.header = { height: Math.round(hr.height), fixed: window.getComputedStyle(document.querySelector('header')).position };
  }
  return evidence;
})()`;

export interface EvidenceOptions {
  headless?: boolean;
  onProgress?: (message: string) => void;
  /** Extra settle time after load, in ms. */
  settleMs?: number;
  width?: number;
  height?: number;
}

export interface Evidence {
  meta: Record<string, any>;
  nodes: any[];
  repeats: any[];
  interactions: any[];
  images: any[];
  landmarks: any[];
  tokens: Record<string, any>;
  header: any;
  sections?: any[];
  screenshot?: {
    full?: string;
    viewport?: string;
    viewportBase64?: string;
    pdf?: string;
    note?: string;
    width?: number;
    height?: number;
    from?: 'compositor' | 'pdf';
  };
}

/** Read the rendered page: layout tree, styles, tokens, interactions. */
export async function collectPageEvidence(
  url: string,
  options: EvidenceOptions = {},
): Promise<Evidence> {
  const onProgress = options.onProgress ?? (() => {});
  const session = await openBrowser({
    headless: options.headless ?? true,
    width: options.width ?? 1440,
    height: options.height ?? 900,
    onProgress,
  });
  const cdp = session.cdp;

  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await applyChromeIdentity(cdp, session.version);
    await pinViewport(cdp, options.width ?? 1440, options.height ?? 900);
    onProgress(`navigating to ${url}`);
    await cdp.send('Page.navigate', { url });
    await sleep(options.settleMs ?? 3500);
    await scrollThrough(cdp, onProgress);
    return await observePage(cdp, onProgress);
  } finally {
    session.close();
  }
}

/** Scroll to the bottom and back so lazy content exists in the layout tree. */
export async function scrollThrough(cdp: Cdp, onProgress: (message: string) => void = () => {}): Promise<void> {
  onProgress('scrolling to render everything below the fold');
  const scroller = await evaluate<string>(
    cdp,
    `(() => {
      var best = null;
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var cs = getComputedStyle(el);
        if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue;
        if (el.scrollHeight <= el.clientHeight + 40) continue;
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
      if (!best) return 'window';
      window.__harspecScroller = best;
      return 'element';
    })()`,
  ).catch(() => 'window');

  for (const fraction of [0.5, 1]) {
    await evaluate(
      cdp,
      scroller === 'element'
        ? `if (window.__harspecScroller) window.__harspecScroller.scrollTop = window.__harspecScroller.scrollHeight * ${fraction}; true`
        : `window.scrollTo({ top: document.documentElement.scrollHeight * ${fraction}, behavior: 'instant' }); true`,
    ).catch(() => {});
    await sleep(900);
  }
  await evaluate(
    cdp,
    scroller === 'element'
      ? 'if (window.__harspecScroller) window.__harspecScroller.scrollTop = 0; true'
      : "window.scrollTo({ top: 0, behavior: 'instant' }); true",
  ).catch(() => {});
  await sleep(500);
}

/**
 * Measure an already-loaded page. Split out from `collectPageEvidence` so a
 * capture can produce traffic and evidence from the same browser session.
 */
export async function observePage(
  cdp: Cdp,
  onProgress: (message: string) => void = () => {},
  options: { screenshot?: boolean; scroll?: boolean } = {},
): Promise<Evidence> {
  // The window is not always the size we asked for: a stray restore or a
  // failed metrics call can leave it portrait, and then every measurement and
  // the screenshot inherit the mistake. Pin it once, up front.
  const viewport = await evaluate<{ width: number; height: number }>(
    cdp,
    '({ width: window.innerWidth, height: window.innerHeight })',
  ).catch(() => ({ width: 0, height: 0 }));
  if (Math.abs(viewport.width - 1440) > 4 || Math.abs(viewport.height - 900) > 4) {
    onProgress(`pinning the viewport to 1440x900 (found ${viewport.width}x${viewport.height})`);
    await pinViewport(cdp, 1440, 900);
    await sleep(600);
  }

  onProgress('waiting for the page to settle');
  await settleRender(cdp);
  await dismissConsent(cdp, onProgress);
  await waitForContent(cdp);

  // Scroll only once the app has rendered. Hammering scroll events while a
  // single-page app is still hydrating is a good way to wedge its renderer.
  if (options.scroll !== false) {
    onProgress('scrolling for anything below the fold');
    await scrollThrough(cdp, onProgress);
    await settleRender(cdp, 6_000);
  }

  onProgress('measuring the layout tree');
  let evidence = await evaluate<Evidence>(cdp, PROBE, 60_000);

  // A shell that has settled is still a shell. If the measurement looks empty,
  // give the app one more chance rather than shipping a pack with 40 boxes.
  if (evidence.nodes.length < 120) {
    onProgress('the page looks empty, waiting a little longer');
    await sleep(3_000);
    await settleRender(cdp, 8_000);
    evidence = await evaluate<Evidence>(cdp, PROBE, 60_000);
  }
  if (options.screenshot !== false) {
    onProgress('capturing a full-page image');
    evidence.screenshot = await captureImage(cdp, evidence).catch((error) => ({
      note: `image capture failed: ${error.message}`,
    }));
  }
  return evidence;
}

/**
 * Wait until the page has actually rendered.
 *
 * Measuring at "load" catches the shell of a single-page app, not the app:
 * the framework is still waiting on its data. Element count alone is not
 * enough either, because a shell is perfectly stable. So wait for both:
 * the network to go quiet and the DOM to stop changing.
 */
export async function settleRender(cdp: Cdp, maxMs = 20_000): Promise<number> {
  let inflight = 0;
  cdp.on('Network.requestWillBeSent', () => {
    inflight += 1;
  });
  const done = () => {
    inflight = Math.max(0, inflight - 1);
  };
  cdp.on('Network.loadingFinished', done);
  cdp.on('Network.loadingFailed', done);
  await cdp.send('Network.enable').catch(() => {});

  const count = () => evaluate<number>(cdp, 'document.querySelectorAll("*").length').catch(() => 0);
  const deadline = Date.now() + maxMs;
  let previous = -1;
  let stableSince = 0;
  let quietSince = 0;
  let current = 0;

  while (Date.now() < deadline) {
    await sleep(300);
    current = await count();
    if (current === previous && current > 0) {
      if (!stableSince) stableSince = Date.now();
    } else {
      stableSince = 0;
    }
    previous = current;
    if (inflight === 0) {
      if (!quietSince) quietSince = Date.now();
    } else {
      quietSince = 0;
    }
    const stable = stableSince && Date.now() - stableSince >= 1_200;
    const quiet = quietSince && Date.now() - quietSince >= 1_200;
    if (stable && quiet && current > 20) return current;
  }
  return current;
}

/**
 * A cookie banner is not part of the app, but it sits on top of it in every
 * screenshot. Click the quiet option once, like a person would.
 */
export async function dismissConsent(cdp: Cdp, onProgress: (message: string) => void = () => {}): Promise<void> {
  const expression = `(() => {
    const decline = /^(reject all|reject|decline|decline all|only necessary|necessary only|essential only|rechazar|rechazar todo|solo necesarias|refuser|tout refuser|ablehnen|rifiuta|recusar)$/i;
    const accept = /^(accept all|accept|i agree|agree|got it|i understand|ok|okay|aceptar todo|aceptar|entendido|accepter|tout accepter|alle akzeptieren|zustimmen|accetta tutto|entendi)$/i;
    const candidates = [...document.querySelectorAll('button, [role="button"], a, input[type="submit"]')]
      .filter((node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const label = (node) => (node.innerText || node.value || '').trim();
    const target = candidates.find((node) => decline.test(label(node))) || candidates.find((node) => accept.test(label(node)));
    if (!target) return '';
    target.click();
    return label(target);
  })()`;

  const result = await evaluate<string>(cdp, expression).catch(() => '');
  if (!result) return;
  onProgress(`dismissed a consent wall ("${String(result).slice(0, 24)}")`);
  await sleep(800);
  await settleRender(cdp, 5_000);
}

/** Rough signal that the app painted something, not just its chrome. */
async function waitForContent(cdp: Cdp, maxMs = 10_000): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const characters = await evaluate<number>(cdp, 'document.body ? document.body.innerText.length : 0').catch(() => 0);
    if (characters > 600) return;
    await sleep(800);
  }
}

async function evaluate<T>(cdp: Cdp, expression: string, timeoutMs = 20_000): Promise<T> {
  const result = await Promise.race([
    cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: true,
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('evaluation timed out')), timeoutMs)),
  ]);
  const response = result as any;
  if (response?.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? 'page evaluation failed');
  }
  return response?.result?.value as T;
}

/**
 * Screenshots are the one thing some Chromium builds refuse. Printing to PDF
 * uses a different path and works even where `Page.captureScreenshot` returns
 * "Unable to capture screenshot", so PDF is the primary route and a real
 * screenshot is the fallback.
 */
async function captureImage(cdp: Cdp, evidence: Evidence): Promise<Evidence['screenshot']> {
  // Some pages report a scroll width narrower than the window (a scaled or
  // centred shell). The image should be the window a person saw, not the
  // smallest box the document claims.
  const viewportWidth = Math.round(evidence.meta.viewport?.width ?? 0) || 0;
  const viewportHeight = Math.round(evidence.meta.viewport?.height ?? 0) || 0;
  const width = Math.max(320, Math.round(evidence.meta.document?.width ?? 1440), viewportWidth);
  const tall = Math.max(320, Math.round(evidence.meta.document?.height ?? 900), viewportHeight);

  // The compositor gives a pixel-accurate shot of the window. Use it always:
  // it is the image that matches the measurements, and it is what a person
  // compares against when checking fidelity.
  const viewportShot = await cdp
    .send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    .catch(() => null);

  // A page that fits in one screen needs nothing else.
  if (tall <= viewportHeight + 50 && viewportShot?.data) {
    return {
      full: viewportShot.data,
      width: viewportWidth || width,
      height: viewportHeight || tall,
      from: 'compositor',
    } as any;
  }

  // A PDF page tops out at 200 inches. Past that we scale down instead of
  // paginating, because a cut page is worse evidence than a smaller one.
  const limit = 14_400;
  const scale = tall > limit ? limit / tall : 1;
  const height = Math.round(tall * scale);

  await cdp.send('Emulation.setEmulatedMedia', { media: 'screen' }).catch(() => {});
  await sleep(300);

  const pdf = await cdp
    .send('Page.printToPDF', {
      printBackground: true,
      paperWidth: width / 72,
      paperHeight: height / 72,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: false,
      scale,
    })
    .catch(() => null);

  if (pdf?.data) {
    return {
      pdf: Buffer.from(pdf.data, 'base64').toString('base64'),
      width,
      height,
      viewportBase64: viewportShot?.data,
    } as any;
  }

  const beyond = await cdp
    .send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true })
    .catch(() => null);
  if (beyond?.data) return { full: beyond.data, viewportBase64: viewportShot?.data } as any;
  if (viewportShot?.data) {
    return { full: viewportShot.data, note: 'only the visible screen could be captured', width: viewportWidth, height: viewportHeight } as any;
  }
  throw new Error('this browser refused every screenshot method');
}

/**
 * Decode the PDF into PNGs with tools a mac and most Linux boxes already have.
 * `sips` ships with macOS; `pdftoppm` covers the rest. Returns the written paths.
 */
export async function rasterise(
  pdfBase64: string,
  dir: string,
  viewport?: { width: number; height: number },
): Promise<{ full?: string; viewport?: string; pdf: string }> {
  mkdirSync(dir, { recursive: true });
  const pdfPath = join(dir, 'page.pdf');
  writeFileSync(pdfPath, Buffer.from(pdfBase64, 'base64'));
  const fullPath = join(dir, 'screenshot.png');

  let converted = false;
  if (await run('sips', ['-s', 'format', 'png', pdfPath, '--out', fullPath])) converted = true;
  if (!converted) {
    const prefix = join(dir, 'page');
    converted = await run('pdftoppm', ['-png', '-r', '72', '-singlefile', pdfPath, prefix]);
    if (converted) {
      const produced = `${prefix}.png`;
      copyFileSync(produced, fullPath);
    }
  }
  if (!converted) return { pdf: pdfPath };

  let viewportPath: string | undefined;
  if (viewport) {
    viewportPath = join(dir, 'viewport.png');
    const copied = await run('sips', ['--cropOffset', '0', '0', '-c', String(viewport.height), String(viewport.width), fullPath, '--out', viewportPath]);
    if (!copied) viewportPath = undefined;
  }
  return { full: fullPath, viewport: viewportPath, pdf: pdfPath };
}

/**
 * Wrap the pack's pieces into the folder an agent opens. Pure file writing:
 * the analysis already happened above.
 */
export interface BriefInput {
  label: string;
  outDir: string;
  evidence?: Evidence;
  collections: Array<{ key: string; label: string; fields: string[]; items: any[] }>;
  endpoints: Array<{ method: string; path: string; status: number; contentType: string }>;
  appName: string;
  screenshots?: { full?: string; viewport?: string };
}

export function writeBriefPack(input: BriefInput): string[] {
  const { outDir, evidence } = input;
  mkdirSync(join(outDir, 'evidence'), { recursive: true });
  mkdirSync(join(outDir, 'data'), { recursive: true });
  const written: string[] = [];

  const put = (relative: string, body: string) => {
    const target = join(outDir, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, body);
    written.push(relative);
  };

  if (evidence) {
    put('evidence/layout.json', JSON.stringify({
      note: 'Rendered layout tree. Coordinates are document pixels at the capture width. "style" keys are listed only where they differ from the parent.',
      meta: evidence.meta,
      header: evidence.header,
      landmarks: evidence.landmarks,
      repeats: evidence.repeats,
      sections: evidence.sections,
      nodes: evidence.nodes,
    }, null, 1));

    put('evidence/tokens.json', JSON.stringify({
      note: 'Ranked by how often each value appears on screen. The custom properties are the ones the site declares for itself.',
      ...evidence.tokens,
    }, null, 2));

    put('evidence/interactions.json', JSON.stringify({
      note: 'Every control a person can operate, with its screen position and, for links, where it points.',
      header: evidence.header,
      interactions: evidence.interactions,
    }, null, 2));

    put('evidence/images.json', JSON.stringify({
      note: 'Pictures as rendered, with the box they occupy. Hotlinked URLs are evidence, not assets to vendor.',
      images: evidence.images,
    }, null, 2));

    const shots = input.screenshots;
    if (shots?.full) {
      copyFileSync(shots.full, join(outDir, 'evidence/screenshot.png'));
      written.push('evidence/screenshot.png');
    }
    if (shots?.viewport) {
      copyFileSync(shots.viewport, join(outDir, 'evidence/viewport.png'));
      written.push('evidence/viewport.png');
    }
  }

  put('data/records.json', JSON.stringify({
    note: 'Structured records recovered from the capture. This is the real content the app displayed.',
    collections: input.collections,
  }, null, 2));

  put('data/endpoints.json', JSON.stringify({
    note: 'Requests observed during the capture. Response bodies are in the HAR if you need them.',
    endpoints: input.endpoints,
  }, null, 2));

  put('BRIEF.md', renderBrief(input));
  return written;
}

function renderBrief(input: BriefInput): string {
  const { evidence, collections, endpoints, appName, label } = input;
  const source = label.replace(/^https?:\/\//, '');
  const lines: string[] = [];

  lines.push(`# Rebuild brief: ${appName}`);
  lines.push('');
  lines.push(`Source: \`${source}\``);
  lines.push(`Captured: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('You are rebuilding this web app from evidence. Everything here is a');
  lines.push('measurement of what the app rendered and returned. **Write new code.** Do not');
  lines.push('copy the target\'s HTML, CSS, JavaScript or image files; reproduce the layout,');
  lines.push('the proportions, the type scale and the behaviour with your own implementation.');
  lines.push('');

  if (evidence) {
    const meta = evidence.meta;
    lines.push('## What the page looked like');
    lines.push('');
    lines.push(`- Viewport at capture: **${meta.viewport.width}x${meta.viewport.height}**`);
    lines.push(`- Document size: **${meta.document.width}x${meta.document.height}**`);
    if (meta.title) lines.push(`- Title: *${meta.title}*`);
    if (evidence.header) {
      lines.push(`- Header: ${evidence.header.height}px tall, position \`${evidence.header.fixed}\``);
    }
    lines.push('');
    lines.push('Files:');
    lines.push('');
    lines.push('| File | What it answers |');
    lines.push('| --- | --- |');
    lines.push('| `evidence/screenshot.png` | What it looks like. Match this. |');
    lines.push('| `evidence/layout.json` | The box tree: every element\'s position, size and the styles that make it different from its parent. |');
    lines.push('| `evidence/tokens.json` | The palette, type scale, radii, shadows and spacing, ranked by usage. |');
    lines.push('| `evidence/interactions.json` | Every clickable or typeable control and where links go. |');
    lines.push('| `evidence/images.json` | Picture sources, alt text and rendered size. |');
    lines.push('| `data/records.json` | The actual content the app displayed. |');
    lines.push('| `data/endpoints.json` | The API calls it made. |');
    lines.push('');
    lines.push('### How to read `layout.json`');
    lines.push('');
    lines.push('`nodes` is a pre-order tree. `i` is the node id, `parent` its parent id, `depth`');
    lines.push('the nesting level. `box` is `[x, y, width, height]` in document pixels. `text` is');
    lines.push('the element\'s own text. `style` only lists properties that differ from the parent,');
    lines.push('so a node with `"display":"flex","gap":"16px","cols":""` is literally saying');
    lines.push('"this is the grid".');
    lines.push('');
    if (evidence.repeats?.length) {
      lines.push('`repeats` lists structures that appear three or more times with the same shape:');
      lines.push('those are the components to build once and loop over.');
      lines.push('');
      for (const repeat of evidence.repeats.slice(0, 8)) {
        const sample = evidence.nodes.find((n) => n.i === repeat.sample);
        const label = (repeat.texts ?? []).slice(0, 3).join(' · ') || '<no text>';
        const box = repeat.box ? ` at ${repeat.box[0]},${repeat.box[1]} sized ${repeat.box[2]}x${repeat.box[3]}` : '';
        lines.push(`- **${repeat.count}x** \`${sample?.tag ?? 'node'}\` (node ${repeat.sample})${box} — ${label}`);
      }
      lines.push('');
    }
    lines.push('### Design tokens in short');
    lines.push('');
    const tokens = evidence.tokens;
    const top = (list: any[] | undefined, n = 4) =>
      (list ?? []).slice(0, n).map((t) => `\`${t.value}\``).join(', ');
    if (tokens.fontFamilies?.length) lines.push(`- Families: ${top(tokens.fontFamilies)}`);
    if (tokens.fontSizes?.length) lines.push(`- Sizes: ${top(tokens.fontSizes, 6)}`);
    if (tokens.fontWeights?.length) lines.push(`- Weights: ${top(tokens.fontWeights)}`);
    if (tokens.colors?.length) lines.push(`- Text colors: ${top(tokens.colors, 5)}`);
    if (tokens.backgrounds?.length) lines.push(`- Surfaces: ${top(tokens.backgrounds, 5)}`);
    if (tokens.radii?.length) lines.push(`- Radii: ${top(tokens.radii)}`);
    if (tokens.gaps?.length) lines.push(`- Gaps: ${top(tokens.gaps)}`);
    lines.push('');
    if (meta.themeColor) lines.push(`Browser theme color: \`${meta.themeColor}\``);
    lines.push('');

    // The single most useful thing for a rebuild is not the box tree: it is
    // "this page is eleven shelves, in this order, with these names and these
    // cards". Without it an agent builds one generic grid and calls it a day.
    const sections = (evidence.sections ?? []).filter((section: any) => section.title || section.items?.length);
    if (sections.length) {
      lines.push('### The content outline');
      lines.push('');
      lines.push('What the page contains, top to bottom, in the order it appears. Build a');
      lines.push('component per row here, not one generic grid for the whole page.');
      lines.push('');
      lines.push('| # | Section | Pattern | Items | First cards (title — subtitle) |');
      lines.push('| --- | --- | --- | --- | --- |');
      sections.forEach((section: any, index: number) => {
        const items = (section.items ?? [])
          .slice(0, 3)
          .map((item: any) => {
            const texts = (item.texts ?? []).filter(Boolean).slice(0, 2);
            const label = texts.join(' — ');
            return item.image ? `${label} \`[img]\`` : label;
          })
          .map((text: string) => text.replace(/\|/g, '/').slice(0, 80))
          .join('<br>');
        lines.push(
          `| ${index + 1} | ${(section.title ?? '—').replace(/\|/g, '/')} | \`${section.kind ?? 'node'}\` | ${section.itemCount ?? section.items?.length ?? 0} | ${items || '—'} |`,
        );
      });
      lines.push('');
      lines.push('If a section title is empty, it has no visible heading: keep the spacing but do');
      lines.push('not invent one. Card size and the number per row come from `layout.json`.');
      lines.push('');
    }
  } else {
    lines.push('## No page evidence');
    lines.push('');
    lines.push('This pack came from a HAR file, so there is no rendered layout, no');
    lines.push('screenshot and no computed styles: only the traffic. Build the UI from the');
    lines.push('records and the endpoints below, and say so rather than inventing a layout.');
    lines.push('');
  }

  lines.push('## The data');
  lines.push('');
  if (!collections.length) {
    lines.push('No structured records were recovered.');
  } else {
    lines.push('| Collection | Records | Fields |');
    lines.push('| --- | --- | --- |');
    for (const collection of collections) {
      lines.push(`| \`${collection.key}\` | ${collection.items.length} | ${collection.fields.slice(0, 8).join(', ')} |`);
    }
    lines.push('');
    for (const collection of collections.slice(0, 3)) {
      const sample = collection.items[0];
      if (!sample) continue;
      lines.push(`First record of \`${collection.key}\`:`);
      lines.push('');
      lines.push('```json');
      lines.push(JSON.stringify(sample, null, 2).slice(0, 1200));
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('## The endpoints');
  lines.push('');
  if (!endpoints.length) {
    lines.push('None observed.');
  } else {
    lines.push('| Method | Path | Status | Type |');
    lines.push('| --- | --- | --- | --- |');
    for (const endpoint of endpoints.slice(0, 40)) {
      lines.push(`| ${endpoint.method} | \`${endpoint.path}\` | ${endpoint.status} | ${endpoint.contentType} |`);
    }
    lines.push('');
  }

  lines.push('## What to build');
  lines.push('');
  lines.push('1. **A server** that serves the records in `data/records.json` as JSON, plus a');
  lines.push('   catch-all replay of the endpoints that are not data (so the UI has somewhere');
  lines.push('   to point). Node built-ins only; no framework required.');
  lines.push('2. **A UI** that matches `evidence/screenshot.png`: same layout, same');
  lines.push('   proportions, same type scale, same density. Use the token values as your');
  lines.push('   starting palette instead of defaulting to a generic admin look. If the app');
  lines.push('   is dark, the rebuild is dark; if it is a media grid, build a media grid.');
  lines.push('3. **The interactions** listed in `evidence/interactions.json`: links navigate,');
  lines.push('   buttons do what their label says within the data you have, search filters.');
  lines.push('4. **Honesty about gaps**: where the capture does not contain something (audio,');
  lines.push('   auth, live search), stub it and write the gap in the README rather than');
  lines.push('   faking it.');
  lines.push('');
  lines.push('## The fidelity test');
  lines.push('');
  lines.push('Open the rebuild and the screenshot side by side at the capture width');
  lines.push(`(${evidence?.meta?.viewport?.width ?? 1440}px). Compare: header height, grid column`);
  lines.push('count, card aspect ratio, font sizes at each level, and the spacing between');
  lines.push('sections. Those five things are most of the perceived difference. If they do');
  lines.push('not match, the rebuild is not done yet.');
  lines.push('');
  lines.push('## Legal line');
  lines.push('');
  lines.push('This pack measures behaviour and appearance. It does not license the');
  lines.push('original: do not ship the target\'s name, logo, icons, copy or assets in');
  lines.push('anything you publish. Rebuild the structure, replace the identity.');
  lines.push('');

  return lines.join('\n');
}

function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export function summariseEvidence(evidence: Evidence): string[] {
  const lines: string[] = [];
  const meta = evidence.meta;
  lines.push(`page        ${meta.viewport.width}x${meta.viewport.height} viewport, ${meta.document.width}x${meta.document.height} document`);
  lines.push(`elements    ${evidence.nodes.length} measured`);
  lines.push(`controls    ${evidence.interactions.length} interactive`);
  lines.push(`images      ${evidence.images.length}`);
  if (evidence.repeats?.length) {
    lines.push(`repeats     ${evidence.repeats.map((r) => `${r.count}x`).slice(0, 5).join(', ')}`);
  }
  return lines;
}
