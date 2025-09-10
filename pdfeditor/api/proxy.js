// /api/proxy.js
// Serverless HTML proxy that injects an element-picker. Now suggests
// semantic selectors like `.cta-button` instead of raw hashed classes.

export default async function handler(req, res) {
  try {
    const u = req.query.u || new URL(req.url, 'http://x').searchParams.get('u');
    if (!u) return res.status(400).send("Missing ?u=");

    let target;
    try { target = new URL(u); } catch { return res.status(400).send("Invalid URL"); }
    if (!/^https?:$/.test(target.protocol)) return res.status(400).send("Only http/https allowed");

    // Block obvious private ranges / localhost
    const host = target.hostname.toLowerCase();
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

    // Remove inline CSP meta (headers aren't preserved anyway)
    html = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');

    // Make relative URLs work
    const baseTag = `<base href="${target.origin}${target.pathname.replace(/[^/]*$/, '')}">`;

    // Inject picker with CTA-aware selector suggestion
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
    // Button-ish if has padding, pointer, non-inline or bg/radius
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

    // Prefer semantic suggestion when available
    const suggested = suggestSelector(el);          // '.cta-button' | '.button' | null
    const selectorMin  = suggested || uniqueSelector(el);
    const selectorPath = fullPath(el);

    window.parent && window.parent.postMessage({
      type:'select',
      payload:{
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        classes: el.classList ? Array.from(el.classList) : [],
        rect: { x:r.x, y:r.y, width:r.width, height:r.height },
        selectorMin,
        selectorPretty: pretty(selectorMin),
        selectorPath
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

    // Add <base> if not present
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
