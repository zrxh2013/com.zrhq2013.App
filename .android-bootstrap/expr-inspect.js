(function () {
  var d = Object.getOwnPropertyDescriptor(document, 'cookie');
  var cookieVal = '';
  try { cookieVal = document.cookie; } catch (e) { cookieVal = 'THROW:' + e.message; }
  var bodyText = (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
  var imgs = [].map.call(document.querySelectorAll('img'), function (i) { return (i.src || '').slice(0, 80) + '|complete=' + i.complete + '|' + i.naturalWidth; });
  return {
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    cookieOwn: d ? { configurable: d.configurable, src: String(d.get).slice(0, 80) } : null,
    cookieVal: cookieVal.slice(0, 200),
    elements: document.querySelectorAll('*').length,
    bodyText: bodyText,
    bodyChildCount: document.body ? document.body.children.length : -1,
    imgCount: imgs.length,
    imgs: imgs.slice(0, 6),
    hasAggregateError: typeof AggregateError,
    hasPromiseAny: typeof Promise.any,
    perfEntries: (performance.getEntriesByType ? performance.getEntriesByType('resource').length : -1),
    failed: (performance.getEntriesByType ? performance.getEntriesByType('resource').filter(function (e) { return e.responseStatus >= 400 || e.responseStatus === 0; }).map(function (e) { return e.name.slice(0, 90) + ' s=' + e.responseStatus; }).slice(0, 10) : [])
  };
})()
