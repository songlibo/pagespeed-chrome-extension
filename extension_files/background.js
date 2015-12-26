// Copyright 2012 Google Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

var _gaq = _gaq || [];
_gaq.push(['_setAccount', 'UA-49788333-1']);
_gaq.push(['_trackPageview']);

(function() {
  var ga = document.createElement('script'); ga.type = 'text/javascript'; ga.async = true;
  ga.src = 'https://ssl.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);
})();

var WEBTESTLAB= {
  // Log the msg and callback done.
  log: function (msg,done) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST","http://webtestlab.appspot.com/post");
    xhr.setRequestHeader(
        "Content-type","application/x-www-form-urlencoded");
    xhr.onreadystatechange = function() {
      if (xhr != null && xhr.readyState == 4) {
        if (done) {
          setTimeout(function(){ done()}, 50);
        }
      }
    };

    var to_send = "content="+encodeURIComponent(msg.replace(/\n/g, '\\n'));
    to_send += "&url=pagespeed-with-pnacl-background-page";
    xhr.send(to_send);
  }
};

var pagespeed_bg = {
  re: new RegExp('^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$'),
  // Defined the message type constants for communications between PageSpeed
  // panel page and the background page. This must match pagespeed.js.
  LISTEN_FOR_PAGE_EVENT_TYPE: 1002,
  CANCEL_RUN_TYPE: 1003,
  PAGE_NAVIGATED: 1004,
  PAGE_LOADED: 1005,
  RUN_PAGESPEED_TYPE: 1006,
  RUN_PAGESPEED_COMPLETE_TYPE: 1007,

  // Map from DevTools tab IDs to client objects.  Each client object has the
  // following fields:
  //     tab_id: which tab is this client
  //     request_id: what message this client is expecting
  //     har: the page HAR, in JSON form
  //     document: the page document, in JSON form
  //     timeline: array of timeline records, in JSON form
  //     resource_filter: a string indicating which resource filter to use.
  //     locale: locale string
  //     port: a port object connected to this client's DevTools page
  activeClients: {},
  listenTargets: {},

  // String contains NaCl module loading progress. It will be cleared if the
  // module is loaded successfully.
  naclLoadingMessage: '',

  // Wrap a function with an error handler.  Given a function, return
  // a new function that behaves the same but catches and logs errors
  // thrown by the wrapped function. If 'client' is specified, the
  // message is sent to that client only. If 'client' is null, the
  // message is broadcast to all active clients.
  withErrorHandler: function(client, func) {
    // Remove the first arg.
    var boundArgs = Array.prototype.slice.call(arguments, 2);
    return function(/*arguments*/) {
      try {
        // Prepend boundArgs to the new args.
        var newArgs = Array.prototype.slice.call(arguments);
        Array.prototype.unshift.apply(newArgs, boundArgs);
        return func.apply(this, newArgs);
      } catch (e) {
        pagespeed_bg.displayErrorAndEndCurrentRun('ERROR', e, client);
      }
    };
  },

  // Display the given error message or stack trace by popping up an
  // alert and broadcasting the message to interested clients.
  displayErrorAndEndCurrentRun: function(msg, e, client) {
    if (client) {
      pagespeed_bg.endCurrentRun(client);
      pagespeed_bg.setStatusText(client, msg);
    } else {
      pagespeed_bg.cancelAllActiveClients(msg);
    }

    // Prefer the stack trace if available, otherwise use the message.
    var message = e ? e.stack : msg;
    message = 'Error in PageSpeed background page:\n' +
        message + '\n';
    if (pagespeed_bg.naclLoadingMessage !== '') {
      message += pagespeed_bg.naclLoadingMessage + '\n';
    }

    alert(message + '\n\nPlease file a bug at\n' +
          'https://github.com/songlibo/pagespeed-chrome-extension/issues');
    console.log(message);
  },

  cancelAllActiveClients: function(msg) {
    // First, make a local copy of the collection of clients, since
    // invoking endCurrentRun modifies pagespeed_bg.activeClients
    // (most likely via an async callback, but we make the local copy
    // just in case).
    var clients = [];
    for (var clientId in pagespeed_bg.activeClients) {
      clients.push(pagespeed_bg.activeClients[clientId]);
    }

    for (var i = 0, len = clients.length; i < len; ++i) {
      var client = clients[i];
      pagespeed_bg.endCurrentRun(client);
      pagespeed_bg.setStatusText(client, msg);
    }
  },

  // Given a client object, return true if it is still active, or false if it
  // has been cancelled.
  isClientStillActive: function(client) {
    return (client.port &&
            client.port.name in pagespeed_bg.activeClients);
  },

  // Handle connections from DevTools panels.
  connectHandler: function(port) {
    port.onMessage.addListener(pagespeed_bg.withErrorHandler(
        null, pagespeed_bg.messageHandler, port));
    port.postMessage({kind: 'options',
                      runAtOnLoad: !!localStorage.getItem('runAtOnLoad')});
  },

  // Handle messages from DevTools panels.
  messageHandler: function(port, request) {
    var tab_id = request.tab_id;
    if (request.type === pagespeed_bg.LISTEN_FOR_PAGE_EVENT_TYPE) {
      pagespeed_bg.listenTargets[tab_id] = port;
      port.onDisconnect.addListener(pagespeed_bg.withErrorHandler(null,
                                                                  function() {
        delete pagespeed_bg.listenTargets[tab_id];
      }));
    } else if (request.kind === 'runPageSpeed') {
      var client = {
        har: request.har,
        document: request.document,
        timeline: request.timeline,
        resource_filter: request.resource_filter,
        locale: request.locale,
        save_optimized_content: !localStorage.noOptimizedContent,
        port: port
      };
      pagespeed_bg.activeClients[tab_id] = client;
      port.onDisconnect.addListener(pagespeed_bg.withErrorHandler(client,
                                                                  function() {
        delete pagespeed_bg.activeClients[tab_id];
      }));
      // Before we can run PageSpeed analysis, we need to make sure
      // that the data in the HAR is complete first.
      pagespeed_bg.fetchPartialResources_(client);
    } else if (request.kind === 'cancelRun') {
      delete pagespeed_bg.activeClients[tab_id];
    } else {
      throw new Error('Unknown message kind:' + request.kind);
    }
  },

  fetchPartialResources_: function(client) {
    pagespeed_bg.setStatusText(client, 'Fetching partial resources...');

    var fetchContext = {};

    // We track in-progress requests in a map, so we know when there
    // are no resources left being fetched. This is a map from URL to
    // the XHR instance for that URL.
    fetchContext.xhrs = {};

    // Add a key to count the number of outstanding resources.
    fetchContext.numOutstandingResources = 0;

    // Hold on to the current client instance.
    fetchContext.client = client;

    var har = client.har.log;
    for (var i = 0, len = har.entries.length; i < len; ++i) {
      var entry = har.entries[i];

      // First check to see that basic data is available for this
      // entry.
      if (!entry || !entry.request || !entry.response) {
        var url = '<unknown_url>.';
        if (entry && entry.request && entry.request.url) {
          url = entry.request.url;
        }
        console.log('Incomplete resource ' + url);
        continue;
      }

      var url = entry.request.url;

      // The HAR sometimes includes entries for about:blank and other
      // URLs we don't care about. Ignore them.
      if (url.substr(0, 4) !== 'http') {
        continue;
      }

      var content = entry.response.content;
      var isRawBinaryResponse = content &&
          !pagespeed_bg.isTextMimeType(content.mimeType) &&
          content.encoding !== 'base64';
      if (isRawBinaryResponse) {
        // Chrome Developer Tools has a bug where it sometimes
        // attempts to return a non-base64 encoded response for binary
        // data. In this case we must discard the response body, since
        // it's not safe to attempt to pass to the native client
        // module. Note that it would be better to try to convert the
        // binary string to a base64-encoded string directly here, but
        // it's not clear that that is possible, so we instead clear
        // the data and refetch as binary data via an XHR.
        content.text = '';
        content.encoding = '';
        content.size = 0;
      }

      // We only re-issue requests for GETs. If not a GET, skip it.
      if (entry.request.method !== 'GET') {
        continue;
      }

      // We do not request redirect URLs, because XHR will follow redirections.
      if (entry.response.status === 301 || entry.response.status === 302 ||
          entry.response.status === 303 || entry.response.status === 307) {
        continue;
      }

      if (entry.response.status >= 400) {
        console.log(url + ' ' + entry.response.status +
            ' ' + content.mimeType +
            ' context.size = ' +
            content.size + ' context.encoding = ' + content.encoding);
      }
      if (entry.response.status >= 400) {
        // Chrome may mess up the base64 encodig here.
        if (content.encoding === 'base64') {
          if (content.text.length % 4 !== 0) {
            content.encoding = '';
            console.log('Updated the encoding set.');
          } else if (!pagespeed_bg.re.test(content.text)) {
            content.encoding = '';
            console.log('Updated the encoding set.');
          }
        }
      }
      // There are 3 known cases where Chrome Developer Tools
      // Extension APIs give us partial data: 304 responses (partial
      // HTTP headers), responses from cache (in which case there are
      // no HTTP headers), and responses without bodies that have a
      // content length greater than zero.
      var is304Response = (entry.response.status === 304);
      var hasNoResponseHeaders =
          !entry.response.headers || entry.response.headers.length == 0;
      var isMissingResponseBody =
          (!content || !content.text || content.text.length == 0) &&
          entry.response.bodySize !== 0;

      // Some resources contain noncharacters, which causes message passing to
      // fail between javascript and NaCl.
      // See: http://code.google.com/p/page-speed/issues/detail?id=740
      if (!isMissingResponseBody && content.encoding !== 'base64') {
        // NOTE: this could be slow for large response to check each character.
        // A better fix may need devtools to guarantee the HAR contains valid
        // unicode content.
        var newText = pagespeed_bg.replaceNonCharacters(content.text);
        if (newText) {
          content.text = newText;
          // This fixes the problem for not passing the data to NaCl, but the
          // optimized content may not work the as original one. We disable
          // optimizing content with this change by passing this customized HAR
          // field to NaCl module.
          content.modified = true;
        }
      }

      if (!hasNoResponseHeaders &&
          !is304Response &&
          !isMissingResponseBody &&
          !isRawBinaryResponse) {
        // Looks like we should have all the data for this
        // response. No need to re-fetch.
        continue;
      }

      if (url in fetchContext.xhrs) {
        // Only fetch each resource once. Sometimes the HAR file will
        // contain more than one entry for the same resource. We
        // process the first entry for a given URL, which is the only
        // one that the PageSpeed library will analyze.
        continue;
      }

      // Create an XHR to fetch the resource. Add it to the
      // fetchContext before invoking send() in case the response
      // somehow arrives synchronously (IE's message pump has strange
      // behavior so it's best that we program defensively here).
      var xhr = new XMLHttpRequest();
      fetchContext.xhrs[url] = xhr;
      fetchContext.numOutstandingResources++;

      // Abort any requests that take longer than 5 seconds, since
      // some requests are "hanging GETs" that never return.
      var timeoutCallbackId = setTimeout(
          pagespeed_bg.withErrorHandler(
              client, pagespeed_bg.abortXmlHttpRequest_, xhr, url),
          5000);

      xhr.onreadystatechange = pagespeed_bg.withErrorHandler(
          client,
          pagespeed_bg.onReadyStateChange,
          xhr, entry, fetchContext, timeoutCallbackId);
      try {
        xhr.open('GET', url, true);
        if (!pagespeed_bg.isTextMimeType(content.mimeType)) {
          // Request to get the response data in the form of an
          // ArrayBuffer.  If we don't do this, the XHR tends to try
          // to interpret binary data as UTF8-encoded text, which
          // doesn't work out very well.
          xhr.responseType = 'arraybuffer';
        }
        xhr.send();
      } catch (e) {
        console.log('Failed to request resource ' + url);
        delete fetchContext.xhrs[url];
        fetchContext.numOutstandingResources--;
        clearTimeout(timeoutCallbackId);
      }
    }

    if (fetchContext.numOutstandingResources == 0) {
      // We have no outstanding resources being fetched, so move on to
      // the next stage of processing.
      delete fetchContext.client;
      pagespeed_bg.runPageSpeed(client);
    }
  },

  abortXmlHttpRequest_: function(xhr, url) {
    console.log('Aborting XHR for ' + url);
    // Calling xhr.abort() will trigger a callback to
    // onReadyStateChange, where the XHR has a status code of
    // zero. According to the XHR spec, this may change at some time
    // in the future, so we need to watch for that and update the code
    // if necessary.
    xhr.abort();
  },

  onReadyStateChange: function(xhr, entry, fetchContext, timeoutCallbackId) {
    if (!pagespeed_bg.isClientStillActive(fetchContext.client)) {
      // We're processing a callback for an old client. Ignore it.
      return;
    }

    if (xhr.readyState !== 4) {
      // Non-final state, so return.
      return;
    }

    clearTimeout(timeoutCallbackId);

    var url = entry.request.url;
    if (!url in fetchContext.xhrs) {
      console.log('No such xhr ' + url);
      return;
    }

    delete fetchContext.xhrs[url];
    fetchContext.numOutstandingResources--;

    // Invoke the callback with an error handler so we continue on and
    // finish the next stage of processing, even if one of our XHR
    // responses doesn't process correctly.
    var wrappedResponseHandler = pagespeed_bg.withErrorHandler(
        fetchContext.client, pagespeed_bg.onXhrResponse);
    wrappedResponseHandler(xhr, entry);

    if (fetchContext.numOutstandingResources == 0) {
      // We're done fetching outstanding resources, so move on to the
      // next phase of processing.
      var client = fetchContext.client;
      delete fetchContext.client;
      pagespeed_bg.runPageSpeed(client);
    }
  },

  onXhrResponse: function(xhr, entry) {
    var url = entry.request.url;

    // The server may 304 if the browser issues a conditional get,
    // however the lower-level network stack will synthesize a proper
    // 200 response for the XHR.
    if (xhr.status !== 200) {
      console.log('Got non-200 response ' + xhr.status + ' for ' + url);
      return;
    }

    pagespeed_bg.updateResponseHeaders(xhr, entry);
    pagespeed_bg.updateResponseBody(xhr, entry);
    entry.response.status = 200;
  },

  updateResponseHeaders: function(xhr, entry) {
    function getHeaderKeyValue(headerLine) {
      // Find the first colon and split key, value at that point.
      var separatorIdx = headerLine.indexOf(':');
      if (separatorIdx === -1) {
        console.log('Failed to get valid header from ' + headerLine);
        return null;
      }
      var k = headerLine.substr(0, separatorIdx).trim().toLowerCase();
      var v = headerLine.substr(separatorIdx + 1).trim();
      return { name: k, value: v };
    }

    var is304Response = (entry.response.status === 304);
    var hasNoResponseHeaders =
        !entry.response.headers || entry.response.headers.length == 0;
    if (!is304Response && !hasNoResponseHeaders) {
      // The entry isn't one that meets the criteria for needing
      // updated headers, so don't update headers.
      return;
    }

    // We'll store all headers in the allResponseHeaders map, which is
    // a map from header name to an array of values. We store an array
    // of values rather than a single value since HTTP headers with
    // the same name are allowed to appear multiple times in a single
    // response.
    var allResponseHeaders = {};

    // Map the HAR headers, which are stored in an array, into a map,
    // so we can easily look headers up by keyname.
    var harHeadersArray = entry.response.headers;
    if (!harHeadersArray) {
      harHeadersArray = [];
    }
    for (var i = 0, len = harHeadersArray.length; i < len; ++i) {
      var kv = harHeadersArray[i];
      var key = kv.name.toLowerCase();
      if (!allResponseHeaders[key]) {
        allResponseHeaders[key] = [];
      }
      allResponseHeaders[key].push(kv.value);
    }

    // Get the headers from the XHR.
    var xhrResponseHeadersStr = xhr.getAllResponseHeaders().split('\n');
    if (xhrResponseHeadersStr[xhrResponseHeadersStr.length - 1].trim() === '') {
      // Remove the last entry, which is an empty newline.
      xhrResponseHeadersStr.pop();
    }

    // Remove any header entries from the HAR for which there is also
    // an entry in the XHR. The XHR headers are more accurate.
    for (var i = 0, len = xhrResponseHeadersStr.length; i < len; ++i) {
      var kv = getHeaderKeyValue(xhrResponseHeadersStr[i]);
      if (kv) {
        allResponseHeaders[kv.name] = [];
      }
    }

    // Add the XHR headers to the allResponseHeaders map.
    for (var i = 0, len = xhrResponseHeadersStr.length; i < len; ++i) {
      var kv = getHeaderKeyValue(xhrResponseHeadersStr[i]);
      if (kv) {
        allResponseHeaders[kv.name].push(kv.value);
      }
    }

    // Construct a new HAR-style header array that contains all the
    // headers.
    var responseHeadersArray = [];
    for (var key in allResponseHeaders) {
      for (var i = 0, len = allResponseHeaders[key].length; i < len; ++i) {
        responseHeadersArray.push(
            {name: key, value: allResponseHeaders[key][i]});
      }
    }

    entry.response.headers = responseHeadersArray;
  },

  updateResponseBody: function(xhr, entry) {
    var content = entry.response.content;
    if (!content || (content.text && content.text.length > 0)) {
      // Either there's no content entry, or we already have a
      // response body, so there's nothing more to do.
      return;
    }

    var bodyEncoded;
    var encoding;

    if (xhr.responseType == 'arraybuffer') {
      // Get the content as raw binary data.  Since we set
      // xhr.responseType to 'arraybuffer', xhr.response will be an
      // ArrayBuffer object (except that it may be null for empty
      // responses, in which case we create an empty Uint8Array).
      var bodyBytes = (xhr.response === null ? new Uint8Array() :
                       new Uint8Array(xhr.response));
      var bodySize = bodyBytes.length;
      // Encode the binary content into base64.  For now, the
      // following mess is the easiest way I know how to do this.
      // Hopefully someday there will be an easier way. Note that this
      // mechanism does not handle multi-byte characters correctly,
      // however, we attempt to only fetch binary resources as
      // arraybuffers so this should not be a problem for us.
      var bodyCharacters = [];
      for (var index = 0; index < bodySize; ++index) {
        bodyCharacters.push(String.fromCharCode(bodyBytes[index]));
      }
      bodyEncoded = btoa(bodyCharacters.join(''));
      encoding = 'base64';
    } else {
      // Replace possible non-characters.
      var newText = pagespeed_bg.replaceNonCharacters(xhr.responseText);
      if (newText) {
        bodyEncoded = newText;
        // This fixes the problem for not passing the data to NaCl, but the
        // optimized content may not work the as original one. We disable
        // optimizing content with this change by passing this customized HAR
        // field to NaCl module.
        content.modified = true;
      } else {
        bodyEncoded = xhr.responseText;
      }

      encoding = '';
      bodySize = bodyEncoded.length;
    }

    // Update the content fields with the new data.
    content.text = bodyEncoded;
    content.size = bodySize;
    content.encoding = encoding;
  },

  runPageSpeed: function(client) {
    console.log('Loading PNaCl module ...');
    pagespeed_bg.setStatusText(client, 'Loading PNaCl module ... ' +
        '(Experimental. Loading can be slow, especially for ' +
        'the first time installed or updated.)');

    // Before we can actually invoke page speed, we need to make sure
    // the native client module has been loaded. If it hasn't been
    // loaded, we'll be notified via this async callback when it's
    // available.
    var callback = pagespeed_bg.runPageSpeedImpl.bind(null, client);
    var pagespeed_module = document.getElementById('pagespeed-module');
    if (!pagespeed_module) {
      pagespeed_bg.start_load_NaCl = +new Date();
      console.log(+new Date() + ' Start load NaCl.');
      chrome.runtime.getPlatformInfo(function (platformInfo) {
        pagespeed_bg.loadNaclModule(platformInfo, client,
            pagespeed_bg.withErrorHandler(null, callback));
      });
    } else if (pagespeed_module.lastError) {
      _gaq.push(['_trackEvent', 'error', pagespeed_module.lastError]);
      pagespeed_bg.displayErrorAndEndCurrentRun(
          'Pagespeed module error:' + pagespeed_module.lastError);
      document.body.removeChild(pagespeed_module);
    } else if (pagespeed_module.readyState != 4) {
      pagespeed_module.addEventListener('loadend', callback);
    } else {
      callback();
    }
  },

  loadNaclModule: function(platformInfo, client, callback) {
    console.log('Loading pageseed module.');
    // Create an embed element to load our NaCl module. We do this on
    // demand the first time it's needed, rather than declaring it in
    // background.html, to avoid incurring module load time as part of
    // Chrome startup time.
    var pagespeed_module = document.createElement('embed');
    pagespeed_module.id = 'pagespeed-module';
    pagespeed_module.src =
        'pagespeed-pnacl.nmf';
    pagespeed_module.type = 'application/x-pnacl';

    // Clear the previous NaCl loading message to prevent it from growing too
    // long.
    pagespeed_bg.naclLoadingMessage = '';

    // Debugging NaCl module loading.
    pagespeed_module.addEventListener('loadstart',
        pagespeed_bg.onNaclDidStartLoad, true);
    pagespeed_module.addEventListener('progress',
        pagespeed_bg.onNaclLoadProgress.bind(null, client), true);
    pagespeed_module.addEventListener('error',
        pagespeed_bg.onNaclLoadError, true);
    pagespeed_module.addEventListener('abort',
        pagespeed_bg.onNaclLoadAbort, true);
    pagespeed_module.addEventListener('load', pagespeed_bg.onNaclDidLoad, true);
    pagespeed_module.addEventListener('loadend',
        pagespeed_bg.onNaclDidEndLoad, true);

    // The 'message' callback is the callback by which messages posted
    // from the NaCl module are delivered to us.
    pagespeed_module.addEventListener(
        'message',
        pagespeed_bg.withErrorHandler(null, pagespeed_bg.onNaclResponse));

    // Set up a callback to be notified both if the module loads
    // successfully as well as if it fails to load.
    pagespeed_module.addEventListener('loadend', callback);

    // Set up a callback to be invoked if the NaCl module crashes
    // while executing.
    pagespeed_module.addEventListener(
        'crash',
        function() {
          _gaq.push(['_trackEvent', 'error', pagespeed_module.lastError]);
          pagespeed_bg.displayErrorAndEndCurrentRun(pagespeed_module.lastError);
          // Once the module has crashed, it must be removed from the
          // DOM (and a new one added) before we can run it again.
          document.body.removeChild(pagespeed_module);
        });

    // Append the module to the DOM. The module will begin loading
    // once it has been added to the DOM.
    document.body.appendChild(pagespeed_module);

    // The NaCl module is not loaded in the background page due to this bug:
    // https://code.google.com/p/chromium/issues/detail?id=350445
    // From there a work-around was suggested: in your Javascript that creates
    // the new plugin embed, request the 'offsetTop' property of the new plugin
    // element. This should force the layout engine to recalculate.
    console.log('Work around Chromium issue 350445. ' +
        'Bring up the module at offsetTop: ' + pagespeed_module.offsetTop);
  },

  runPageSpeedImpl: function(client) {
    if (!pagespeed_bg.isClientStillActive(client)) {
      // We're processing a callback for an old client. Ignore it.
      return;
    }

    pagespeed_bg.setStatusText(client, chrome.i18n.getMessage('running_rules'));
    var pagespeed_module = document.getElementById('pagespeed-module');
    if (pagespeed_module.lastError) {
      _gaq.push(['_trackEvent', 'error', pagespeed_module.lastError]);
      pagespeed_bg.displayErrorAndEndCurrentRun(
          'Pagespeed module has an error: ' + pagespeed_module.lastError);
      document.body.removeChild(pagespeed_module);
      return;
    }
    if (pagespeed_module.readyState != 4) {
      pagespeed_bg.displayErrorAndEndCurrentRun(
          'Native client module not ready: ' + pagespeed_module.readyState);
      return;
    } else {
      // Clear the NaCl loading message.
      pagespeed_bg.naclLoadingMessage = '';
    }

    if (!!localStorage.limitHarSize) {
      var limit = Number(localStorage.limitHarSize);
      var har = client.har.log;
      var totalSize = 0;
      for (var i = 0, len = har.entries.length; i < len; ++i) {
        var entry = har.entries[i];
        totalSize += JSON.stringify(entry).length;
        if (totalSize > limit * 1000000) { // 15MB
          entry.response.content.text = '';
          entry.response.content.encoding = '';
          entry.response.content.size = 0;
        }
      }
    }

    var tabId = client.port.name;
    var msg = {
      id: String(tabId),
      mobile: client.mobile,
      har: JSON.stringify(client.har),
      document: JSON.stringify(client.document),
      timeline: JSON.stringify(client.timeline),
      resource_filter: client.resource_filter,
      locale: client.locale,
      save_optimized_content: client.save_optimized_content
    };

    // Create a string that is the msg with the tabId prepended. When the NaCl
    // module receives the message, it may be able to extract the tabId part,
    // even if it fails to parse the input msg. It then can send back the error
    // message to corresponding tab.
    var msg_with_id = String(tabId) + ',' + JSON.stringify(msg);
    console.log('Total size send to NaCl: ' + msg_with_id.length);
    _gaq.push(['_trackEvent', 'runPageSpeed', 'run']);
    pagespeed_module.postMessage(msg_with_id);
  },

  // Search the first 10 characters for a ',', parse the characters before ','
  // as int, and return it.
  extractTabId: function(str) {
    var searchPart = str.substr(0, 10);
    var commaPosition = searchPart.indexOf(',');
    if (commaPosition <= 0) {
      return Number.NaN;
    }
    var clientId = str.substr(0, commaPosition);
    if (clientId === 'unknown') {
      return -1;
    }
    return parseInt(clientId);
  },

  // Search for a ',' and the return the substring that follows the comma.
  // This function must be called after extractTabId is successful, because it
  // does not check for error, and assuming the ',' exists.
  extractMessage: function(str) {
    var commaPosition = str.indexOf(',');
    return str.substr(commaPosition + 1);
  },

  onNaclDidStartLoad: function() {
      console.log(+new Date() + ' NaCl startLoad');
      pagespeed_bg.naclLoadingMessage += ' NaCl startLoad;';
  },

  onNaclLoadError: function() {
      console.log('NaCl loadError');
      pagespeed_bg.naclLoadingMessage += ' NaCl loadError;';
  },

  onNaclLoadAbort: function() {
      console.log('NaCl loadAbort');
      pagespeed_bg.naclLoadingMessage += ' NaCl loadAbort;';
  },

  onNaclDidLoad: function() {
      pagespeed_bg.naclLoadingMessage += ' NaCl didLoad;';
  },

  onNaclDidEndLoad: function() {
      console.log((+new Date() - pagespeed_bg.start_load_NaCl) + ' NaCl loadEnd');
      pagespeed_bg.naclLoadingMessage += ' NaCl loadEnd;';
      WEBTESTLAB.log((+new Date() - pagespeed_bg.start_load_NaCl) + ' NaCl loadEnd');
  },

  // Invoked when the NaCl module loading progress updates.
  onNaclLoadProgress: function(client, event) {
      var loadPercent = 0.0;
      var loadPercentString;
      if (event.lengthComputable && event.total > 0) {
        loadPercent = event.loaded / event.total * 100.0;
        loadPercentString = loadPercent.toFixed(0) + '%';
      } else {
        // The total length is not yet known.
        loadPercent = -1.0;
        loadPercentString = 'NaCl progress:';
      }

      // console.log((+new Date() - pagespeed_bg.start_load_NaCl) + ' NaCl loading ' +
      //    event.loaded + '/' + event.total);
      pagespeed_bg.setStatusText(client, 'Loading PNaCl module ... ' +
          + loadPercent.toFixed(0) + '%' +
          ' (Experimental. Loading can be slow for the first time installed' +
          ' or updated.)');

      // Limit the message length. Each progress is at most 30 characters. We
      // think about 20 progress updates are enough, so the length is limited by
      // 600. And we want to see the load is 100%, so keep the last update,
      // which is loaded === total.
      if (pagespeed_bg.naclLoadingMessage.length < 600 ||
          event.loaded === event.total) {
        pagespeed_bg.naclLoadingMessage += ' ' + loadPercentString +
            '(' + event.loaded + '/' + event.total + ');';
      }
  },

  // Invoked when the NaCl module sends a message to us.
  onNaclResponse: function(responseMsg) {
    // We also expect the responseMsg has the client tabId at the beginning of
    // the result or error string.
    var clientId = pagespeed_bg.extractTabId(responseMsg.data);
    if (isNaN(clientId)) {
      pagespeed_bg.displayErrorAndEndCurrentRun(
          'Failed to extract the tabId of the result.');
      return;
    }

    var client = pagespeed_bg.activeClients[clientId];
    if (clientId !== -1 && !client) {
      // Silently ignore the result because the client is not active anymore.
      return;
    }

    // Let's get the result.
    var result = null;
    try {
      result = JSON.parse(pagespeed_bg.extractMessage(responseMsg.data));
    } catch (e) {
      pagespeed_bg.displayErrorAndEndCurrentRun('JSON parse error', e, client);
      return;
    }
    if (result.error) {
        pagespeed_bg.displayErrorAndEndCurrentRun(
            'Result error: ' + result.error, null, client);
    } else {
      pagespeed_bg.postMessage(client, 'onRunPageSpeedComplete', result);
    }
  },

  setStatusText: function(client, msg) {
    pagespeed_bg.postMessage(client, 'status', msg);
  },

  endCurrentRun: function(client) {
    pagespeed_bg.postMessage(client, 'endCurrentRun', '');
  },

  postMessage: function(client, kind, value) {
    if (pagespeed_bg.isClientStillActive(client)) {
      client.port.postMessage({
        kind: kind,
        value: value
      });
    }
  },

  isTextMimeType: function(mimeType) {
    if (!mimeType || mimeType.length == 0) return false;
    mimeType = mimeType.toLowerCase();

    if (mimeType.substr(0, 5) == 'text/') return true;

    // See http://www.w3.org/TR/xhtml-media-types/
    if (mimeType.indexOf('/xhtml') > -1) return true;
    if (mimeType.indexOf('/xml') > -1) return true;
    if (mimeType.indexOf('+xml') > -1) return true;

    // See http://www.w3.org/wiki/HTML/Elements/script
    if (mimeType.indexOf('javascript') > -1) return true;
    if (mimeType.indexOf('ecmascript') > -1) return true;
    if (mimeType.indexOf('/jscript') > -1) return true;
    if (mimeType.indexOf('/livescript') > -1) return true;

    // We assume that everything else is binary. This includes
    // application/* not covered by the cases above, as well as
    // image/*.
    return false;
  },

  // Replace non-characters in text with U+FFFD (REPLACEMENT CHARACTER).
  // Return: the text with replaced code point, or null if no replacedment.
  replaceNonCharacters: function(text) {
    if (!text) {
      return null;
    }
    var newText = '';
    var length = text.length;
    var lastInvalidCharacterIndex = -1;
    for (var idx = 0; idx < length; ++idx) {
      if (pagespeed_bg.isNonCharacter(text.charCodeAt(idx))) {
        newText += text.substring(lastInvalidCharacterIndex + 1, idx);
        newText += '\uFFFD'; // Replace the non-character.
        lastInvalidCharacterIndex = idx;
      }
    }
    if (lastInvalidCharacterIndex === -1) {
      return null;
    }
    newText += text.substring(lastInvalidCharacterIndex + 1);
    return newText;
  },

  // Unicode defines sixty-six code points as non-characters (labeled <not a
  // character>), never to change. In these 66, the last two code points of each
  // plane are included. So, noncharacters are: U+FFFE and U+FFFF on the BMP,
  // U+1FFFE and U+1FFFF on Plane 1, and so on, up to U+10FFFE and U+10FFFF on
  // Plane 16, for a total of 34 code points. In addition, there is a contiguous
  // range of another 32 noncharacter code points in the BMP: U+FDD0..U+FDEF.
  // See:
  // http://en.wikipedia.org/wiki/Mapping_of_Unicode_characters#Noncharacters
  isNonCharacter: function(code) {
    // To optimize this a bit.
    if (code < 0xFDD0) {
      return false;
    }

    if (code >= 0xFDD0 && code <= 0xFDEF) {
      return true;
    }

    var root = code & 0xffff;
    if (root === 0xFFFF || root === 0xFFFE) {
      return true;
    }
    return false;
  },

  // Callback for when a user navigates a tab elsewhere.
  onBeforeNavigate: function(details) {
    if (!!localStorage.enableDebug) {
      console.log('BeforeNavigate: tabId=' + details.tabId + ' frameId=' +
                  details.frameId);
    }
    if (details.frameId !== 0) {
      // A subframe is navigated. Skip it.
      return;
    }

    var port = pagespeed_bg.listenTargets[details.tabId];
    if (port) {
      port.postMessage({type: pagespeed_bg.PAGE_NAVIGATED});
    }
  },

  // Callback for when a page completes loading.
  onCompleted: function(details) {
    if (!!localStorage.enableDebug) {
      console.log('OnCompleted: tabId=' + details.tabId + ' frameId=' +
                  details.frameId);
    }
    if (details.frameId !== 0) {
      // A subframe is loaded. Skip it.
      return;
    }
    var port = pagespeed_bg.listenTargets[details.tabId];
    if (port) {
      port.postMessage({type: pagespeed_bg.PAGE_LOADED,
                        autoRun: !!localStorage.getItem('runAtOnLoad')});
    }
  }

};

chrome.browserAction.setBadgeBackgroundColor({color: [0, 200, 0, 100]});
chrome.browserAction.setBadgeText({text: 'beta'});

pagespeed_bg.withErrorHandler(null, function() {

  // Listen for connections from DevTools panels:
  if (chrome.runtime.onConnect) {
    chrome.runtime.onConnect.addListener(
        pagespeed_bg.withErrorHandler(null, pagespeed_bg.connectHandler));
  } else {
    chrome.extension.onConnect.addListener(
        pagespeed_bg.withErrorHandler(null, pagespeed_bg.connectHandler));
  }

  // Listen for when navigation is happening:
  chrome.webNavigation.onBeforeNavigate.addListener(
    pagespeed_bg.withErrorHandler(null, pagespeed_bg.onBeforeNavigate));

  // Listen for when a page completely loads:
  chrome.webNavigation.onCompleted.addListener(
    pagespeed_bg.withErrorHandler(null, pagespeed_bg.onCompleted));

})();
