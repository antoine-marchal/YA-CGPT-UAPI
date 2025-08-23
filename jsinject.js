// Monkey-patch fetch to intercept requests to conversation endpoint
(function () {
    const origFetch = window.fetch;
  
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
                      console.log("%c[DELTA]", "color: purple;", { conversation_id: convo, v });
                    }
                  } catch {
                    // ignore non-JSON
                  }
                }
              }
  
              // flush any trailing partial data
              const tail = buffer.trim();
              if (tail) {
                try {
                  const parsed = JSON.parse(tail);
                  const convo = parsed.conversation_id ?? parsed.conversationId ?? null;
                  const v = (parsed && parsed.payload && parsed.payload.v) ?? parsed.v;
  
                  if ((parsed.event === "delta" || parsed.eventType === "delta") && v) {
                    console.log("%c[DELTA]", "color: purple;", { conversation_id: convo, v });
                  }
                } catch {
                  // ignore trailing non-JSON
                }
              }
            } catch (err) {
              console.warn("[INTERCEPT] Stream reader error:", err);
            }
          })();
        }
  
        return response;
      }
  
      return origFetch(...args);
    };
  
    // Helper to restore the original fetch if needed
    window.__unpatchChatGPTFetch = function () {
      window.fetch = origFetch;
      console.log("[INTERCEPT] fetch restored");
    };
  })();
  