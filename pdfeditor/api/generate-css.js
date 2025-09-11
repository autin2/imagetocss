// /api/proxy.js
// Serverless HTML proxy that injects an element-picker. The picker returns
// a semantic selector (.cta-button/.button/unique) *and* a full CSS block
// that includes pseudo-elements, real shadows, and font details.

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
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Hullify-Inspector/1.1)' }
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

  // ---------- CSS extraction (adds drop-shadow + stronger typography + pseudo-elements) ----------
  function extractCss(el, selector){
    const s = getComputedStyle(el);
    const out = [];

    // layout
    const disp = s.display; if (disp && disp !== 'inline') out.push(['display', disp]);
    const pos  = s.position; if (pos && pos !== 'static') out.push(['position', pos]);
    const overflow = s.overflow; if (overflow && overflow !== 'visible') out.push(['overflow', overflow]);

    // spacing helper
    const sides = (base) => {
      const t=s.getPropertyValue(base+'-top'), r=s.getPropertyValue(base+'-right'),
            b=s.getPropertyValue(base+'-bottom'), l=s.getPropertyValue(base+'-left');
      if (!t && !r && !b && !l) return null;
      if (t===b && r===l){ return (t===r) ? t : \`\${t} \${r}\`; }
      if (r===l) return \`\${t} \${r} \${b}\`;
      return \`\${t} \${r} \${b} \${l}\`;
    };
    const m = sides('margin');  if (m && !/^0(px)?$/i.test(m)) out.push(['margin', m]);
    const p = sides('padding'); if (p && !/^0(px)?$/i.test(p)) out.push(['padding', p]);

    // flex alignment
    if ((disp || '').includes('flex')) {
      const fd=s.flexDirection;   if (fd && fd!=='row') out.push(['flex-direction', fd]);
      const jc=s.justifyContent;  if (jc && !/^(normal|flex-start)$/.test(jc)) out.push(['justify-content', jc]);
      const ai=s.alignItems;      if (ai && !/^(normal|stretch)$/.test(ai)) out.push(['align-items', ai]);
      const gap=s.gap;            if (gap && !/^0(px)?$/i.test(gap)) out.push(['gap', gap]);
    }

    // typography
    const ff=s.fontFamily;             if (ff) out.push(['font-family', ff.replaceAll('"','\\"')]);
    const fz=s.fontSize;               if (fz) out.push(['font-size', fz]);
    const fw=s.fontWeight;             if (fw) out.push(['font-weight', fw]);
    const lh=s.lineHeight;             if (lh && lh!=='normal') out.push(['line-height', lh]);
    const ls=s.letterSpacing;          if (ls && ls!=='normal' && ls!=='0px') out.push(['letter-spacing', ls]);
    const fs=s.fontStyle;              if (fs && fs!=='normal') out.push(['font-style', fs]);
    const fv=s.fontVariant;            if (fv && fv!=='normal') out.push(['font-variant', fv]);
    const tAlign=s.textAlign;          if (tAlign && tAlign!=='start') out.push(['text-align', tAlign]);
    const tDec=s.textDecorationLine;   if (tDec && tDec!=='none') out.push(['text-decoration', tDec]);

    // colors / background
    const color=s.color; if (color && color!=='rgba(0, 0, 0, 0)') out.push(['color', color]);
    const bgImg=s.backgroundImage, bgCol=s.backgroundColor;
    if (bgImg && bgImg!=='none' && /gradient\\(/i.test(bgImg)) {
      out.push(['background-image', bgImg]);
      const bgSize=s.backgroundSize; if (bgSize) out.push(['background-size', bgSize]);
      const bgPos=s.backgroundPosition; if (bgPos) out.push(['background-position', bgPos]);
      const bgRep=s.backgroundRepeat; if (bgRep && bgRep!=='repeat') out.push(['background-repeat', bgRep]);
    } else if (bgCol && bgCol!=='transparent' && !/rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)/.test(bgCol)) {
      out.push(['background-color', bgCol]);
    }

    // borders
    const allEq = ['top','right','bottom','left'].every(side =>
      s.getPropertyValue('border-top-width')  === s.getPropertyValue(\`border-\${side}-width\`) &&
      s.getPropertyValue('border-top-style')  === s.getPropertyValue(\`border-\${side}-style\`) &&
      s.getPropertyValue('border-top-color')  === s.getPropertyValue(\`border-\${side}-color\`)
    );
    if (allEq && s.borderTopStyle!=='none' && s.borderTopWidth!=='0px') {
      out.push(['border', \`\${s.borderTopWidth} \${s.borderTopStyle} \${s.borderTopColor}\`]);
    } else {
      ['top','right','bottom','left'].forEach(side => {
        const w=s.getPropertyValue(\`border-\${side}-width\`);
        const st=s.getPropertyValue(\`border-\${side}-style\`);
        const c=s.getPropertyValue(\`border-\${side}-color\`);
        if (st!=='none' && w!=='0px' && c) out.push([\`border-\${side}\`, \`\${w} \${st} \${c}\`]);
      });
    }

    // radius / shadows / filters
    const radius = (() => {
      const tl=s.borderTopLeftRadius, tr=s.borderTopRightRadius, br=s.borderBottomRightRadius, bl=s.borderBottomLeftRadius;
      return (tl===tr && tr===br && br===bl) ? tl : \`\${tl} \${tr} \${br} \${bl}\`;
    })();
    if (radius && radius!=='0px') out.push(['border-radius', radius]);

    const boxShadow=s.boxShadow;  if (boxShadow && boxShadow!=='none') out.push(['box-shadow', boxShadow]);
    const textShadow=s.textShadow;if (textShadow && textShadow!=='none') out.push(['text-shadow', textShadow]);
    const filter=s.filter; if (filter && /drop-shadow\\(/i.test(filter)) out.push(['filter', filter]); // outer shadow via filter

    // cursor & transitions
    const cur=s.cursor; if (cur && cur!=='auto') out.push(['cursor', cur]);
    const tr=s.transition; if (tr && tr!=='all 0s ease 0s' && tr!=='0s') out.push(['transition', tr]);

    // Build selector & main rule
    let sel = selector || uniqueSelector(el);
    const lines = out.map(([k,v]) => \`  \${k}: \${v};\`);
    let css = \`\${sel} {\\n\${lines.join('\\n')}\\n}\`;

    // Append pseudo-elements if meaningful
    const before = extractPseudoCss(el, '::before');
    if (before) css += \`\\n\\n\${sel}::before {\\n\${before}\\n}\`;
    const after = extractPseudoCss(el, '::after');
    if (after) css += \`\\n\\n\${sel}::after {\\n\${after}\\n}\`;

    return css;
  }

  // Extract ::before/::after when they contribute highlights/shadows/etc.
  function extractPseudoCss(el, which){
    const ps = getComputedStyle(el, which);
    if (!ps) return "";

    const content = ps.content;
    const bgImg = ps.backgroundImage, bgCol = ps.backgroundColor;
    const boxSh = ps.boxShadow, textSh = ps.textShadow, filter = ps.filter;

    const hasContent = content && content !== 'none';
    const hasGrad = bgImg && bgImg!=='none' && /gradient\\(/i.test(bgImg);
    const hasSolid = bgCol && bgCol!=='transparent' && !/rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)/i.test(bgCol);
    const hasSh = (boxSh && boxSh!=='none') || (textSh && textSh!=='none') || (filter && /drop-shadow\\(/i.test(filter));

    if (!hasContent && !hasGrad && !hasSolid && !hasSh) return "";

    const L = [];
    if (hasContent) L.push(\`  content: \${content};\`);

    const pos = ps.position; if (pos && pos!=='static') L.push(\`  position: \${pos};\`);
    const t = ps.top, r = ps.right, b = ps.bottom, l = ps.left;
    if (t) L.push(\`  top: \${t};\`);
    if (r) L.push(\`  right: \${r};\`);
    if (b) L.push(\`  bottom: \${b};\`);
    if (l) L.push(\`  left: \${l};\`);

    const w = ps.width, h = ps.height;
    if (w && w!=='auto') L.push(\`  width: \${w};\`);
    if (h && h!=='auto') L.push(\`  height: \${h};\`);

    if (hasGrad) {
      L.push(\`  background-image: \${bgImg};\`);
    } else if (hasSolid) {
      L.push(\`  background-color: \${bgCol};\`);
    }
    if (boxSh && boxSh!=='none') L.push(\`  box-shadow: \${boxSh};\`);
    if (textSh && textSh!=='none') L.push(\`  text-shadow: \${textSh};\`);
    if (filter && /drop-shadow\\(/i.test(filter)) L.push(\`  filter: \${filter};\`);

    const tl=ps.borderTopLeftRadius, tr=ps.borderTopRightRadius, br=ps.borderBottomRightRadius, bl=ps.borderBottomLeftRadius;
    const radius = (tl===tr && tr===br && br===bl) ? tl : \`\${tl} \${tr} \${br} \${bl}\`;
    if (radius && radius!=='0px') L.push(\`  border-radius: \${radius};\`);

    const pe=ps.pointerEvents; if (pe && pe!=='auto') L.push(\`  pointer-events: \${pe};\`);

    return L.join('\\n');
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
    const cssBlock = extractCss(el, suggested || null); // falls back internally

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
