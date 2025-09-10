// /api/proxy.js
// Serverless HTML proxy that injects an element-picker.
// - Safer: blocks private/loopback IPs (incl. IPv6 & redirects)
// - Injected script avoids nested template literals to prevent parse issues.

import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (compatible; Hullify-Inspector/1.1)';
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 15000;

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a << 8) + (parseInt(o, 10) || 0), 0) >>> 0;
}
function inRange(n, a, b) { return n >= a && n <= b; }

function isPrivateAddress(address, family) {
  // IPv6-mapped IPv4 (e.g., ::ffff:127.0.0.1)
  if (address.startsWith('::ffff:')) {
    address = address.replace(/^::ffff:/, '');
    family = 4;
  }

  if (family === 4) {
    const n = ipv4ToInt(address);
    return (
      inRange(n, ipv4ToInt('10.0.0.0'),   ipv4ToInt('10.255.255.255'))   || // 10/8
      inRange(n, ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255'))   || // 172.16/12
      inRange(n, ipv4ToInt('192.168.0.0'),ipv4ToInt('192.168.255.255'))  || // 192.168/16
      inRange(n, ipv4ToInt('127.0.0.0'),  ipv4ToInt('127.255.255.255'))  || // loopback
      inRange(n, ipv4ToInt('169.254.0.0'),ipv4ToInt('169.254.255.255'))  || // link-local
      inRange(n, ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255'))  || // CGNAT
      inRange(n, ipv4ToInt('0.0.0.0'),    ipv4ToInt('0.255.255.255'))       // invalid
    );
  }

  // IPv6
  const a = address.toLowerCase();
  return (
    a === '::1' ||                     // loopback
    a === '::'  ||                     // unspecified
    a.startsWith('fc') || a.startsWith('fd') || // fc00::/7 unique local
    a.startsWith('fe80:')              // fe80::/10 link-local
  );
}

async function assertPublicHost(hostname) {
  // Resolve all A/AAAA; block if any private
  const answers = await dns.lookup(hostname, { all: true });
  if (!answers || answers.length === 0) throw new Error('DNS resolution failed');
  for (const a of answers) {
    if (isPrivateAddress(a.address, a.family)) {
      throw new Error('Blocked private/loopback address');
    }
  }
}

async function fetchHtmlWithValidation(urlStr, depth = 0, signal) {
  if (depth > MAX_REDIRECTS) throw new Error('Too many redirects');
  const u = new URL(urlStr);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http/https allowed');

  await assertPublicHost(u.hostname);

  const resp = await fetch(u.href, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'user-agent': UA, 'accept': 'text/html,*/*;q=0.8' },
    signal
  });

  // Handle manual redirects safely (re-validate host each hop)
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location');
    if (!loc) throw new Error('Redirect without Location header');
    const next = new URL(loc, u);
    return fetchHtmlWithValidation(next.href, depth + 1, signal);
  }

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('text/html')) throw new Error('Target is not an HTML page');

  const html = await resp.text();
  return { html, finalUrl: u };
}

// Build the picker injection without nested template literals or ${}
function buildPickerScript() {
  return `
<script>
(function(){
  try { if (window.parent) window.parent.postMessage({type:'picker-ready'}, '*'); } catch(e){}
  var picking = false, overlay, label;

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

  var esc = (window.CSS && CSS.escape) ? CSS.escape : function(v){ return String(v).replace(/[^\\w-]/g, '\\\\$&'); };
  function isHashy(c){ return /__|--/.test(c) || /[0-9]/.test(c) || /[A-Z].*[A-Z]/.test(c) || c.length > 24; }
  function semanticClasses(el){
    var list = el.classList ? Array.from(el.classList) : [];
    return list.filter(function(c){ return !isHashy(c); }).sort(function(a,b){ return a.length - b.length; }).slice(0,2);
  }
  function tagAndClasses(el){
    var tag = el.tagName.toLowerCase();
    var cls = semanticClasses(el);
    return tag + (cls.length ? cls.map(function(c){return '.'+esc(c);}).join('') : '');
  }
  function nthOfType(el){ var i=1, n=el; while((n=n.previousElementSibling)) if (n.tagName===el.tagName) i++; return i; }
  function count(sel){ try { return document.querySelectorAll(sel).length; } catch { return 9999; } }

  function fullPath(el){
    var parts=[], cur=el, hops=0;
    while (cur && cur.nodeType===1 && hops<10){
      var tag=cur.tagName.toLowerCase();
      var id = cur.id ? '#'+esc(cur.id) : '';
      var cls = semanticClasses(cur).map(function(c){return '.'+esc(c);}).join('');
      var part = tag + id + cls;
      var sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter(function(n){return n.tagName===cur.tagName;}) : [];
      if (sibs.length>1) part += ':nth-of-type(' + nthOfType(cur) + ')';
      parts.unshift(part);
      if (id) break;
      cur = cur.parentElement; hops++;
    }
    return parts.join(' > ');
  }

  var CTA_TOKENS = /(^|\\b)(start|get|try|sign|sign up|buy|shop|learn|join|download|create|book|add|subscribe|continue|choose|begin|explore|build|launch)(\\b|!|\\?|\\.|\\s|$)/i;
  var CLASS_TOKENS = /(btn|button|cta|primary|action)/i;

  function looksButtonLike(el){
    if (!el || el.nodeType!==1) return false;
    if (el.tagName==='BUTTON') return true;
    if (el.getAttribute('role')==='button') return true;
    if (CLASS_TOKENS.test(el.className || '')) return true;
    var s = getComputedStyle(el);
    var pad = ['Top','Right','Bottom','Left'].map(function(side){ return parseFloat(s['padding'+side]||'0'); }).reduce(function(a,b){return a+b;},0);
    var bg = s.backgroundColor && s.backgroundColor !== 'transparent' && !/rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)/i.test(s.backgroundColor);
    var radius = parseFloat(s.borderTopLeftRadius||'0') + parseFloat(s.borderBottomRightRadius||'0');
    var cursor = s.cursor;
    var display = s.display;
    return (pad >= 16 && (cursor==='pointer' || display!=='inline')) || bg || radius >= 6;
  }
  function looksCTA(el){
    var txt = (el.textContent || '').trim().toLowerCase();
    if (CTA_TOKENS.test(txt)) return true;
    if (CLASS_TOKENS.test(el.className || '')) return true;
    return false;
  }
  function suggestSelector(el){
    if (looksButtonLike(el) && looksCTA(el)) return '.cta-button';
    if (looksButtonLike(el)) return '.button';
    return null;
  }

  function uniqueSelector(el){
    if (!el || el.nodeType!==1) return '';
    if (el.id && count('#'+esc(el.id))===1) return '#'+esc(el.id);

    var baseSelf = tagAndClasses(el);
    if (count(baseSelf)===1) return baseSelf;

    var selfNth = baseSelf + ':nth-of-type(' + nthOfType(el) + ')';
    if (count(selfNth)===1) return selfNth;

    var cur = el.parentElement, depth=0, baseChild = baseSelf;
    while (cur && depth<4){
      var parentPart = '';
      if (cur.id && count('#'+esc(cur.id))>=1) parentPart = '#'+esc(cur.id);
      else parentPart = tagAndClasses(cur);

      var candidate = parentPart + ' > ' + baseChild;
      if (count(candidate)===1) return candidate;

      candidate = parentPart + ' > ' + baseSelf + ':nth-of-type(' + nthOfType(el) + ')';
      if (count(candidate)===1) return candidate;

      var parentNth = parentPart.indexOf(':nth-of-type(') >= 0 ? parentPart : parentPart + ':nth-of-type(' + nthOfType(cur) + ')';
      candidate = parentNth + ' > ' + baseSelf;
      if (count(candidate)===1) return candidate;

      cur = cur.parentElement; depth++;
    }
    return fullPath(el);
  }

  function colorToCss(v){
    if (!v) return null;
    if (v==='transparent' || /rgba\\(\\s*0\\s*,\\s*0\\s*,\\s*0\\s*,\\s*0\\s*\\)/i.test(v)) return null;
    var m = v.match(/rgba?\\(([^)]+)\\)/i);
    if (!m) return v;
    var parts = m[1].split(',').map(function(s){ return parseFloat(s.trim()); });
    var r=parts[0], g=parts[1], b=parts[2], a=parts[3];
    if (parts.length===4 && a < 1) return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
    function clamp255(x){ x = Math.round(Math.max(0, Math.min(255, x||0))); return x.toString(16).padStart(2,'0'); }
    return '#' + clamp255(r) + clamp255(g) + clamp255(b);
  }

  function sides(s, base){
    var t=s.getPropertyValue(base+'-top'), r=s.getPropertyValue(base+'-right'), b=s.getPropertyValue(base+'-bottom'), l=s.getPropertyValue(base+'-left');
    if (!t && !r && !b && !l) return null;
    if (t===b && r===l){ if (t===r) return t; return t + ' ' + r; }
    if (r===l) return t + ' ' + r + ' ' + b;
    return t + ' ' + r + ' ' + b + ' ' + l;
  }

  function borderShorthand(s){
    var w=s.borderTopWidth, st=s.borderTopStyle, c=colorToCss(s.borderTopColor);
    var wR=s.borderRightWidth, stR=s.borderRightStyle, cR=colorToCss(s.borderRightColor);
    var wB=s.borderBottomWidth, stB=s.borderBottomStyle, cB=colorToCss(s.borderBottomColor);
    var wL=s.borderLeftWidth, stL=s.borderLeftStyle, cL=colorToCss(s.borderLeftColor);
    var allEq = (w===wR && w===wB && w===wL && st===stR && st===stB && st===stL && c===cR && c===cB && c===cL);
    if (allEq && w!=='0px' && st!=='none' && c){ return w + ' ' + st + ' ' + c; }
    return null;
  }

  function radiusShorthand(s){
    var tl=s.borderTopLeftRadius, tr=s.borderTopRightRadius, br=s.borderBottomRightRadius, bl=s.borderBottomLeftRadius;
    if (tl===tr && tr===br && br===bl) return tl;
    return tl + ' ' + tr + ' ' + br + ' ' + bl;
  }

  function extractCss(el, selector){
    var s = getComputedStyle(el);
    var out = [];

    var disp = s.display; if (disp && disp!=='inline') out.push(['display', disp]);
    var pos = s.position; if (pos && pos!=='static') out.push(['position', pos]);
    var overflow = s.overflow; if (overflow && overflow!=='visible') out.push(['overflow', overflow]);

    var m = sides(s,'margin'); if (m && !/^0(px)?$/i.test(m)) out.push(['margin', m]);
    var p = sides(s,'padding'); if (p && !/^0(px)?$/i.test(p)) out.push(['padding', p]);

    if ((disp||'').indexOf('flex') >= 0){
      var fd=s.flexDirection; if (fd && fd!=='row') out.push(['flex-direction', fd]);
      var jc=s.justifyContent; if (jc && jc!=='normal' && jc!=='flex-start') out.push(['justify-content', jc]);
      var ai=s.alignItems; if (ai && ai!=='normal' && ai!=='stretch') out.push(['align-items', ai]);
      var gap=s.gap; if (gap && !/^0(px)?$/i.test(gap)) out.push(['gap', gap]);
    }

    var ff=s.fontFamily; if (ff) out.push(['font-family', ff.replaceAll('"','\\"')]);
    var fz=s.fontSize;  if (fz) out.push(['font-size', fz]);
    var fw=s.fontWeight; if (fw && fw!=='400') out.push(['font-weight', fw]);
    var lh=s.lineHeight; if (lh && lh!=='normal') out.push(['line-height', lh]);
    var ls=s.letterSpacing; if (ls && ls!=='normal' && ls!=='0px') out.push(['letter-spacing', ls]);
    var tt=s.textTransform; if (tt && tt!=='none') out.push(['text-transform', tt]);
    var ta=s.textAlign; if (ta && ta!=='start') out.push(['text-align', ta]);
    var td=s.textDecorationLine; if (td && td!=='none') out.push(['text-decoration', td]);

    var color=colorToCss(s.color); if (color) out.push(['color', color]);
    var bg=colorToCss(s.backgroundColor); if (bg) out.push(['background-color', bg]);
    var bgImg=s.backgroundImage; if (bgImg && bgImg!=='none') out.push(['background-image', bgImg]);
    var bgSize=s.backgroundSize; if (bgSize && bgImg && bgImg!=='none') out.push(['background-size', bgSize]);
    var bgPos=s.backgroundPosition; if (bgPos && bgImg && bgImg!=='none') out.push(['background-position', bgPos]);

    var bAll=borderShorthand(s);
    if (bAll){ out.push(['border', bAll]); }
    else {
      var bt=s.borderTopWidth, bst=s.borderTopStyle, bc=colorToCss(s.borderTopColor);
      if (bst!=='none' && bt!=='0px' && bc) out.push(['border-top', bt+' '+bst+' '+bc]);
      var br=s.borderRightWidth, brst=s.borderRightStyle, brc=colorToCss(s.borderRightColor);
      if (brst!=='none' && br!=='0px' && brc) out.push(['border-right', br+' '+brst+' '+brc]);
      var bb=s.borderBottomWidth, bbst=s.borderBottomStyle, bbc=colorToCss(s.borderBottomColor);
      if (bbst!=='none' && bb!=='0px' && bbc) out.push(['border-bottom', bb+' '+bbst+' '+bbc]);
      var bl=s.borderLeftWidth, blst=s.borderLeftStyle, blc=colorToCss(s.borderLeftColor);
      if (blst!=='none' && bl!=='0px' && blc) out.push(['border-left', bl+' '+blst+' '+blc]);
    }

    var rad=radiusShorthand(s); if (rad && rad!=='0px') out.push(['border-radius', rad]);
    var sh=s.boxShadow; if (sh && sh!=='none') out.push(['box-shadow', sh]);

    var cur=s.cursor; if (cur && cur!=='auto') out.push(['cursor', cur]);
    var tr=s.transition; if (tr && tr!=='all 0s ease 0s' && tr!=='0s') out.push(['transition', tr]);

    var sel = selector || uniqueSelector(el);
    var lines = out.map(function(kv){ return '  ' + kv[0] + ': ' + kv[1] + ';'; });
    var css = sel + ' {\\n' + lines.join('\\n') + '\\n}';
    return css;
  }

  function onMove(e){
    if (!picking) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;
    var r = el.getBoundingClientRect();
    overlay.style.display='block';
    overlay.style.left = (r.left - 2) + 'px';
    overlay.style.top  = (r.top  - 2) + 'px';
    overlay.style.width  = (r.width  + 4) + 'px';
    overlay.style.height = (r.height + 4) + 'px';
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#'+el.id : '');
    label.style.display='block';
    label.style.left = (r.left) + 'px';
    label.style.top  = (Math.max(0, r.top - 22)) + 'px';
    try { if (window.parent) window.parent.postMessage({type:'hover', payload:{ tag: el.tagName.toLowerCase() }}, '*'); } catch(e){}
  }

  function onClick(e){
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === overlay || el === label) return;
    var r = el.getBoundingClientRect();
    var suggested = suggestSelector(el);
    var selectorMin  = suggested || uniqueSelector(el);
    var selectorPath = fullPath(el);
    var cssBlock = extractCss(el, suggested || null);
    var parts = selectorMin.split(/\\s*>\\s*/);
    var pretty = parts.map(function(p,i){ return (i ? Array(i+1).join('  ') : '') + p; }).join(' >\\n');

    try {
      if (window.parent) window.parent.postMessage({
        type:'select',
        payload:{
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          classes: el.classList ? Array.from(el.classList) : [],
          rect: { x:r.x, y:r.y, width:r.width, height:r.height },
          selectorMin: selectorMin,
          selectorPretty: pretty,
          selectorPath: selectorPath,
          cssBlock: cssBlock
        }
      }, '*');
    } catch(e){}
  }

  window.addEventListener('message', function(e){
    if (!e.data || e.data.type!=='toggle-picker') return;
    picking = !!e.data.picking;
    ensureOverlay();
    overlay.style.display = picking ? 'block' : 'none';
    label.style.display   = picking ? 'block' : 'none';
  });

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
})();
</script>`;
}

export default async function handler(req, res) {
  try {
    const raw = req.query.u || new URL(req.url, 'http://x').searchParams.get('u');
    if (!raw) return res.status(400).send('Missing ?u=');

    let target;
    try { target = new URL(raw); } catch { return res.status(400).send('Invalid URL'); }
    if (!/^https?:$/.test(target.protocol)) return res.status(400).send('Only http/https allowed');

    // Fast block obvious local hosts by name
    const host = target.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return res.status(400).send('Blocked private/localhost targets');
    }

    // Timeout
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    const { html: originalHtml, finalUrl } = await fetchHtmlWithValidation(target.href, 0, ac.signal);
    clearTimeout(t);

    // Strip inline meta CSPs (headers aren't forwarded anyway)
    let html = originalHtml.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');

    // Ensure relative URLs resolve correctly
    const baseTag = `<base href="${finalUrl.origin}${finalUrl.pathname.replace(/[^/]*$/, '')}">`;

    // Inject picker
    const picker = buildPickerScript();
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
    const msg = (e && e.message) ? e.message : 'Proxy failed';
    const code = /Blocked private|Only http|Invalid URL|Missing \?u=|Target is not an HTML page|Too many redirects/.test(msg) ? 400 : 500;
    res.status(code).send(msg);
  }
}
