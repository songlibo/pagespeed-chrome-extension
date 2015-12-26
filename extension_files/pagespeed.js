// Copyright 2010 Google Inc. All Rights Reserved.
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

"use strict";
var _gaq = _gaq || [];
_gaq.push(['_setAccount', 'UA-49788333-1']);
_gaq.push(['_trackPageview']);

(function() {
  var ga = document.createElement('script'); ga.type = 'text/javascript'; ga.async = true;
  ga.src = 'https://ssl.google-analytics.com/ga.js';
  var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);
})();


var pagespeed = {
  issues_link:  'https://github.com/songlibo/pagespeed-chrome-extension/issues',

  // A port object connected to the extension background page; this is
  // initialized at the bottom of this file.
  connectionPort: null,

  // The current results, in JSON form.  This is null iff there are no
  // currently displayed results in the UI.
  currentResults: null,

  // The currently active ResourceAccumulator, if any.
  resourceAccumulator: null,

  // The currently active DomCollector, if any.
  domCollector: null,

  // The currently active ContentWriter, if any.
  contentWriter: null,

  // All timeline events that have been recorded from when the page started
  // loading until it finished loading.
  timelineEvents: [],
  pageHasLoaded: true,
  runAtOnLoad: false,

  // Throw an error (with an optional message) if the condition is false.
  assert: function(condition, opt_message) {
    if (!condition) {
      throw new Error('Assertion failed:' + (opt_message || '(no message)'));
    }
  },

  // Wrap a function with an error handler.  Given a function, return a new
  // function that behaves the same but catches and logs errors thrown by the
  // wrapped function.
  withErrorHandler: function(func) {
    pagespeed.assert(typeof(func) === 'function',
                     'withErrorHandler: func must be a function');
    return function(/*arguments*/) {
      try {
        return func.apply(this, arguments);
      } catch (e) {
        var message = 'Error in Page Speed panel:\n ' + e.stack;
        alert(message + '\n\nPlease file a bug at\n' + pagespeed.issues_link);
        pagespeed.endCurrentRun();
        pagespeed.setStatusText('ERROR');
      }
    };
  },

  // Compare the two arguments, as for a sort function.  Useful for building up
  // larger comparators.
  compare: function(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  },

  // Remove all children from the given DOM node.
  removeAllChildren: function(domNode) {
    while (domNode.lastChild) {
      domNode.removeChild(domNode.lastChild);
    }
  },

  getInspectedWindowTabId: function() {
    var tabId = chrome.devtools.inspectedWindow.tabId;
    if (typeof tabId === 'undefined') {
      // This must be the remote inspected window.
      tabId = 9222;
    }
    return tabId;
  },

  // Make a new DOM node.
  // tagName -- the tag name for the node
  // opt_className -- an optional class name for the node; either a string,
  //     or null/omitted for no class name
  // opt_contents -- optional contents for the node; this may be a string, a
  //     DOM node, or an array of strings, DOM nodes, and/or other arrays
  //     (which will be flattened)
  makeElement: function(tagName, opt_className, opt_contents) {
    var elem = document.createElement(tagName);
    if (opt_className) {
      elem.className = opt_className;
    }
    var addChildren = function(children) {
      if (children) {
        if (typeof(children) === 'object' && children.forEach) {
          children.forEach(addChildren);
        } else {
          elem.appendChild(typeof(children) === 'string' ?
                           document.createTextNode(children) : children);
        }
      }
    };
    addChildren(opt_contents);
    return elem;
  },

  // Make a new DOM node for a button.
  // label -- the text label for the button
  // action -- a thunk to be called when the button is pressed
  makeButton: function(label, action) {
    var button = pagespeed.makeElement('button', null, label);
    button.addEventListener('click', pagespeed.withErrorHandler(action),
                            false);
    return button;
  },

  // Make a new DOM node for a link.
  // href -- the URL to link to
  // opt_label -- the visible text for the link (if omitted, use href)
  makeLink: function(href, opt_label) {
    var link = pagespeed.makeElement('a', null, opt_label || href);
    link.href = href;
    link.target = 'blank_';
    return link;
  },

  // Given a score, return a DOM node for a red/yellow/green icon.
  makeScoreIcon: function(score, opt_hasNoResults, opt_isExperimentalRule) {
    pagespeed.assert(typeof(score) === 'number',
                     'makeScoreIcon: score must be a number');
    pagespeed.assert(isFinite(score), 'makeScoreIcon: score must be finite');
    var icon = pagespeed.makeElement('div',
      (opt_hasNoResults ? 'icon-na' : opt_isExperimentalRule ? 'icon-info' :
       score > 80 ? 'icon-okay' : score > 60 ? 'icon-warn' : 'icon-error'));
    icon.setAttribute('title', 'Score: ' + score + '/100');
    return icon;
  },

  // TODO(mdsteele): This is a hack -- impact scores are relative, not
  //   absolute, so we shouldn't be comparing them to constants.  We should
  //   decide on a better way to do this.
  makeImpactIcon: function(impact, opt_hasNoResults, opt_isExperimentalRule) {
    pagespeed.assert(typeof(impact) === 'number',
                     'makeImpactIcon: score must be a number');
    pagespeed.assert(isFinite(impact), 'makeImpactIcon: score must be finite');
    var icon = pagespeed.makeElement('div',
      (opt_hasNoResults ? 'icon-na' : opt_isExperimentalRule ? 'icon-info' :
       impact < 3 ? 'icon-okay' : impact < 10 ? 'icon-warn' : 'icon-error'));
    if (opt_hasNoResults) {
      icon.title = 'No suggestions for this rule. Good job!';
    } else if (opt_isExperimentalRule) {
      icon.title =
          'Experimental rule. Does not yet impact overall score. ' +
          'Send feedback to page-speed-discuss@googlegroups.com.';
    }
    return icon;
  },

  // Set the text of the "Run Page Speed" button (e.g. to "Refresh Results").
  setRunButtonText: function(text) {
    var run_button = document.getElementById('run-button');
    pagespeed.removeAllChildren(run_button);
    run_button.appendChild(document.createTextNode(text));
  },

  // Set the text of the status bar.
  setStatusText: function(text) {
    var status_container = document.getElementById('status-text');
    pagespeed.removeAllChildren(status_container);
    if (text) {
      status_container.appendChild(document.createTextNode(text));
    }
  },

  // Get a version of a URL that is suitable for display in the UI
  // (~100 characters or fewer).
  getDisplayUrl: function(fullUrl) {
    pagespeed.assert(typeof(fullUrl) === 'string',
                     'getDisplayUrl: fullUrl must be a string');
    var kMaxLinkTextLen = 100;
    return (fullUrl.length > kMaxLinkTextLen ?
            fullUrl.substring(0, kMaxLinkTextLen) + '...' :
            fullUrl);
  },

  ruleDocumentationUrl: function(rule_name) {
    return 'http://code.google.com/speed/page-speed/docs/' + ({
      AvoidBadRequests: 'rtt.html#AvoidBadRequests',
      AvoidCssImport: 'rtt.html#AvoidCssImport',
      AvoidDocumentWrite: 'rtt.html#AvoidDocumentWrite',
      CombineExternalCss: 'rtt.html#CombineExternalCSS',
      CombineExternalJavaScript: 'rtt.html#CombineExternalJS',
      EnableGzipCompression: 'payload.html#GzipCompression',
      EnableKeepAlive: 'rtt.html#EnableKeepAlive',
      InlineSmallCss: 'caching.html#InlineSmallResources',
      InlineSmallJavaScript: 'caching.html#InlineSmallResources',
      LeverageBrowserCaching: 'caching.html#LeverageBrowserCaching',
      MinifyCss: 'payload.html#MinifyCSS',
      MinifyHTML: 'payload.html#MinifyHTML',
      MinifyJavaScript: 'payload.html#MinifyJS',
      MinimizeDnsLookups: 'rtt.html#MinimizeDNSLookups',
      MinimizeRedirects: 'rtt.html#AvoidRedirects',
      MinimizeRequestSize: 'request.html#MinimizeRequestSize',
      OptimizeImages: 'payload.html#CompressImages',
      OptimizeTheOrderOfStylesAndScripts: 'rtt.html#PutStylesBeforeScripts',
      ParallelizeDownloadsAcrossHostnames: 'rtt.html#ParallelizeDownloads',
      PreferAsyncResources: 'rtt.html#PreferAsyncResources',
      PutCssInTheDocumentHead: 'rendering.html#PutCSSInHead',
      RemoveQueryStringsFromStaticResources:
        'caching.html#LeverageProxyCaching',
      ServeResourcesFromAConsistentUrl: 'payload.html#duplicate_resources',
      ServeScaledImages: 'payload.html#ScaleImages',
      SpecifyACacheValidator: 'caching.html#LeverageBrowserCaching',
      SpecifyAVaryAcceptEncodingHeader: 'caching.html#LeverageProxyCaching',
      SpecifyCharsetEarly: 'rendering.html#SpecifyCharsetEarly',
      SpecifyImageDimensions: 'rendering.html#SpecifyImageDimensions',
      SpriteImages: 'rtt.html#SpriteImages'
    }[rule_name] || 'rules_intro.html');
  },

  // Given a list of objects produced by
  // FormattedResultsToJsonConverter::ConvertFormatString(),
  // build an array of DOM nodes, suitable to be passed to makeElement().
  formatFormatString: function(format_string) {
    var elements = [];
    var string = format_string.format;
    var index = 0;

    if (format_string.args) {
      for (var idx = 0; idx < format_string.args.length; ++idx) {
        var arg = format_string.args[idx];
        if (arg.type === 'HYPERLINK') {
          index = string.search('{{BEGIN_LINK}}');
          elements.push(string.substr(0, index));
          string = string.substr(index + 14);
          index = string.search('{{END_LINK}}');
          elements.push(pagespeed.makeLink(
              arg.localized_value, string.substr(0, index)));
          string = string.substr(index + 12);
        } else if (arg.type === 'URL') {
          index = string.search('{{URL}}');
          elements.push(string.substr(0, index));
          elements.push(pagespeed.makeLink(arg.localized_value));
          string = string.substr(index + 7);
        } else {
          string = string.replace('{{' + arg['placeholder_key'] + '}}',
              arg['localized_value']);
        }
      }
    }
    elements.push(string);
    return elements;
  },

  formatOptimizedContentIfAny: function(id) {
    if (typeof(id) !== 'number') {
      return null;
    }
    var entry = pagespeed.currentResults.optimizedContent[id.toString()];
    if (!entry || !entry.url) {
      return null;
    }
    return ['  See ', pagespeed.makeLink(entry.url, 'optimized version'), '.'];
  },

  // Given a list of objects produced by
  // FormattedResultsToJsonConverter::ConvertFormattedUrlBlockResults(),
  // build an array of DOM nodes, suitable to be passed to makeElement().
  formatUrlBlocks: function(url_blocks) {
    return (url_blocks || []).map(function(url_block) {
      return pagespeed.makeElement('p', null, [
        pagespeed.formatFormatString(url_block.header),
        pagespeed.formatOptimizedContentIfAny(url_block.associated_result_id),
        (!url_block.urls ? [] :
         pagespeed.makeElement('ul', null, url_block.urls.map(function(url) {
           return pagespeed.makeElement('li', null, [
             pagespeed.formatFormatString(url.result),
             pagespeed.formatOptimizedContentIfAny(url.associated_result_id),
             (!url.details ? [] :
              pagespeed.makeElement('ul', null, url.details.map(function(dt) {
                return pagespeed.makeElement(
                  'li', null, pagespeed.formatFormatString(dt));
              })))]);
         })))]);
    });
  },

  // Expand all the results in the rules list.
  expandAllResults: function() {
    var rules_container = document.getElementById('rules-container');
    if (rules_container) {
      var result_divs = rules_container.childNodes;
      for (var index = 0; index < result_divs.length; ++index) {
        result_divs[index].lastChild.style.display = 'block';
      }
    }
  },

  // Collapse all the results in the rules list.
  collapseAllResults: function() {
    var rules_container = document.getElementById('rules-container');
    if (rules_container) {
      var result_divs = rules_container.childNodes;
      for (var index = 0; index < result_divs.length; ++index) {
        result_divs[index].lastChild.style.display = 'none';
      }
    }
  },

  // Toggle whether a given result DIV is expanded or collapsed.
  toggleResult: function(result_div) {
    if (result_div.lastChild.style.display !== 'block') {
      result_div.lastChild.style.display = 'block';
    } else {
      result_div.lastChild.style.display = 'none';
    }
  },

  // Clear and hide the results page, and make the welcome page visible again.
  clearResults: function() {
    pagespeed.endCurrentRun();
    pagespeed.currentResults = null;
    var results_container = document.getElementById('results-container');
    results_container.style.display = 'none';
    pagespeed.removeAllChildren(results_container);
    var welcome_container = document.getElementById('welcome-container');
    welcome_container.style.display = 'block';
    pagespeed.setRunButtonText(chrome.i18n.getMessage('analyze'));
  },

  // Format and display the current results.
  showResults: function() {
    pagespeed.assert(pagespeed.currentResults !== null,
                     "showResults: pagespeed.currentResults must not be null");

    // Remove the previous results.
    var results_container = document.getElementById('results-container');
    pagespeed.removeAllChildren(results_container);

    // Sort the rule results.  All rules with no results come last, in
    // alphabetical order by rule name.  Experimental rules that have results
    // come second-to-last, ordered by impact (descending) and then by rule
    // name.  Non-experimental rules with results come first, again by impact
    // and then rule name.
    var rule_results = pagespeed.currentResults.results.rule_results.slice();
    rule_results.sort(function(result1, result2) {
      var empty1 = (result1.url_blocks || []).length === 0;
      var empty2 = (result2.url_blocks || []).length === 0;
      return (pagespeed.compare(empty1, empty2) ||
              (empty1 || empty2 ? 0 :
               (pagespeed.compare(!!result1.experimental,
                                  !!result2.experimental) ||
                pagespeed.compare(result2.rule_impact,
                                  result1.rule_impact)))  ||
              pagespeed.compare(result1.localized_rule_name,
                                result2.localized_rule_name));
    });
    var overall_score = pagespeed.currentResults.results.score;

    // Create the score bar.
    var analyze = pagespeed.currentResults.analyze;
    results_container.appendChild(pagespeed.makeElement('div', 'score-bar', [
      pagespeed.makeElement('div', null, chrome.i18n.getMessage(
        (analyze === 'ads' ? 'overall_score_ads' :
         analyze === 'trackers' ? 'overall_score_trackers' :
         analyze === 'content' ? 'overall_score_content' :
         'overall_score_all'), [overall_score])),
      pagespeed.makeScoreIcon(overall_score),
      pagespeed.makeButton(chrome.i18n.getMessage('clear_results'),
                           pagespeed.clearResults),
      pagespeed.makeButton(chrome.i18n.getMessage('collapse_all'),
                           pagespeed.collapseAllResults),
      pagespeed.makeButton(chrome.i18n.getMessage('expand_all'),
                           pagespeed.expandAllResults)
    ]));

    var debug = false;
    try {
      debug = localStorage.debug;
    } catch (e) {
    }
    // Create the rule results.
    var rules_container = pagespeed.makeElement('div');
    rules_container.id = 'rules-container';
    rule_results.forEach(function(rule_result) {
      var header = pagespeed.makeElement('div', 'header', [
        (debug ?
         pagespeed.makeScoreIcon(rule_result.rule_score,
                                 (rule_result.url_blocks || []).length === 0,
                                 rule_result.experimental) :
         pagespeed.makeImpactIcon(rule_result.rule_impact,
                                  (rule_result.url_blocks || []).length === 0,
                                  rule_result.experimental)),
        (debug ? '[' + rule_result.rule_impact + '] ' : null),
        rule_result.localized_rule_name
      ]);
      if (!rule_result.url_blocks) {
        header.style.fontWeight = 'normal';
      }
      var formatted = pagespeed.formatUrlBlocks(rule_result.url_blocks);
      var result_div = pagespeed.makeElement('div', 'result', [
        header,
        pagespeed.makeElement('div', 'details', [
          (formatted.length > 0 ? formatted :
           pagespeed.makeElement('p', null, chrome.i18n.getMessage(
             'no_rule_violations'))),
          pagespeed.makeElement('p', null, pagespeed.makeLink(
            pagespeed.ruleDocumentationUrl(rule_result.rule_name),
            chrome.i18n.getMessage('more_information')))
        ])
      ]);
      rules_container.appendChild(result_div);
      header.addEventListener('mouseover', function() {
        header.style.backgroundColor = '#ddd';
      }, false);
      header.addEventListener('mouseout', function() {
        header.style.backgroundColor = '#eee';
      }, false);
      header.addEventListener('click', function() {
        pagespeed.toggleResult(result_div);
      }, false);
    });
    results_container.appendChild(rules_container);

    // Display the results.
    var welcome_container = document.getElementById('welcome-container');
    welcome_container.style.display = 'none';
    results_container.style.display = 'block';
    pagespeed.setRunButtonText(chrome.i18n.getMessage('refresh_results'));
  },

  showErrorMessage: function(problem) {
    // Remove the previous results.
    var results_container = document.getElementById('results-container');
    pagespeed.removeAllChildren(results_container);

    // Create the error pane.
    var error_container = pagespeed.makeElement('div');
    error_container.id = 'error-container';
    // TODO(mdsteele): Localize these error messages.
    if (problem === 'url') {
      error_container.appendChild(pagespeed.makeElement('p', null, [
        "Sorry, Page Speed can only analyze pages at ",
        pagespeed.makeElement('code', null, 'http://'), " or ",
        pagespeed.makeElement('code', null, 'https://'),
        " URLs.  Please try another page."
      ]));
    } else if (problem === 'moduleDidNotLoad') {
      error_container.appendChild(pagespeed.makeElement('p', null, [
        'Unfortunately, the Page Speed plugin was not able to load.',
        '  The usual reason for this is that "Page Speed Plugin" is disabled',
        ' in the ', pagespeed.makeLink('about:plugins'),
        ' page.  Try enabling "Page Speed Plugin" and then closing and',
        ' reopening the Chrome Developer Tools window, and try again.  If you',
        ' still get this error message, please ',
        pagespeed.makeLink(pagespeed.issues_link, 'file a bug'), '.'
      ]));
    } else {
      throw new Error("Unexpected problem: " + JSON.stringify(problem));
    }
    error_container.appendChild(pagespeed.makeButton(
      'Clear', pagespeed.clearResults)),
    results_container.appendChild(error_container);

    // Display the results.
    var welcome_container = document.getElementById('welcome-container');
    welcome_container.style.display = 'none';
    results_container.style.display = 'block';
    document.getElementById('run-button').disabled = true;
  },

  // Handle messages from the background page (coming over the connectionPort).
  messageHandler: function(message) {
    if (message.kind === 'onRunPageSpeedComplete') {
      pagespeed.onRunPageSpeedComplete(message.value);
    } else if (message.kind === 'status') {
      pagespeed.setStatusText(message.value);
    } else if (message.kind === 'endCurrentRun') {
      pagespeed.endCurrentRun();
    } else if (message.kind === 'options') {
      pagespeed.runAtOnLoad = message.runAtOnLoad;
    } else {
      throw new Error('Unknown message kind: ' + message.kind);
    }
  },

  // Run Page Speed and display the results. This is done asynchronously using
  // the ResourceAccumulator.
  runPageSpeed: function() {
    _gaq.push(['_trackEvent', 'runPageSpeed', 'clicked']);
    // Cancel the previous run, if any.
    pagespeed.endCurrentRun();
    // Indicate in the UI that we are currently running.
    document.getElementById('run-button').disabled = true;
    document.getElementById('spinner-img').style.display = 'inline';
    // Instatiate a resource accumulator now, so that when an approveTab
    // message comes back, we know we're ready to run.
    pagespeed.resourceAccumulator = new pagespeed.ResourceAccumulator(
      pagespeed.withErrorHandler(pagespeed.onResourceAccumulatorComplete));

    // Check that the inspected window has an http[s] url.
    pagespeed.setStatusText('Checking tab...');
    chrome.devtools.inspectedWindow.eval("location.href.match(/^http/)",
      pagespeed.withErrorHandler(function(tabOk) {
        if (tabOk) {
          // Make sure the run has not been canceled.
          if (pagespeed.resourceAccumulator) {
            pagespeed.resourceAccumulator.start();
          }
        } else {
          pagespeed.endCurrentRun();
          pagespeed.showErrorMessage("url");
        }
    }));
  },

  // Invoked when the ResourceAccumulator has finished collecting data
  // from the web inspector.
  onResourceAccumulatorComplete: function(har) {
    pagespeed.resourceAccumulator = null;

    pagespeed.domCollector = new pagespeed.DomCollector(
      pagespeed.withErrorHandler(function(dom) {
        pagespeed.domCollector = null;
        var message = {
          har: har,
          dom: dom,
        };
        pagespeed.onDomComplete(message);
      })
    );
    pagespeed.setStatusText("Collecting page DOM...");
    pagespeed.domCollector.start();
  },

  onDomComplete: function(message) {
    pagespeed.setStatusText("Page DOM collected.");
    // Tell the background page to collect the missing bits of the HAR
    // and run Page Speed.  It will respond with a onRunPageSpeedComplete
    // message, which will be handled in pagespeed.messageHandler().
    //
    // TODO(bmcquade): If there is an existing in-flight call it needs
    // to be cancelled first or ignored when the result comes
    // back. This should not happen since we disable the analyze
    // button when a request is in flight. However if we find we do
    // need to track in-flight requests we should add an 'id' field to
    // the posted message and propagate it through the callbacks so we
    // can track each request (and remember the ID of the most recent
    // outstanding request).
    pagespeed.connectionPort.postMessage({
      tab_id: pagespeed.getInspectedWindowTabId(),
      kind: 'runPageSpeed',
      har: message.har,
      document: message.dom,
      timeline: pagespeed.timelineEvents,
      resource_filter: "all", // TODO(lsong): get the real filter.
      locale: chrome.i18n.getMessage('@@ui_locale'),
    });
  },

  // Handler for responses from our native module.
  onRunPageSpeedComplete: function(output) {
    pagespeed.currentResults = {
      analyze: output.resourceFilterName,
      optimizedContent: output.optimizedContent,
      results: output.results
    };
    // If we need to save optimized content, then start up a
    // ContentWriter and tell it to show results (that is, call
    // onContentWriterComplete) when it finishes.  If we're not saving
    // optimized content, skip straight to showing the results (by
    // calling onContentWriterComplete immediately). Note that we
    // could test localStorage.noOptimizedContent here however it may
    // be the case that the localStorage value changed between the
    // time the request started and now. We'd like to honor the value
    // at the time the request started, which is why we inspect the
    // optimizedContent bundle to determine if there is any optimized
    // content to save.
    var saveOptimizedContent = false;
    for(var i in output.optimizedContent) {
      if (output.optimizedContent.hasOwnProperty(i)) {
        saveOptimizedContent = true;
        break;
      }
    }
    if (saveOptimizedContent) {
      pagespeed.contentWriter = new pagespeed.ContentWriter(
        output.optimizedContent,
        pagespeed.withErrorHandler(pagespeed.onContentWriterComplete));
      pagespeed.setStatusText("Saving optimized content...");
      pagespeed.contentWriter.start();
    } else {
      pagespeed.onContentWriterComplete();
    }
  },

  // Invoked when the ContentWriter has finished serializing optimized content.
  // Displays the results and ends the run.
  onContentWriterComplete: function() {
    pagespeed.contentWriter = null;
    pagespeed.showResults();
    pagespeed.endCurrentRun();
  },

  // Cancel the current run, if any, and reset the status indicators.
  endCurrentRun: function() {
    if (pagespeed.domCollector) {
      pagespeed.domCollector.cancel();
      pagespeed.domCollector = null;
    }
    if (pagespeed.resourceAccumulator) {
      pagespeed.resourceAccumulator.cancel();
      pagespeed.resourceAccumulator = null;
    }
    if (pagespeed.contentWriter) {
      pagespeed.contentWriter.cancel();
      pagespeed.contentWriter = null;
    }
    var run_button = document.getElementById('run-button');
    run_button.disabled = false;
    // run_button.className = "kd-button kd-button-action";
    document.getElementById('spinner-img').style.display = 'none';
    pagespeed.setStatusText(null);
    pagespeed.connectionPort.postMessage({
      tab_id: pagespeed.getInspectedWindowTabId(),
      kind: 'cancelRun'
    });
  },

  // Callback for when we navigate to a new page.
  onPageNavigate: function() {
    // Clear the list of timeline events.
    pagespeed.timelineEvents.length = 0;
    pagespeed.pageHasLoaded = false;
    // If there's an active ResourceAccumulator, it must be trying to reload
    // the page, so don't do anything.  Otherwise, if there are results
    // showing, they're from another page, so clear them.
    if (!pagespeed.resourceAccumulator) {
      // TODO(mdsteele): Alternatively, we could automatically re-run the
      //   rules.  Maybe we should have a user preference to decide which?
      pagespeed.clearResults();
    }

    pagespeed.checkPageLoaded();
  },

  // Check if pageloaded every one (1) second.
  checkPageLoaded: function() {
     function expression() {
      return {
        result: document.readyState
      };
    }

    setTimeout(function() {
      chrome.devtools.inspectedWindow.eval(
        '(' + expression.toString() + ')();',
        function(state) {
          console.log(JSON.stringify(state));
          if (state && state.result && state.result === 'complete') {
            // Loaded.
            pagespeed.onPageLoaded();
          } else {
            pagespeed.checkPageLoaded();
          }
        });
      }, 1000);
  },

  // Callback for when the inspected page loads.
  onPageLoaded: function() {
    console.log('Page is loaded.');
    pagespeed.pageHasLoaded = true;
    // If there's an active ResourceAccumulator, it must be trying to reload
    // the page, so let it know that it loaded.
    if (pagespeed.resourceAccumulator) {
      pagespeed.resourceAccumulator.onPageLoaded();
    }
    // Otherwise, if we have run-at-onload enabled, we should start a run now.
    else if (pagespeed.runAtOnLoad) {
      pagespeed.runPageSpeed();
    }
  },

  // Callback for when a timeline event is recorded (via the timeline API).
  onTimelineEvent: function(event) {
    pagespeed.timelineEvents.push(event);
    if (event.type === "MarkLoad") {
      console.log('Timeline event MarkLoad.');
      pagespeed.onPageLoaded();
    }
  },

  // Called once when we first load pagespeed-panel.html, to initialize the UI,
  // with localization.
  initializeUI: function() {
    // The content_security_policy does not allow us to inline event
    // handlers or style settings... initialize these settings here.
    var logo = document.getElementById('logo-img');
    logo.style.float = "left";

    var whats_new_container = document.getElementById('whats-new-container');
    whats_new_container.style.float = "left";

    var run_button = document.getElementById('run-button');
    run_button.onclick = pagespeed.runPageSpeed;

    // Initialize the welcome pane.
    // TODO(mdsteele): Localize this stuff too, once we decide what it should
    //   look like.
    var whatsnew = document.getElementById('whats-new-container');
    whatsnew.appendChild(pagespeed.makeElement('h1', 'title',
        "Make the web faster"));
    whatsnew.appendChild(pagespeed.makeElement('h3', 'subtitle',
        "PageSpeed Insights for Chrome"));

    whatsnew.appendChild(pagespeed.makeElement(
      'h4', 'whatsnew-header', "What's new in this version?"));
    whatsnew.appendChild(pagespeed.makeElement('ul', 'whatsnew-list', [
      pagespeed.makeElement('li', 'bullet bullet-1', [
        pagespeed.makeElement('h5', 'whatsnew-item-header',
          pagespeed.makeLink(pagespeed.issues_link,
                             'Feature request at github.')),
        pagespeed.makeElement('span', 'whatsnew-item-header',
            'This is a fork of the original PageSpeed Insights for Chrome.'),
        ]),

      pagespeed.makeElement('li', 'bullet bullet-2', [
        pagespeed.makeElement('h5', 'whatsnew-item-header',
          pagespeed.makeLink(pagespeed.issues_link, 'File bug at github!')),
        pagespeed.makeElement('span', 'whatsnew-item-header',
            'We try out best to fix bugs.'),
        ]),

      pagespeed.makeElement('li', 'bullet bullet-3', [
        pagespeed.makeElement('h5', 'whatsnew-item-header',
                              'Community!'),
        pagespeed.makeElement('span', 'whatsnew-item-header',
            'We have moved to github. Help is wanted.'),
        ]),
    ]));
    var another_run_button = whatsnew.appendChild(
      pagespeed.makeElement('button',
                            'kd-button kd-button-action','Start analyzing'));
    another_run_button.onclick = pagespeed.runPageSpeed;


    var link = pagespeed.makeElement('a', null, 'PageSpeed Insights');
    link.href='https://developers.google.com/speed/pagespeed/';
    link.target="_blank";
    whatsnew.appendChild(pagespeed.makeElement(
      'h4', 'learn-more', ['Learn more about the original ',
         link, '.' 
      ]));

    link = pagespeed.makeElement('a', null, 'PageSpeed Chrome Extension');
    link.href='https://github.com/songlibo/pagespeed-chrome-extension';
    link.target="_blank";
    whatsnew.appendChild(pagespeed.makeElement(
      'h4', 'learn-more', ['Github home of ',
         link, '.' 
      ]));

    // Refresh the run button, etc.
    pagespeed.clearResults();
  },

};

// DomCollector manages the asynchronous callback from the inspected
// page which contains the DOM.
pagespeed.DomCollector = function(clientCallback) {
  this.clientCallback_ = clientCallback;
  this.cancelled_ = false;
};

pagespeed.DomCollector.prototype.start = function() {
  // The collector function will be evaluated in the inspected window.
  // It will be to stringed, so should make no reference to its
  // current definition context.
  var collector = function() {

    function collectElement(element, outList) {
      // TODO(mhillyard): this ensures we don't include our injected
      // iframe element in the elements list.
      if (element === frameElement) return;

      var obj = {tag: element.tagName};
      // If the tag has any attributes, add an attribute map to the  output
      // object.
      var attributes = element.attributes;
      if (attributes && attributes.length > 0) {
        obj.attrs = {};
        for (var i = 0, len = attributes.length; i < len; ++i) {
          var attribute = attributes[i];
          obj.attrs[attribute.name] = attribute.value;
        }
      }

      // If the tag has any children, add children list to the output object.
      var children = element.children;
      if (children && children.length > 0) {
        for (var j = 0, len = children.length; j < len; ++j) {
          collectElement(children[j], outList);
        }
      }
      // If this is an IMG tag, record the size to which the image is scaled.
      if (element.tagName === 'IMG' && element.complete) {
        obj.width = element.width;
        obj.height = element.height;
      }

      // It seems that we will have exception for IFRAME, which will cause the
      // document to be empty. See the issue:
      // https://code.google.com/p/page-speed/issues/detail?id=1535
      if (element.tagName === 'IFRAME') {
        var contendDocument = null;
        try {
          contendDocument = element.contentDocument;
          if (contentDocument) {
            // If the tag has a content document, add that to the output object.
            obj.contentDocument = collectDocument(contentDocument);
          }
        } catch (e) {
          // We cannot access the iFrame.
        }
      }

      outList.push(obj);
    }

    function collectDocument(document) {
      var elements = [];
      collectElement(document.documentElement, elements);
      return {
        documentUrl: document.URL,
        baseUrl: document.baseURI,
        elements: elements
      };
    }

    return collectDocument(document);
  };

  // Evaluate the collector function in the inspected page
  var this_ = this;
  chrome.devtools.inspectedWindow.eval(
    '(' + collector.toString() + ')();',
    pagespeed.withErrorHandler(function(dom) {
      this_.onDomCollected_(dom);
  }));
};

pagespeed.DomCollector.prototype.cancel = function() {
  this.cancelled_ = true;
};

pagespeed.DomCollector.prototype.onDomCollected_ = function(dom) {
  if (!this.cancelled_) {
    this.clientCallback_(dom);
  }
};

// ResourceAccumulator manages a flow of asynchronous callbacks from
// the web inspector, storing results along the way and finally
// invoking the client callback when all results have been
// accumulated.
pagespeed.ResourceAccumulator = function(clientCallback) {
  this.clientCallback_ = clientCallback;
  this.nextEntryIndex_ = 0;
  this.cancelled_ = false;
  this.har_ = null;
  this.doingReload_ = false;
  this.timeoutId_ = null;
};

// Start the accumulator.
pagespeed.ResourceAccumulator.prototype.start = function() {
  if (this.cancelled_) {
    return;  // We've been cancelled so ignore the callback.
  }
  pagespeed.setStatusText(chrome.i18n.getMessage('fetching_har'));
  chrome.devtools.network.getHAR(
    pagespeed.withErrorHandler(this.onHAR_.bind(this)));
};

// Cancel the accumulator.
pagespeed.ResourceAccumulator.prototype.cancel = function() {
  this.cancelled_ = true;
};

pagespeed.ResourceAccumulator.prototype.onPageLoaded = function() {
  if (this.doingReload_) {
    this.doingReload_ = false;
    if (!this.cancelled_) {
      // The page finished loading, but let's wait 100 milliseconds for
      // post-onLoad things to finish up before we start scoring.
      setTimeout(pagespeed.withErrorHandler(this.start.bind(this)), 100);
    }
  }
};

pagespeed.ResourceAccumulator.prototype.onHAR_ = function(har) {
  if (this.cancelled_) {
    return;  // We've been cancelled so ignore the callback.
  }
  pagespeed.assert(this.har_ === null);

  // The HAR will only include resources that were loaded while the DevTools
  // panel was open, but we need all the resources.  Our trick is this: if (and
  // only if) the DevTools panel was open when the page started loading, then
  // the pages field of HAR is not empty.  So, we check to see if the pages
  // exist. If so, we assume we have everything, and continue.  If not, we
  // reload the page; when the page finishes loading, our callback will call the
  // onPageLoaded() method of this ResourceAccumulator, and we can try again.

  var need_reload = false;
  if (har.entries.length === 0 || har.pages.length == 0) {
    need_reload = true;
  }

  if (need_reload) {
    pagespeed.setStatusText(chrome.i18n.getMessage('reloading_page'));
    this.doingReload_ = true;
    chrome.devtools.inspectedWindow.reload();
  } else {
    // startedDateTime field is a Date object. It will be lost when we pass the
    // HAR to the background page. Thus, convert it to string to reserve it.
    har.entries.forEach(function(entry) {
      var date = entry.startedDateTime;
      entry.startedDateTime = date.toISOString();
    });

    // Devtools apparently sets the onLoad timing to NaN if onLoad hasn't
    // fired yet.  Page Speed will interpret that to mean that the onLoad
    // timing is unknown, but setting it to -1 will tell Page Speed that it
    // is known not to have happened yet.
    har.pages.forEach(function(page) {
      if (isNaN(page.pageTimings.onLoad)) {
        page.pageTimings.onLoad = -1;
      }
      var date = page.startedDateTime;
      page.startedDateTime = date.toISOString();
    });
    this.har_ = har;
    this.getNextEntryBody_();
  }
};

pagespeed.ResourceAccumulator.prototype.getNextEntryBody_ = function() {
  if (this.nextEntryIndex_ >= this.har_.entries.length) {
    this.clientCallback_({log: this.har_});  // We're finished.
  } else {
    var entry = this.har_.entries[this.nextEntryIndex_];
    pagespeed.setStatusText(chrome.i18n.getMessage(
      'fetching_content', [this.nextEntryIndex_ + 1, this.har_.entries.length,
                           entry.request.url]));
    // Ask the DevTools panel to give us the content of this resource.
    entry.getContent(pagespeed.withErrorHandler(
      this.onBody_.bind(this, this.nextEntryIndex_)));
    // Sometimes the above call never calls us back.  This is a bug.  In the
    // meantime, give it at most 2 seconds before we time out and move on.
    pagespeed.assert(this.timeoutId_ === null);
    this.timeoutId_ = setTimeout(pagespeed.withErrorHandler(
      this.timeOut_.bind(this, this.nextEntryIndex_)), 2000);
  }
};

pagespeed.ResourceAccumulator.prototype.timeOut_ = function(index) {
  if (this.cancelled_ || index !== this.nextEntryIndex_) {
    return;  // We've been cancelled so ignore the callback.
  }
  this.timeoutId_ = null;
  ++this.nextEntryIndex_;
  this.getNextEntryBody_();
};

pagespeed.ResourceAccumulator.prototype.onBody_ = function(index, text,
                                                            encoding) {
  if (this.cancelled_ || index !== this.nextEntryIndex_) {
    return;  // We've been cancelled so ignore the callback.
  }
  pagespeed.assert(this.timeoutId_ !== null);
  clearTimeout(this.timeoutId_);
  this.timeoutId_ = null;
  var content = this.har_.entries[this.nextEntryIndex_].response.content;
  // We need the || here because sometimes we get back null for `text'.
  // TODO(mdsteele): That's a bad thing.  Is it fixable?
  content.text = text || '';
  content.encoding = encoding;
  ++this.nextEntryIndex_;
  this.getNextEntryBody_();
};

// ContentWriter manages the serialization of optimized content to a local
// filesystem, using the asynchronous filesystem API.  It will call the
// clientCallback when it finishes.
pagespeed.ContentWriter = function(optimizedContent, clientCallback) {
  this.cancelled_ = false;
  this.clientCallback_ = clientCallback;
  this.fileSystem_ = null;
  this.optimizedContent_ = optimizedContent;
  this.keyQueue_ = [];
  for (var key in optimizedContent) {
    if (optimizedContent.hasOwnProperty(key)) {
      this.keyQueue_.push(key);
    }
  }
};

// Start the content writer.
pagespeed.ContentWriter.prototype.start = function() {
  // Create a new temporary filesystem.  On some (but not all) Chrome versions,
  // this has a "webkit" prefix.
  var requestFS = (window.requestFileSystem ||
                   window.webkitRequestFileSystem);
  // Request 10MB for starters, but we can always exceed this later because we
  // use the "unlimitedStorage" permission in our manifest.json file.
  requestFS(window.TEMPORARY, 10 * 1024 * 1024 /*10MB*/,
            // On success:
            pagespeed.withErrorHandler(this.onFileSystem_.bind(this)),
            // On failure:
            this.makeErrorHandler_("requestFileSystem", this.clientCallback_));
};

// Cancel the content writer.
pagespeed.ContentWriter.prototype.cancel = function() {
  this.cancelled_ = true;
};

// Callback for when the filesystem is successfully created.
pagespeed.ContentWriter.prototype.onFileSystem_ = function(fs) {
  if (this.cancelled_) {
    return;  // We've been cancelled so ignore the callback.
  }
  this.fileSystem_ = fs;
  this.writeNextFile_();
};

// Start writing the next file in the queue.
pagespeed.ContentWriter.prototype.writeNextFile_ = function() {
  if (this.cancelled_) {
    return;
  }
  // If there are no more keys in the queue, we're done.
  if (this.keyQueue_.length <= 0) {
    this.clientCallback_();
    return;
  }
  // Otherwise, create a file for the next key in the queue.  If the file
  // already exists, we'll overwrite it, which is okay because the filenames we
  // choose include content hashes.
  var key = this.keyQueue_.pop();
  var entry = this.optimizedContent_[key];
  this.fileSystem_.root.getFile(
    entry.filename, {create: true},
    // On success:
    pagespeed.withErrorHandler(this.onGotFile_.bind(this, entry)),
    // On failure:
    this.makeErrorHandler_("getFile", this.writeNextFile_.bind(this)));
};

// Callback for when a file is successfully created.
pagespeed.ContentWriter.prototype.onGotFile_ = function(entry, file) {
  if (this.cancelled_) {
    return;  // We've been cancelled so ignore the callback.
  }
  // Decode the base64 data into a byte array, which we can then append to a
  // BlobBuilder.  I don't know of any quicker way to just write base64 data
  // straight into a Blob, but thanks to V8, the below is still very fast.
  var decoded = atob(entry.content);
  delete entry.content;  // free up memory
  var size = decoded.length;
  var array = new Uint8Array(size);
  for (var index = 0; index < size; ++index) {
    array[index] = decoded.charCodeAt(index);
  }

  if (array.buffer.byteLength <= 0) {
    // Do not write this file, because it may crash WebKit's FileWriter on
    // 0-sized write. Keep the url and move to the next one.
    entry.url = file.toURL(entry.mimetype);
    this.writeNextFile_();
    return;
  }

  var writeNext = this.writeNextFile_.bind(this);
  var onWriterError = this.makeErrorHandler_("write", writeNext);
  file.createWriter(pagespeed.withErrorHandler(function(writer) {
    // Provide callbacks for when the writer finishes or errors.
    writer.onwriteend = pagespeed.withErrorHandler(function() {
      entry.url = file.toURL(entry.mimetype);
      writeNext();
    });
    writer.onerror = onWriterError;

    // // Use a BlobBuilder to write the file.  In some (but not all) Chrome
    // // versions, this has a "WebKit" prefix.
    // var bb = new (window.BlobBuilder || window.WebKitBlobBuilder)();
    // bb.append(array.buffer);
    // writer.write(bb.getBlob(entry.mimetype));

    var blob = new Blob([array], {"type": entry.mimetype});
    writer.write(blob);
  }), this.makeErrorHandler_("createWriter", writeNext));
};

// Given a string representing where the error happened, and a callback to call
// after handling the error, return an error handling function suitable to be
// passed to one of the filesystem API calls.
pagespeed.ContentWriter.prototype.makeErrorHandler_ = function(where, next) {
  return pagespeed.withErrorHandler((function(error) {
    var msg;
    switch (error.code) {
    case FileError.QUOTA_EXCEEDED_ERR:
      msg = 'QUOTA_EXCEEDED_ERR';
      break;
    case FileError.NOT_FOUND_ERR:
      msg = 'NOT_FOUND_ERR';
      break;
    case FileError.SECURITY_ERR:
      msg = 'SECURITY_ERR';
      break;
    case FileError.INVALID_MODIFICATION_ERR:
      msg = 'INVALID_MODIFICATION_ERR';
      break;
    case FileError.INVALID_STATE_ERR:
      msg = 'INVALID_STATE_ERR';
      break;
    default:
      msg = 'Unknown Error';
      break;
    }
    if (!this.cancelled_) {
      next();
    }
  }).bind(this));
};

pagespeed.withErrorHandler(function() {
  // Connect to the extension background page.
  var tabId = String(pagespeed.getInspectedWindowTabId());

  if (chrome.runtime.connect) {
    pagespeed.connectionPort = chrome.runtime.connect({name: tabId});
  } else {
  pagespeed.connectionPort = chrome.extension.connect({name: tabId});
  }
  pagespeed.connectionPort.onMessage.addListener(
    pagespeed.withErrorHandler(pagespeed.messageHandler));

  // Register for navigation events from the inspected window.
  chrome.devtools.network.onNavigated.addListener(
    pagespeed.withErrorHandler(pagespeed.onPageNavigate));

  // The listener will disconnect when we close the devtools panel.
  // The timeline api is still experimental.
  var timeline = chrome.devtools.timeline;
  if (!timeline && chrome.experimental && chrome.experimental.devtools) {
    timeline = chrome.experimental.devtools.timeline;
  }
  if (timeline) {
    timeline.onEventRecorded.addListener(
      pagespeed.withErrorHandler(pagespeed.onTimelineEvent));
  }

  pagespeed.initializeUI();
})();
