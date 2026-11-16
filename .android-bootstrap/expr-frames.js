(function () {
  var frames = [].map.call(document.querySelectorAll('iframe'), function (f) {
    var o = { src: (f.getAttribute('src') || 'srcdoc').slice(0, 70), w: f.clientWidth, h: f.clientHeight };
    try { o.ae = typeof f.contentWindow.AggregateError; o.url = (f.contentWindow.location.href || '').slice(0, 70); }
    catch (e) { o.ae = 'x-origin'; }
    return o;
  });
  return {
    workers: typeof Worker,
    workerIsNative: String(Worker).indexOf('[native code]') >= 0,
    ae: typeof AggregateError,
    polySrc: typeof window.__WEBVIEW_POLYFILL_SRC === 'string' ? window.__WEBVIEW_POLYFILL_SRC.length : null,
    frames: frames,
    spin: !!document.querySelector('.ant-spin-spinning'),
    txt: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
    els: document.querySelectorAll('*').length
  };
})()
