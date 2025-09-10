// /api/proxy.js
export default async function handler(req, res) {
  try {
    const u = req.query.u || new URL(req.url, 'http://x').searchParams.get('u');
    if (!u) return res.status(400).send("Missing ?u=");

    let target;
    try { target = new URL(u); } catch { return res.status(400).send("Invalid URL"); }
    if (!/^https?:$/.test(target.protocol)) return res.status(400).send("Only http/https allowed");

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

    // Remove any CSP meta that might block our script; headers aren't forwarded anyway.
    html = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');

    // Ensure relative URLs resolve against the original site.
    const baseTag = `<base href="${target.origin}${target.pathname.replace(/[^/]*$/, '')}">`;

    // Inject picker script before </body> (or </head> fallback)
    const picker = `
<script>
(function(){
  // Tell parent we're ready
  window.parent && window.parent.postMessage({type:'picker-ready'}, '*');

  let picking = false;
  let overlay, label;

  function ensureOverlay(){
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.position='fixed';
    overlay.style.zIndex='2147483646';
    overlay.style.pointerEvents='none';
    overlay.style.border='2px solid #22c55e';
    overlay.style.borderRadius='4px';
    overlay.style.boxShadow='0 0 0 2px rgba(34,197,94,.2)';
    overlay.style.display='none';
    document.documentElement.appendChild(overlay);

    label = document.createElement('div');
    label.style.position='fixed';
    label.style.zIndex='2147483647';
    label.style.pointerEvents='none';
    label.style.background='rgba(34,197,94,.95)';
    label.style.color='#08110a';
    label.style.font='12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    label.style.padding='2px 6px';
    label.style.borderRadius='4px';
    label.style.display='none';
    document.documentElement.appendChild(label);
  }

  function cssPath(el){
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id.replace(/[\\s]/g,'\\\\ ') : '';
      let cls = '';
      if (el.classList && el.classList.length){
        cls = '.' + Array.from(el.classList).slice(0,3).map(c => c.replace(/[\\s]/g,'\\\\ ')).join('.');
      }
      // only add :nth-child if needed
      let part = tag + id + cls;
      if (el.previousElementSibling || el.nextElementSibling) {
        const sibs = el.parentElement ? Array.from(el.parentElement.children).filter(n=>n.tagName===el.tagName) : [];
        if (sibs.length > 1) {
          const idx = sibs.indexOf(el) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(part);
      el = el.parentElement;
      if (id) break; // stop at id
    }
    return parts.join(' > ');
  }

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
    const t = el.tagName.toLowerCase();
    label.textContent = t + (el.id ? '#' + el.id : '') + (el.className ? '.' + String(el.className).trim().replace(/\\s+/g,'.') : '');
    label.style.display='block';
    label.style.left = (r.left) + 'px';
    label.style.top  = (Math.max(0, r.top - 22)) + 'px';

    window.parent && window.parent.postMessage({type:'hover', payload:{
      tag: t
    }}, '*');
  }

  function onClick(e){
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;
    const r = el.getBoundingClientRect();
    const payload = {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      classes: el.classList ? Array.from(el.classList) : [],
      rect: { x:r.x, y:r.y, width:r.width, height:r.height },
      selector: cssPath(el)
    };
    window.parent && window.parent.postMessage({ type:'select', payload }, '*');
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

    const injectAtBody = html.match(/<\/body>/i);
    const injectAtHead = html.match(/<\/head>/i);

    if (injectAtBody) {
      html = html.replace(/<\/body>/i, `${picker}\n</body>`);
    } else if (injectAtHead) {
      html = html.replace(/<\/head>/i, `${picker}\n</head>`);
    } else {
      html += picker;
    }

    // Add <base> if not present
    if (!/<base\s/i.test(html)) {
      if (injectAtHead) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
      } else {
        html = `<!doctype html><head>${baseTag}</head>` + html;
      }
    }

    // Serve as HTML, no CSP to avoid blocking our script
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(html);
  } catch (e) {
    console.error(e);
    res.status(500).send("Proxy failed");
  }
}
