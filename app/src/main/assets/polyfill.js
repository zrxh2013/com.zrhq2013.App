/* WebView(Chrome 83 / API30) 兼容补丁 —— 通过 DOCUMENT_START_SCRIPT 注入所有框架与 iframe */
(function (global) {
  'use strict';
  if (!global) return;
  var define = function (obj, name, value) {
    try {
      Object.defineProperty(obj, name, {
        value: value, writable: true, configurable: true, enumerable: false
      });
    } catch (e) { /* 只读对象忽略 */ }
  };

  /* ---- AggregateError ---- */
  if (typeof global.AggregateError === 'undefined') {
    function AggregateError(errors, message) {
      var e = new Error(message === undefined ? '' : String(message));
      Object.setPrototypeOf(e, AggregateError.prototype);
      e.errors = Array.from(errors || []);
      return e;
    }
    AggregateError.prototype = Object.create(Error.prototype, {
      constructor: { value: AggregateError, writable: true, configurable: true },
      name: { value: 'AggregateError', writable: true, configurable: true }
    });
    global.AggregateError = AggregateError;
  }

  /* ---- Promise.any ---- */
  if (typeof Promise.any !== 'function') {
    define(Promise, 'any', function (iterable) {
      var C = this;
      return new C(function (resolve, reject) {
        var items = Array.from(iterable || []);
        if (!items.length) {
          return reject(new global.AggregateError([], 'All promises were rejected'));
        }
        var errors = new Array(items.length);
        var pending = items.length;
        items.forEach(function (p, i) {
          C.resolve(p).then(resolve, function (err) {
            errors[i] = err;
            if (--pending === 0) {
              reject(new global.AggregateError(errors, 'All promises were rejected'));
            }
          });
        });
      });
    });
  }

  /* ---- Object.hasOwn ---- */
  if (typeof Object.hasOwn !== 'function') {
    define(Object, 'hasOwn', function (obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    });
  }

  /* ---- String.prototype.replaceAll ---- */
  if (typeof String.prototype.replaceAll !== 'function') {
    define(String.prototype, 'replaceAll', function (search, replacement) {
      if (search instanceof RegExp) {
        if (!search.global) throw new TypeError('replaceAll must be called with a global RegExp');
        return this.replace(search, replacement);
      }
      return this.split(String(search)).join(String(replacement));
    });
  }

  /* ---- Array / String / TypedArray .at() ---- */
  var atImpl = function (n) {
    var len = this.length >>> 0;
    n = Math.trunc(n) || 0;
    if (n < 0) n += len;
    return n < 0 || n >= len ? undefined : this[n];
  };
  if (typeof Array.prototype.at !== 'function') define(Array.prototype, 'at', atImpl);
  if (typeof String.prototype.at !== 'function') define(String.prototype, 'at', atImpl);
  [
    global.Int8Array, global.Uint8Array, global.Uint8ClampedArray, global.Int16Array,
    global.Uint16Array, global.Int32Array, global.Uint32Array, global.Float32Array,
    global.Float64Array
  ].forEach(function (T) {
    if (T && T.prototype && typeof T.prototype.at !== 'function') define(T.prototype, 'at', atImpl);
  });

  /* ---- Array.prototype.findLast / findLastIndex ---- */
  if (typeof Array.prototype.findLast !== 'function') {
    define(Array.prototype, 'findLast', function (pred, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (pred.call(thisArg, this[i], i, this)) return this[i];
      }
      return undefined;
    });
  }
  if (typeof Array.prototype.findLastIndex !== 'function') {
    define(Array.prototype, 'findLastIndex', function (pred, thisArg) {
      for (var i = this.length - 1; i >= 0; i--) {
        if (pred.call(thisArg, this[i], i, this)) return i;
      }
      return -1;
    });
  }

  /* ---- structuredClone ---- */
  if (typeof global.structuredClone !== 'function') {
    global.structuredClone = function (value) {
      if (value === null || typeof value !== 'object') return value;
      if (typeof value === 'function') throw new TypeError('Cannot clone a function');
      if (global.MessageChannel && global.Blob) {
        /* 由调用方保证同步语义时不可用，退回 JSON 深拷贝 */
      }
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (e) {
        throw new Error('structuredClone fallback failed: ' + e.message);
      }
    };
  }

  /* ---- WeakRef / FinalizationRegistry（空壳，仅防引用崩溃） ---- */
  if (typeof global.WeakRef !== 'function') {
    global.WeakRef = function (target) { this.deref = function () { return target; }; };
  }
  if (typeof global.FinalizationRegistry !== 'function') {
    global.FinalizationRegistry = function () {
      this.register = function () {};
      this.unregister = function () {};
    };
  }

  /* ---- crypto.randomUUID ---- */
  try {
    if (global.crypto && typeof global.crypto.randomUUID !== 'function') {
      define(global.crypto, 'randomUUID', function () {
        var b = new Uint8Array(16);
        if (global.crypto.getRandomValues) global.crypto.getRandomValues(b);
        else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var h = Array.prototype.map.call(b, function (x) {
          return ('0' + x.toString(16)).slice(-2);
        }).join('');
        return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' +
          h.slice(16, 20) + '-' + h.slice(20);
      });
    }
  } catch (e) {}

  /* ---- AbortSignal.timeout ---- */
  if (global.AbortSignal && typeof global.AbortSignal.timeout !== 'function') {
    global.AbortSignal.timeout = function (ms) {
      var c = new global.AbortController();
      setTimeout(function () {
        try { c.abort(new Error('TimeoutError')); } catch (e) { c.abort(); }
      }, ms);
      return c.signal;
    };
  }

  /* ---- Element.replaceChildren ---- */
  if (global.Element && !Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) {
        var n = arguments[i];
        this.appendChild(typeof n === 'string' ? document.createTextNode(n) : n);
      }
    };
  }

  /* ---- antd 5 / Chrome 83：加载结束后隐藏残留图标 ----
   * antd 的动态 CSS 使用 Chrome 88 才支持的 :where()，旧内核会丢弃其中的
   * 非加载态隐藏规则；业务样式又将加载容器固定为 display:flex。
   * 仅隐藏 busy=false 加载器的直接子图标，不影响 nested-loading 的内容，
   * 也不影响 aria-busy=true 时正常显示加载状态。
   */
  try {
    var installIdleSpinCompat = function () {
      var root = document.head || document.documentElement;
      if (!root || document.getElementById('webview-antd-spin-compat')) return;
      var style = document.createElement('style');
      style.id = 'webview-antd-spin-compat';
      style.textContent = '.ant-spin[aria-busy="false"] > .ant-spin-dot{display:none!important}';
      root.appendChild(style);
    };
    installIdleSpinCompat();
    document.addEventListener('DOMContentLoaded', installIdleSpinCompat);
  } catch (e) { }

  /* ---- document.cookie 防篡改锁 ----
   * H5 的 umi.js 在模块顶层无条件调用 disableDocumentCookie()，用 configurable:false
   * 把 document.cookie 换成恒返回 "" 的 getter 与恒返回 false 的 setter，导致登录态
   * cookie（ctoken / 2147450879 / jsh_t_c_e）无法读写，业务请求全部 401 卡在转圈。
   * 这里抢先用自身可配置的访问器锁定，使业务脚本的 defineProperty 抛 TypeError。
   */
  try {
    if (typeof document !== 'undefined' && document &&
        !Object.getOwnPropertyDescriptor(document, 'cookie')) {
      var proto = Object.getPrototypeOf(document);
      var nativeDesc = null;
      while (proto && !nativeDesc) {
        var d = Object.getOwnPropertyDescriptor(proto, 'cookie');
        if (d && typeof d.get === 'function' && typeof d.set === 'function') {
          nativeDesc = d;
        }
        proto = Object.getPrototypeOf(proto);
      }
      if (nativeDesc) {
        Object.defineProperty(document, 'cookie', {
          get: function () { return nativeDesc.get.call(this); },
          set: function (v) { nativeDesc.set.call(this, v); },
          configurable: false,
          enumerable: true
        });
      }
    }
  } catch (e) { /* 若已被业务脚本抢先锁定则无法修复，静默跳过 */ }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
