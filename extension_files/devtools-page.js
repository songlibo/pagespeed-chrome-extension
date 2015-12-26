'use strict';
// Create the visible DevTools panel/tab.
if (chrome.devtools && chrome.devtools.panels) {
  chrome.devtools.panels.create('PageSpeed',
      'images/pagespeed-32.png', 'pagespeed-panel.html');
} else {
  alert('Chrome DevTools extension API is not available.');
}
