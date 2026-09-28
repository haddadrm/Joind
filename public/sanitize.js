// Message HTML sanitizer. Every message, quote and pending-message body is
// Markdown rendered by marked, and marked keeps raw HTML, so its output is
// passed through DOMPurify with an allowlist before it reaches the DOM.
// Any agent (or a linked server) can post a message, and the viewer's
// browser holds the web token, so nothing a message says may run script.
//
// Loaded as a plain script in the page (defines window.joindSanitizeHtml)
// and required by the tests under Node with a jsdom window.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
  } else {
    root.joindSanitizeHtml = factory(root.DOMPurify);
  }
})(typeof window !== 'undefined' ? window : this, function(DOMPurify) {
  'use strict';
  if (!DOMPurify || typeof DOMPurify.sanitize !== 'function') {
    // No sanitizer, no HTML: the caller renders plain text instead.
    return null;
  }

  // What marked produces for the Markdown messages use today.
  var ALLOWED_TAGS = [
    'p', 'br', 'hr', 'em', 'strong', 'del', 's', 'code', 'pre', 'kbd',
    'ul', 'ol', 'li', 'input',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'blockquote', 'a', 'img',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6'
  ];
  var ALLOWED_ATTR = ['href', 'title', 'src', 'alt', 'align', 'start', 'type', 'checked', 'disabled', 'class'];
  // http(s), mailto, and same-origin relative or fragment URLs. Everything
  // else (javascript:, vbscript:, data:, file:, and any other scheme) goes.
  var SAFE_URL = /^(?:https?:|mailto:|\/(?!\/)|\.{1,2}\/|#|\?|[^\s:\/?#]+(?:[\/?#]|$))/i;
  var CODE_CLASS = /^language-[\w+#.-]{1,40}$/;

  var purifier = DOMPurify;
  purifier.addHook('uponSanitizeAttribute', function(node, data) {
    var name = data.attrName;
    var value = String(data.attrValue || '').replace(/[\u0000-\u0020\u007f-\u009f]+/g, '');
    if (name === 'href' || name === 'src') {
      if (!SAFE_URL.test(value)) data.keepAttr = false;
      return;
    }
    if (name === 'class') {
      // Only a code block's language class; no page classes can be borrowed.
      if (node.nodeName !== 'CODE' || !CODE_CLASS.test(value)) data.keepAttr = false;
      return;
    }
    if (name === 'type' || name === 'checked' || name === 'disabled') {
      if (node.nodeName !== 'INPUT') data.keepAttr = false;
    }
  });
  purifier.addHook('afterSanitizeAttributes', function(node) {
    if (node.nodeName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.nodeName === 'INPUT') {
      // A task-list checkbox only: never a live form control.
      if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
        node.parentNode && node.parentNode.removeChild(node);
        return;
      }
      node.setAttribute('disabled', '');
    }
  });

  return function sanitizeHtml(html) {
    return purifier.sanitize(String(html), {
      ALLOWED_TAGS: ALLOWED_TAGS,
      ALLOWED_ATTR: ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ALLOWED_URI_REGEXP: SAFE_URL,
      KEEP_CONTENT: true,
      WHOLE_DOCUMENT: false,
      RETURN_TRUSTED_TYPE: false
    });
  };
});
