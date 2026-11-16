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
  out.allTags = {};
  [].forEach.call(document.querySelectorAll('*'), function (e) { out.allTags[e.tagName] = (out.allTags[e.tagName] || 0) + 1; });
  var res = performance.getEntriesByType('resource');
  out.res = res.map(function (r) {
    return { n: r.name.replace(/^https?:\/\/[^/]+/, '').slice(0, 70), d: Math.round(r.duration), s: r.responseStatus || 0 };
  }).sort(function (a, b) { return b.d - a.d; }).slice(0, 12);
  out.now = Date.now();
  return out;
})()
