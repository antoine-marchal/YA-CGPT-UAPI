/**
 * jsinject.js
 * ------------
 * This script is injected into the ChatGPT web client.
 * It monkey-patches `fetch` to intercept responses from the conversation endpoint,
 * and logs tokens as they stream ([START], [MESSAGE], [DONE]).
 *
 * It is used internally by `chatgptlistener.js` to capture assistant messages.
 */
(function () {
    const origFetch = window.fetch;
    let visibleForUser = false;
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === "string" ? input : (input && input.url) || "";
  
      if (url.includes("/backend-api/f/conversation")) {
        console.log("%c[INTERCEPT] Conversation request:", "color: green;", url, init);
  
        const response = await origFetch(...args);
        const cloned = response.clone();
  
        if (cloned.body && cloned.body.getReader) {
          const reader = cloned.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";
  
          (async function readStream() {
            try {
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
  
                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
  
                let sep;
                while ((sep = buffer.indexOf("\n\n")) !== -1) {
                  const rawEvent = buffer.slice(0, sep);
                  buffer = buffer.slice(sep + 2);
  
                  const lines = rawEvent.split("\n").filter(Boolean);
                  let eventType = "message";
                  const dataLines = [];
  
                  for (const line of lines) {
                    if (line.startsWith("event:")) eventType = line.slice(6).trim();
                    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
                  }
  
                  const dataPayload = dataLines.join("\n");
                  if (!dataPayload || dataPayload === "[DONE]") continue;
  
                  try {
                    const parsed = JSON.parse(dataPayload);
                    const convo = parsed.conversation_id ?? parsed.conversationId ?? null;
                    const v = (parsed && parsed.payload && parsed.payload.v) ?? parsed.v;
  
                    if (eventType === "delta" && v) {
                        let color = visibleForUser?'green':'red';
                        if (!Array.isArray(v)) console.log("%c[MESSAGE]", "color: "+color+";", v);
                        else{
                            let result = v
                            .filter(item => item.p.startsWith("/message/content/parts"))
                            .map(item => item.v)
                            .join("");
                            console.log("%c[MESSAGE]", "color: "+color+";", result);
                        }
                      
                    }
                    else{
                        if(parsed.type === 'message_stream_complete'){
                            console.log("%c[DONE]", "color: green;", parsed);
                            visibleForUser=false;
                        }
                        else if(parsed.type === 'message_marker' && parsed.marker === 'user_visible_token'){
                            console.log("%c[START]", "color: green;", parsed);
                            visibleForUser=true;
                        }
                       else console.log("%c["+eventType+"]", "color: grey;", parsed);
                    }
                  } catch {
                    // ignore non-JSON
                  }
                }
              }
  
              // flush any trailing partial data
              
            } catch (err) {
              console.warn("[INTERCEPT] Stream reader error:", err);
            }
          })();
        }
  
        return response;
      }
  
      return origFetch(...args);
    };
  


window.__unpatchChatGPTFetch = function () {
    window.fetch = origFetch;
    console.log("[INTERCEPT] fetch restored");
  };
// mark as loaded
  window.__chatgptInterceptorLoaded = true;
  console.log("[INJECTED] ChatGPT interceptor ready");
})();

  