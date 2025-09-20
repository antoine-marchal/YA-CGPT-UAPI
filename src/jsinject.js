// Paste this whole block into the browser console.
// Robust intercept for "/backend-api/f/conversation" SSE/delta stream.
// Fix: handle p:'/message/content/thoughts' with o:'append' (array of thought objects).

(function() {
  // restore previous hook if present
  if (window.__jsinject_orig_fetch) {
    try { window.fetch = window.__jsinject_orig_fetch; } catch (e) {}
    try { delete window.__jsinject_orig_fetch; } catch (e) {}
    try { delete window.__jsinject_unhook; } catch (e) {}
  }

  var ST = {
    systemTag: 'color:rgb(85,85,85); font-weight:700',
    thinkingTag: 'color:orange; font-weight:700',
    thinkingContent: 'color:orange',
    greenTag: 'color:#097969; font-weight:700',
    greenContent: 'color:inherit',
    functionTag: 'color:rgb(166,255,131); font-weight:700',
    functionContent: 'font-family:monospace; white-space:pre;',
    codeTag: 'color:rgb(121,9,116); font-weight:700',
    codeContent: 'font-family:monospace; white-space:pre;'
  };

  // state
  var thinkingActive = false;
  var userVisibleActive = false;
  var currentCotMessageId = null;
  var currentUserMessageId = null;
  var currentFunction = null;       // { id, name }
  var lastAddedMessageId = null;    // last message id observed (from add or v.message)
  var lastUserPartKey = null;       // "msgId::partIdx"
  var messageAppendCounter = {};
  var messageThoughtCount = {};
  var thoughtMap = {};
  var lastThoughtKey = null;

  function styledLog(tagStyle, tagText, contentStyle, contentObj, metaStyle, metaText) {
    var contentString = (typeof contentObj === 'string') ? contentObj : JSON.stringify(contentObj, null, 2);
    if (typeof metaText !== 'undefined') {
      console.log('%c' + tagText + ' %c' + contentString + ' %c' + (metaText || ''), tagStyle, contentStyle, metaStyle);
    } else {
      console.log('%c' + tagText + ' %c' + contentString, tagStyle, contentStyle);
    }
  }

  function nextGroupForMessage(msgId) {
    var id = msgId || '__unknown__';
    if (!messageAppendCounter[id]) messageAppendCounter[id] = 0;
    messageAppendCounter[id] += 1;
    return messageAppendCounter[id];
  }

  function ensureMessageThoughtCount(msgId, initial) {
    var id = msgId || '__unknown__';
    if (initial === undefined) initial = 0;
    if (messageThoughtCount[id] === undefined || messageThoughtCount[id] === null) {
      messageThoughtCount[id] = initial;
    }
    return messageThoughtCount[id];
  }

  function setThoughtMapping(msgId, globalIdx, groupNum) {
    var key = String(msgId) + '::' + String(globalIdx);
    thoughtMap[key] = groupNum;
    lastThoughtKey = key;
    return key;
  }

  function getOrCreateThoughtGroup(msgId, globalIdx) {
    var key = String(msgId) + '::' + String(globalIdx);
    if (thoughtMap[key]) return { key: key, group: thoughtMap[key] };
    var g = nextGroupForMessage(msgId);
    thoughtMap[key] = g;
    lastThoughtKey = key;
    ensureMessageThoughtCount(msgId, 0);
    if (messageThoughtCount[msgId] <= globalIdx) messageThoughtCount[msgId] = globalIdx + 1;
    return { key: key, group: g };
  }

  function endCurrentFunctionIfMatches(msgId) {
    if (currentFunction && currentFunction.id === msgId) {
      styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, {
        type: 'function_end', name: currentFunction.name, message_id: currentFunction.id
      });
      currentFunction = null;
    }
  }

  // main handler
  function handleDelta(obj) {
    if (!obj) return;
    if(obj === '[DONE]'){
      styledLog(ST.thinkingTag, '[DONE]', ST.thinkingContent, { type: 'message',  content: '[DONE]' });
      return;
    }
    // message_marker handling
    if (obj.type === 'message_marker' && obj.marker) {
      if (obj.marker === 'cot_token') {
        thinkingActive = true; userVisibleActive = false;
        currentCotMessageId = obj.message_id || null;
        ensureMessageThoughtCount(currentCotMessageId, 0);
        if (!messageAppendCounter[currentCotMessageId]) messageAppendCounter[currentCotMessageId] = 0;
        return;
      }
      if (obj.marker === 'user_visible_token') {
        userVisibleActive = true; thinkingActive = false;
        currentUserMessageId = obj.message_id || null;
        return;
      }
    }

    var p = obj.p, o = obj.o, v = obj.v;
    // --- QUICK FIX: log thought-content path immediately if present ---
      var mThoughtPath = (typeof p === 'string') && p.match(/^\/message\/content\/thoughts\/(\d+)\/content$/);
      if (mThoughtPath && typeof v !== 'undefined') {
      try {
          var globalIdx = Number(mThoughtPath[1]);
          // pick the best message id known for thoughts
          var midForThought = currentCotMessageId || lastAddedMessageId || '__unknown__';
          var mapping = getOrCreateThoughtGroup(midForThought, globalIdx);
          var txt = (typeof v === 'string') ? v : JSON.stringify(v);
          styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: mapping.group, content: txt });
      } catch (err) { /* ignore malformed */ }
      return;
      }

    // --- NEW: handle thoughts append arrays at top-level (p === '/message/content/thoughts' && o === 'append') ---
    if (p === '/message/content/thoughts' && (o === 'append' || o === 'set') && Array.isArray(v)) {
      var midThoughtAppend = currentCotMessageId || lastAddedMessageId || '__unknown__';
      var existingCount = ensureMessageThoughtCount(midThoughtAppend, 0);
      for (var i = 0; i < v.length; i++) {
        try {
          var th = v[i];
          var globalIdx = existingCount + i;
          var group = nextGroupForMessage(midThoughtAppend);
          setThoughtMapping(midThoughtAppend, globalIdx, group);
          var content = (th && (th.content || th.summary)) ? (th.content || th.summary) : JSON.stringify(th);
          styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: group, content: String(content) });
        } catch (e) { /* ignore malformed thought */ }
      }
      messageThoughtCount[midThoughtAppend] = existingCount + v.length;
      return;
    }
    // --- end new block ---

    // Normalise case: some events put full message in v.message (no o:'add')
    if (v && typeof v === 'object' && v.message && typeof v.message === 'object') {
      try {
        var msg = v.message;
        var mid = msg.id || null;
        if (mid) lastAddedMessageId = mid;
        if (msg.content && msg.content.content_type === 'thoughts') {
          var existing = Array.isArray(msg.content.thoughts) ? msg.content.thoughts.length : 0;
          ensureMessageThoughtCount(mid, existing);
        }
        if (msg.recipient && String(msg.recipient).toLowerCase() !== 'all') {
          if (!currentFunction || currentFunction.id !== mid) {
            currentFunction = { id: mid, name: String(msg.recipient) };
            styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, {
              type: 'function_start', name: currentFunction.name, message_id: currentFunction.id
            });
          }
        }
      } catch (e) { /* ignore malformed */ }
    }

    // explicit add op: track id & potential function recipient
    if (o === 'add' && v && v.message) {
      var msgAdd = v.message;
      var midAdd = msgAdd.id || null;
      if (midAdd) lastAddedMessageId = midAdd;
      if (msgAdd.content && msgAdd.content.content_type === 'thoughts') {
        var ex = Array.isArray(msgAdd.content.thoughts) ? msgAdd.content.thoughts.length : 0;
        ensureMessageThoughtCount(midAdd, ex);
      }
      if (msgAdd.recipient && String(msgAdd.recipient).toLowerCase() !== 'all') {
        if (!currentFunction || currentFunction.id !== midAdd) {
          currentFunction = { id: midAdd, name: String(msgAdd.recipient) };
          styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, {
            type: 'function_start', name: currentFunction.name, message_id: currentFunction.id
          });
        }
      }
    }

    // tool messages (add)
    if (o === 'add' && v && v.message) {
      var mmsg = v.message;
      var author = mmsg.author || {};
      var role = (author.role || 'unknown').toLowerCase();
      var aname = author.name || '';
      if (role === 'tool') {
        var codeText = '';
        if (mmsg.metadata && mmsg.metadata.aggregate_result && mmsg.metadata.aggregate_result.code) codeText = mmsg.metadata.aggregate_result.code;
        else if (mmsg.content && (mmsg.content.text || mmsg.content.code)) codeText = mmsg.content.text || mmsg.content.code;
        else codeText = JSON.stringify(mmsg.content || mmsg.metadata || mmsg, null, 2);
        styledLog(ST.codeTag, '[TOOL]', ST.codeContent, { type: 'tool', name: aname || 'tool', content: String(codeText) });
        return;
      }
    }

    // patches/append/replace: note p may be undefined for top-level patch with v as array
    if ((o === 'append' || o === 'replace' || o === 'patch') && typeof v !== 'undefined') {

      // if v is an array: treat as patch array of operations
      if (Array.isArray(v)) {
        v.forEach(function(op) {
          if (!op || !op.p) {
            // if op has no p and has v as string, try to log it as continuation for lastAddedMessageId
            if (op && typeof op.v === 'string') {
              var midFallback = lastAddedMessageId || '__unknown__';
              if (currentFunction && midFallback === currentFunction.id) {
                styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, { type: 'function', name: currentFunction.name, content: op.v });
              } else if (userVisibleActive) {
                if (lastUserPartKey) {
                  var parts = String(lastUserPartKey).split('::'), pidx = parts[1];
                  styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', part: Number(pidx), content: op.v });
                } else {
                  styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', content: op.v });
                }
              } else if (thinkingActive) {
                if (lastThoughtKey && thoughtMap[lastThoughtKey]) {
                  var g = thoughtMap[lastThoughtKey];
                  styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: g, content: op.v });
                }
              }
            }
            return;
          }

          var opP = String(op.p);

          // thoughts patch
          var mt = opP.match(/^\/message\/content\/thoughts\/(\d+)\/content$/);
          if (mt && (op.o === 'append' || op.o === 'replace' || op.o === 'set')) {
            var globalIdx = Number(mt[1]);
            var midT = currentCotMessageId || lastAddedMessageId || '__unknown__';
            var rr = getOrCreateThoughtGroup(midT, globalIdx);
            var txt = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
            styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: rr.group, content: txt });
            return;
          }

          // parts patch
          var mparts = opP.match(/^\/message\/content\/parts\/(\d+)$/);
          if (mparts && (op.o === 'append' || op.o === 'replace' || op.o === 'set')) {
            var partIdx = Number(mparts[1]);
            var midp = lastAddedMessageId || '__unknown__';
            lastUserPartKey = midp + '::' + String(partIdx);
            var txt2 = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
            if (currentFunction && midp === currentFunction.id) {
              styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, { type: 'function', name: currentFunction.name, part: partIdx, content: txt2 });
            } else {
              styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', part: partIdx, content: txt2 });
            }
            return;
          }

          // handle operations appending to /message/content/text (we used to skip these)
          var otm = opP.match(/^\/message\/content\/text$/);
          if (otm && (op.o === 'append' || op.o === 'replace' || op.o === 'set')) {
            var text = typeof op.v === 'string' ? op.v : JSON.stringify(op.v);
            var midt = lastAddedMessageId || '__unknown__';
            if (currentFunction && midt === currentFunction.id) {
              styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, { type: 'function', name: currentFunction.name, content: text });
            } else if (userVisibleActive) {
              if (lastUserPartKey) {
                var parts2 = String(lastUserPartKey).split('::'), pIdx = parts2[1];
                styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', part: Number(pIdx), content: text });
              } else {
                styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', content: text });
              }
            } else if (thinkingActive) {
              if (lastThoughtKey && thoughtMap[lastThoughtKey]) {
                var g = thoughtMap[lastThoughtKey];
                styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: g, content: text });
              }
            }
            return;
          }

          // status patch which may end a function
          if (op.p === '/message/status' && op.o === 'replace') {
            var midStatus = lastAddedMessageId;
            if (midStatus && (op.v === 'finished_successfully' || op.v === 'finished_with_error' || op.v === 'cancelled')) endCurrentFunctionIfMatches(midStatus);
            return;
          }

          // metadata append that may indicate completion
          if (op.p === '/message/metadata' && op.o === 'append') {
            var midm = lastAddedMessageId;
            var appended = op.v;
            if (appended && (appended.is_complete === true || appended.finish_details)) endCurrentFunctionIfMatches(midm);
            return;
          }

          // fallback: if op.v exists and op.p not matched above, try to show it
          if (typeof op.v === 'string' && op.v.trim()) {
            var midF = lastAddedMessageId || '__unknown__';
            if (currentFunction && midF === currentFunction.id) {
              styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, { type: 'function', name: currentFunction.name, content: op.v });
            } else {
              styledLog(ST.systemTag, '[PATCH]', ST.systemContent, { p: op.p, o: op.o, v: op.v });
            }
          }

        }); // end v.forEach
        return;
      } // end Array.isArray(v)

      // single path cases when p is present on the top-level delta
      if (typeof p === 'string') {
        var mPart = p.match(/^\/message\/content\/parts\/(\d+)$/);
        if (mPart) {
          var partIdx = Number(mPart[1]);
          var mid = lastAddedMessageId || '__unknown__';
          lastUserPartKey = mid + '::' + String(partIdx);
          var txt = (typeof v === 'string') ? v : JSON.stringify(v);
          if (currentFunction && mid === currentFunction.id) {
            styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, { type: 'function', name: currentFunction.name, part: partIdx, content: txt });
          } else {
            styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', part: partIdx, content: txt });
          }
          return;
        }

        var mThought = p.match(/^\/message\/content\/thoughts\/(\d+)\/content$/);
        if (mThought) {
          var gi = Number(mThought[1]);
          var midt = currentCotMessageId || lastAddedMessageId || '__unknown__';
          var rr = getOrCreateThoughtGroup(midt, gi);
          var txt3 = (typeof v === 'string') ? v : JSON.stringify(v);
          styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: rr.group, content: txt3 });
          return;
        }

        // general streaming text path
        if (p.indexOf('/message/content/text') === 0 || p.indexOf('/message/content') === 0) {
          var text = (typeof v === 'string') ? v : JSON.stringify(v);
          var midg = lastAddedMessageId || '__unknown__';
          if (currentFunction && midg === currentFunction.id) {
            styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, { type: 'function', name: currentFunction.name, content: text });
          } else if (userVisibleActive) {
            if (lastUserPartKey) {
              var partsc = String(lastUserPartKey).split('::'), pi = partsc[1];
              styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', part: Number(pi), content: text });
            } else {
              styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', content: text });
            }
          } else if (thinkingActive) {
            if (lastThoughtKey && thoughtMap[lastThoughtKey]) {
              var g = thoughtMap[lastThoughtKey];
              styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: g, content: text });
            }
          }
          return;
        }
      }

      return; // end top-level patch/append/replace handling
    } // end if (append/replace/patch)

    // bare string continuation: obj.v string and no p/o
    if (typeof obj.v === 'string' && !obj.p && !obj.o) {
      var midc = lastAddedMessageId || '__unknown__';
      if (currentFunction && midc === currentFunction.id) {
        styledLog(ST.functionTag, '[FUNCTION ' + String(currentFunction.name).toUpperCase() + ']', ST.functionContent, { type: 'function', name: currentFunction.name, content: obj.v });
      } else if (userVisibleActive) {
        if (lastUserPartKey) {
          var partsb = String(lastUserPartKey).split('::'), pidx = partsb[1];
          styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', part: Number(pidx), content: obj.v });
        } else {
          styledLog(ST.greenTag, '[MESSAGE]', ST.greenContent, { type: 'message', content: obj.v });
        }
      } else if (thinkingActive) {
        if (lastThoughtKey && thoughtMap[lastThoughtKey]) {
          var gg = thoughtMap[lastThoughtKey];
          styledLog(ST.thinkingTag, '[THINKING]', ST.thinkingContent, { type: 'thinking', part: gg, content: obj.v });
        }
      }
      return;
    }

  } // end handleDelta

  function processChunkAndHandle(rawChunk, leftoverHolder) {
    var data = (leftoverHolder.leftover || '') + rawChunk;
    var parts = data.split(/\n\n/);
    leftoverHolder.leftover = parts.pop() || '';
    for (var i = 0; i < parts.length; i++) {
      var evt = parts[i];
      var lines = evt.split(/\r?\n/);
      for (var j = 0; j < lines.length; j++) {
        var ln = lines[j];
        var m = ln.match(/^\s*data:\s*(.*)$/);
        if (!m) continue;
        var payload = m[1];
        try {
          var parsed = JSON.parse(payload);
          handleDelta(parsed);
        } catch (e) {
          var trimmed = payload.trim();
          if ((trimmed.indexOf('{') === 0 && trimmed.lastIndexOf('}') === trimmed.length - 1) ||
              (trimmed.indexOf('[') === 0 && trimmed.lastIndexOf(']') === trimmed.length - 1)) {
            try { handleDelta(JSON.parse(trimmed)); } catch (er) { handleDelta(payload); }
          } else if ((payload.indexOf('"') === 0 && payload.lastIndexOf('"') === payload.length - 1) ||
                     (payload.indexOf("'") === 0 && payload.lastIndexOf("'") === payload.length - 1)) {
            try { handleDelta(JSON.parse(payload)); } catch (er2) { handleDelta(payload.slice(1, -1)); }
          } else {
            try { handleDelta(payload); } catch (_) { /* ignore */ }
          }
        }
      }
    }
  }

  // hook fetch
  var origFetch = window.fetch.bind(window);
  window.__jsinject_orig_fetch = origFetch;

  window.fetch = async function() {
    var input = arguments[0], init = arguments[1];
    var url;
    try { url = (typeof input === 'string') ? input : (input && input.url) || ''; } catch (e) { url = ''; }
    if (!url || url.indexOf('/backend-api/f/conversation') === -1) return origFetch.apply(window, arguments);

    console.log('%c[INTERCEPT] Conversation fetch:', 'color: green; font-weight:700', url, init);

    var response = await origFetch.apply(window, arguments);
    try {
      var cloned = response.clone();
      if (!cloned.body || !cloned.body.getReader) {
        console.log('%c[jsinject] no body.getReader on cloned response — skipping stream handling', 'color:#666');
        return response;
      }
      var reader = cloned.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var leftoverHolder = { leftover: '' };
      (async function readLoop(){
        try {
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            var chunk = decoder.decode(r.value, { stream: true });
            processChunkAndHandle(chunk, leftoverHolder);
          }
          if (leftoverHolder.leftover) {
            processChunkAndHandle(leftoverHolder.leftover + '\n\n', leftoverHolder);
            leftoverHolder.leftover = '';
          }
          console.log('%c[jsinject] stream read finished', 'color:#666');
        } catch (e) {
          console.error('[jsinject] stream read error:', e);
        }
      })();
    } catch (e) {
      console.warn('[jsinject] clone/read error:', e);
    }
    return response;
  };

  window.__jsinject_unhook = function() {
    if (window.__jsinject_orig_fetch) {
      try {
        window.fetch = window.__jsinject_orig_fetch;
        delete window.__jsinject_orig_fetch;
        delete window.__jsinject_unhook;
        console.log('%c[jsinject] fetch restored', 'color:#666');
      } catch (e) {
        console.error('[jsinject] cannot restore fetch', e);
      }
    } else {
      console.warn('%c[jsinject] no hook to remove', 'color:#666');
    }
  };

  console.log('%c[jsinject] hook installed — intercepting requests containing "/backend-api/f/conversation".', 'color:#666; font-weight:700');

})(); 