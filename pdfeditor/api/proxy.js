// /api/proxy.js
// Serverless HTML proxy that injects an element-picker. The picker now returns
// a semantic selector (.cta-button/.button/unique) *and* a full CSS block.

export default async function handler(req, res) {
  try {
    const u = req.query.u || new URL(req.url, 'http://x').searchParams.get('u');
    if (!u) return res.status(400).send("Missing ?u=");

    let target;
    try { target = new URL(u); } catch { return res.status(400).send("Invalid URL"); }
    if (!/^https?:$/.test(target.protocol)) return res.status(400).send("Only http/https allowed");

    const host = target.hostname.toLowerCase();
    // Block private ranges / localhost
    if (
      host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return res.status(400).send("Blocked private/localhost targets");
    }

    const r = await fetch(target.href, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Hullify-Inspector/1.0)' }
    });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html')) {
      return res.status(415).send("Target is not an HTML page");
    }
    let html = await r.text();

    // Strip inline CSP metas (headers won't carry over anyway)
    html = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');

    // Ensure relative URLs resolve correctly
    const baseTag = `<base href="${target.origin}${target.pathname.replace(/[^/]*$/, '')}">`;

    // === Inject the picker (selector + CSS extractor) ===
    const picker = `
<script>
(function(){
  window.parent && window.parent.postMessage({type:'picker-ready'}, '*');

  let picking = false;
  let overlay, label;

  function ensureOverlay(){
    if (overlay) return;
    overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position:'fixed', zIndex:'2147483646', pointerEvents:'none',
      border:'2px solid #22c55e', borderRadius:'4px',
      boxShadow:'0 0 0 2px rgba(34,197,94,.2)', display:'none'
    });
    document.documentElement.appendChild(overlay);

    label = document.createElement('div');
    Object.assign(label.style, {
      position:'fixed', zIndex:'2147483647', pointerEvents:'none',
      background:'rgba(34,197,94,.95)', color:'#08110a',
      font:'12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      padding:'2px 6px', borderRadius:'4px', display:'none'
    });
    document.documentElement.appendChild(label);
  }

  // ---------- helpers ----------
  const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/[^\\w-]/g, '\\\\$&');

  const isHashy = (c) => /__|--/.test(c) || /[0-9]/.test(c) || /[A-Z].*[A-Z]/.test(c) || c.length > 24;

  function semanticClasses(el){
    const list = el.classList ? Array.from(el.classList) : [];
    return list.filter(c => !isHashy(c)).sort((a,b) => a.length - b.length).slice(0, 2);
  }

  function tagAndClasses(el){
    const tag = el.tagName.toLowerCase();
    const cls = semanticClasses(el);
    return tag + (cls.length ? cls.map(c => '.'+esc(c)).join('') : '');
  }

  function nthOfType(el){
    let i = 1, n = el;
    while ((n = n.previousElementSibling)) if (n.tagName === el.tagName) i++;
    return i;
  }

  function count(sel){ try { return document.querySelectorAll(sel).length; } catch { return 9999; } }

  // Full readable path (fallback)
  function fullPath(el){
    const parts = [];
    let cur = el, hops = 0;
    while (cur && cur.nodeType === 1 && hops < 10){
      const tag = cur.tagName.toLowerCase();
      const id  = cur.id ? '#'+esc(cur.id) : '';
      const cls = semanticClasses(cur).map(c => '.'+esc(c)).join('');
      let part = tag + id + cls;

      const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter(n => n.tagName === cur.tagName) : [];
      if (sibs.length > 1) part += ':nth-of-type('+ nthOfType(cur) +')';

      parts.unshift(part);
      if (id) break;
      cur = cur.parentElement; hops++;
    }
    return parts.join(' > ');
  }

  // ---------- CTA heuristics ----------
  const CTA_TOKENS = /(^|\\b)(start|get|try|sign|sign up|buy|shop|learn|join|download|create|book|add|subscribe|continue|choose|begin|explore|build|launch)(\\b|!|\\?|\\.|\\s|$)/i;
  const CLASS_TOKENS = /(btn|button|cta|primary|action)/i;

  function looksButtonLike(el){
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'BUTTON') return true;
    if (el.getAttribute('role') === 'button') return true;
    if (CLASS_TOKENS.test(el.className || '')) return true;

    const s = getComputedStyle(el);
    const pad = ['Top','Right','Bottom','Left'].map(side => parseFloat(s['padding'+side]||'0')).reduce((a,b)=>a+b,0);
    const bg = s.backgroundColor && s.backgroundColor !== 'transparent' && !/rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)/.test(s.backgroundColor);
    const radius = parseFloat(s.borderTopLeftRadius||'0') + parseFloat(s.borderBottomRightRadius||'0');
    const cursor = s.cursor;
    const display = s.display;
    return (pad >= 16 && (cursor === 'pointer' || display !== 'inline')) || bg || radius >= 6;
  }

  function looksCTA(el){
    const txt = (el.textContent || '').trim().toLowerCase();
    if (CTA_TOKENS.test(txt)) return true;
    if (CLASS_TOKENS.test(el.className || '')) return true;
    return false;
  }

  function suggestSelector(el){
    if (looksButtonLike(el) && looksCTA(el)) return '.cta-button';
    if (looksButtonLike(el)) return '.button';
    return null;
  }

  // ---------- minimal unique selector (fallback) ----------
  function uniqueSelector(el){
    if (!el || el.nodeType !== 1) return '';

    if (el.id && count('#'+esc(el.id)) === 1) return '#'+esc(el.id);

    const baseSelf = tagAndClasses(el);
    if (count(baseSelf) === 1) return baseSelf;

    const selfNth = baseSelf + ':nth-of-type('+ nthOfType(el) +')';
    if (count(selfNth) === 1) return selfNth;

    let cur = el.parentElement, depth = 0;
    const baseChild = baseSelf;

    while (cur && depth < 4){
      let parentPart = '';
      if (cur.id && count('#'+esc(cur.id)) >= 1) {
        parentPart = '#'+esc(cur.id);
      } else {
        parentPart = tagAndClasses(cur);
      }

      let candidate = parentPart + ' > ' + baseChild;
      if (count(candidate) === 1) return candidate;

      candidate = parentPart + ' > ' + baseSelf + ':nth-of-type('+ nthOfType(el) +')';
      if (count(candidate) === 1) return candidate;

      const parentNth = parentPart.includes(':nth-of-type(')
        ? parentPart
        : parentPart + ':nth-of-type('+ nthOfType(cur) +')';
      candidate = parentNth + ' > ' + baseSelf;
      if (count(candidate) === 1) return candidate;

      cur = cur.parentElement; depth++;
    }

    return fullPath(el);
  }

  function pretty(selector){
    const parts = selector.split(/\\s*>\\s*/);
    return parts.map((p,i) => (i ? '  '.repeat(i) : '') + p).join(' >\\n');
  }

  // ---------- CSS extraction ----------
  // Convert rgb/rgba -> hex (preserves alpha as rgba if not fully opaque)
  function colorToCss(v){
    if (!v) return null;
    if (v === 'transparent' || /^rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)$/i.test(v)) return null;
    const m = v.match(/rgba?\\(([^)]+)\\)/i);
    if (!m) return v;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const [r,g,b,a] = parts;
    if (parts.length === 4 && a < 1) return \`rgba(\${r}, \${g}, \${b}, \${a})\`;
    const toHex = (n)=>('#'+n.toString(16).padStart(2,'0')).slice(1);
    return '#'+[r,g,b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2,'0')).join('');
  }

  // Condense 4-side props into shorthand when possible
  function sides(s, base){
    const t = s.getPropertyValue(base+'-top');
    const r = s.getPropertyValue(base+'-right');
    const b = s.getPropertyValue(base+'-bottom');
    const l = s.getPropertyValue(base+'-left');
    if (!t && !r && !b && !l) return null;
    if (t===b && r===l){
      if (t===r) return t;         // 1 value
      return \`\${t} \${r}\`;       // 2 values
    }
    if (r===l) return \`\${t} \${r} \${b}\`; // 3 values
    return \`\${t} \${r} \${b} \${l}\`;      // 4 values
  }

  function borderShorthand(s){
    const w = s.borderTopWidth, st = s.borderTopStyle, c = colorToCss(s.borderTopColor);
    const wR = s.borderRightWidth, stR = s.borderRightStyle, cR = colorToCss(s.borderRightColor);
    const wB = s.borderBottomWidth, stB = s.borderBottomStyle, cB = colorToCss(s.borderBottomColor);
    const wL = s.borderLeftWidth, stL = s.borderLeftStyle, cL = colorToCss(s.borderLeftColor);
    const allEq = (w===wR && w===wB && w===wL && st===stR && st===stB && st===stL && c===cR && c===cB && c===cL);
    if (allEq && w!=='0px' && st!=='none' && c){ return \`\${w} \${st} \${c}\`; }
    return null; // fall back to per-side later if needed
  }

  function radiusShorthand(s){
    const tl = s.borderTopLeftRadius, tr = s.borderTopRightRadius, br = s.borderBottomRightRadius, bl = s.borderBottomLeftRadius;
    if (tl===tr && tr===br && br===bl) return tl;
    return \`\${tl} \${tr} \${br} \${bl}\`;
  }

  function extractCss(el, selector){
    const s = getComputedStyle(el);
    const out = [];

    // Layout / box
    const disp = s.display;
    if (disp && disp !== 'inline') out.push(['display', disp]);

    const pos = s.position;
    if (pos && pos !== 'static') out.push(['position', pos]); // careful with absolute/fixed

    const overflow = s.overflow;
    if (overflow && overflow !== 'visible') out.push(['overflow', overflow]);

    const m = sides(s, 'margin');
    if (m && !/^0(px)?$/i.test(m)) out.push(['margin', m]);

    const p = sides(s, 'padding');
    if (p && !/^0(px)?$/i.test(p)) out.push(['padding', p]);

    // Flex alignment
    if (disp.includes('flex')) {
      const fd = s.flexDirection; if (fd && fd!=='row') out.push(['flex-direction', fd]);
      const jc = s.justifyContent; if (jc && jc!=='normal' && jc!=='flex-start') out.push(['justify-content', jc]);
      const ai = s.alignItems; if (ai && ai!=='normal' && ai!=='stretch') out.push(['align-items', ai]);
      const gap = s.gap; if (gap && !/^0(px)?$/i.test(gap)) out.push(['gap', gap]);
    }

    // Typography
    const ff = s.fontFamily; if (ff) out.push(['font-family', ff.replaceAll('"','\\"')]);
    const fz = s.fontSize; if (fz) out.push(['font-size', fz]);
    const fw = s.fontWeight; if (fw && fw!=='400') out.push(['font-weight', fw]);
    const lh = s.lineHeight; if (lh && lh!=='normal') out.push(['line-height', lh]);
    const ls = s.letterSpacing; if (ls && ls!=='normal' && ls!=='0px') out.push(['letter-spacing', ls]);
    const tt = s.textTransform; if (tt && tt!=='none') out.push(['text-transform', tt]);
    const ta = s.textAlign; if (ta && ta!=='start') out.push(['text-align', ta]);
    const td = s.textDecorationLine; if (td && td!=='none') out.push(['text-decoration', td]);

    // Colors / background
    const color = colorToCss(s.color); if (color) out.push(['color', color]);
    const bg = colorToCss(s.backgroundColor); if (bg) out.push(['background-color', bg]);
    const bgImg = s.backgroundImage; if (bgImg && bgImg!=='none') out.push(['background-image', bgImg]);
    const bgSize = s.backgroundSize; if (bgSize && bgImg && bgImg!=='none') out.push(['background-size', bgSize]);
    const bgPos = s.backgroundPosition; if (bgPos && bgImg && bgImg!=='none') out.push(['background-position', bgPos]);

    // Border / radius / shadow
    const bAll = borderShorthand(s);
    if (bAll) {
      out.push(['border', bAll]);
    } else {
      const bt = s.borderTopWidth; const bst = s.borderTopStyle; const bc = colorToCss(s.borderTopColor);
      if (bst!=='none' && bt!=='0px' && bc) out.push(['border-top', \`\${bt} \${bst} \${bc}\`]);
      const br = s.borderRightWidth; const brst = s.borderRightStyle; const brc = colorToCss(s.borderRightColor);
      if (brst!=='none' && br!=='0px' && brc) out.push(['border-right', \`\${br} \${brst} \${brc}\`]);
      const bb = s.borderBottomWidth; const bbst = s.borderBottomStyle; const bbc = colorToCss(s.borderBottomColor);
      if (bbst!=='none' && bb!=='0px' && bbc) out.push(['border-bottom', \`\${bb} \${bbst} \${bbc}\`]);
      const bl = s.borderLeftWidth; const blst = s.borderLeftStyle; const blc = colorToCss(s.borderLeftColor);
      if (blst!=='none' && bl!=='0px' && blc) out.push(['border-left', \`\${bl} \${blst} \${blc}\`]);
    }

    const rad = radiusShorthand(s);
    if (rad && rad!=='0px') out.push(['border-radius', rad]);

    const sh = s.boxShadow; if (sh && sh!=='none') out.push(['box-shadow', sh]);

    // Cursor & transitions (nice to keep if present)
    const cur = s.cursor; if (cur && cur!=='auto') out.push(['cursor', cur]);
    const tr = s.transition; if (tr && tr!=='all 0s ease 0s' && tr!=='0s') out.push(['transition', tr]);

    // Build rule
    // If we suggested a semantic class, use that; otherwise the minimal selector.
    let sel = selector;
    if (!sel) sel = uniqueSelector(el);

    const lines = out.map(([k,v]) => \`  \${k}: \${v};\`);
    const css = \`\${sel} {\\n\${lines.join('\\n')}\\n}\`;

    return css;
  }

  // ---------- interactions ----------
  function onMove(e){
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;

    const r = el.getBoundingClientRect();
    overlay.style.display='block';
    overlay.style.left = (r.left - 2) + 'px';
    overlay.style.top  = (r.top  - 2) + 'px';
    overlay.style.width  = (r.width  + 4) + 'px';
    overlay.style.height = (r.height + 4) + 'px';

    label.textContent = el.tagName.toLowerCase() + (el.id ? '#'+el.id : '');
    label.style.display='block';
    label.style.left = (r.left) + 'px';
    label.style.top  = (Math.max(0, r.top - 22)) + 'px';

    window.parent && window.parent.postMessage({type:'hover', payload:{ tag: el.tagName.toLowerCase() }}, '*');
  }

  function onClick(e){
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;

    const r = el.getBoundingClientRect();

    // Prefer semantic suggestion
    const suggested = suggestSelector(el);          // '.cta-button' | '.button' | null
    const selectorMin  = suggested || uniqueSelector(el);
    const selectorPath = fullPath(el);
    const cssBlock = extractCss(el, suggested || null); // will fall back internally if needed

    window.parent && window.parent.postMessage({
      type:'select',
      payload:{
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        classes: el.classList ? Array.from(el.classList) : [],
        rect: { x:r.x, y:r.y, width:r.width, height:r.height },
        selectorMin,
        selectorPretty: (function(sel){ const parts = sel.split(/\\s*>\\s*/); return parts.map((p,i)=> (i?'  '.repeat(i):'')+p).join(' >\\n'); })(selectorMin),
        selectorPath,
        cssBlock
      }
    }, '*');
  }

  window.addEventListener('message', (e) => {
    if (!e.data || e.data.type !== 'toggle-picker') return;
    picking = !!e.data.picking;
    ensureOverlay();
    overlay.style.display = picking ? 'block' : 'none';
    label.style.display   = picking ? 'block'  : 'none';
  });

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
})();
</script>`;

    // Inject picker
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${picker}\n</body>`);
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `${picker}\n</head>`);
    } else {
      html += picker;
    }

    // Add <base> if missing
    if (!/<base\s/i.test(html)) {
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
      } else {
        html = `<!doctype html><head>${baseTag}</head>` + html;
      }
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("Proxy failed");
  }
}
