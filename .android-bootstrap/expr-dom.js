(function () {
  function desc(el) {
    var cls = (el.getAttribute && el.getAttribute('class') || '').slice(0, 60);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls.replace(/\s+/g, '.') : '') +
      ' [w=' + el.clientWidth + ' h=' + el.clientHeight + ']';
  }
  var out = { body: [], res: [] };
  [].forEach.call(document.body.children, function (c) { out.body.push(desc(c)); });
  var appRoot = document.querySelector('#root, #app, [id*=root]');
  if (appRoot) {
    out.rootDesc = desc(appRoot);
    out.rootHTML = (appRoot.innerHTML || '').slice(0, 600);
    out.rootChildren = [].map.call(appRoot.children, desc).slice(0, 12);
  }
  var txt = (document.body.innerText || '');
  out.textLen = txt.length;
  out.textSample = txt.replace(/\s+/g, ' ').slice(0, 300);
  out.spinNodes = [].slice.call(document.querySelectorAll('[class*=load], [class*=spin], [class*=loading]')).map(desc).slice(0, 10);
  out.spinDetails = [].slice.call(document.querySelectorAll('[class*=load], [class*=spin], [class*=loading]')).map(function (el) {
    var cs = getComputedStyle(el), r = el.getBoundingClientRect(), p = el.parentElement;
    var pr = p ? p.getBoundingClientRect() : null;
    return {
      tag: el.tagName, cls: el.className, html: (el.outerHTML || '').slice(0, 500),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      animation: cs.animationName, playState: cs.animationPlayState, zIndex: cs.zIndex,
      parent: p ? { cls: p.className, rect: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null } : null
    };
  }).slice(0, 15);
  out.iframes = [].map.call(document.querySelectorAll('iframe'), function (el) {
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return { src: el.src, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, display: cs.display,
      visibility: cs.visibility, opacity: cs.opacity, html: el.outerHTML.slice(0, 500) };
  });
  out.supportsWhere = (function () {
    try { document.querySelector(':where(*)'); return true; } catch (e) { return String(e); }
  })();
  out.spinCss = [].slice.call(document.querySelectorAll('style')).map(function (s) {
    var t = s.textContent || '', snippets = [], re = /ant-spin|spinningContainer/g, m, count = 0;
    while ((m = re.exec(t)) && count < 8) {
      snippets.push(t.slice(Math.max(0, m.index - 100), Math.min(t.length, m.index + 500)));
      count++;
    }
    try {
      [].forEach.call(s.sheet.cssRules, function (r) {
        var ct = r.cssText || '';
        if ((ct.indexOf('ant-spin') >= 0 || ct.indexOf('spinningContainer') >= 0) && snippets.length < 20) snippets.push(ct);
      });
    } catch (e) { snippets.push('CSS_RULES_ERROR:' + e.message); }
    return snippets.length ? { attrs: s.getAttributeNames().map(function (n) { return n + '=' + s.getAttribute(n); }), snippets: snippets } : null;
  }).filter(Boolean);
  out.cssLinks = [].map.call(document.querySelectorAll('link[rel=stylesheet]'), function (l) { return l.href; });
  out.allTags = {};
  [].forEach.call(document.querySelectorAll('*'), function (e) { out.allTags[e.tagName] = (out.allTags[e.tagName] || 0) + 1; });
  var res = performance.getEntriesByType('resource');
  out.res = res.map(function (r) {
    return { n: r.name.replace(/^https?:\/\/[^/]+/, '').slice(0, 70), d: Math.round(r.duration), s: r.responseStatus || 0 };
  }).sort(function (a, b) { return b.d - a.d; }).slice(0, 12);
  out.now = Date.now();
  return out;
})()
