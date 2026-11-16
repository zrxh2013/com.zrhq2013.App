(function () {
  return {
    href: location.href.slice(0, 120),
    readyState: document.readyState,
    ae: typeof AggregateError,
    aeAt: typeof Array.prototype.at,
    ra: typeof String.prototype.replaceAll,
    hasOwn: typeof Object.hasOwn,
    txt: (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
    els: document.querySelectorAll('*').length,
    spin: !!document.querySelector('[class*=spin], [class*=loading]'),
    cookie: (document.cookie || '').slice(0, 100)
  };
})()
