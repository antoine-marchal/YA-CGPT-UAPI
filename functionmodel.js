          // 1) announce the tool call with the function name
          sseWrite(res, {
            id, object: "chat.completion.chunk", created, model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: callId,
                  type: "function",
                  function: { name }
                }]
              },
              finish_reason: null
            }]
          });
          if (typeof res.flush === "function") try { res.flush(); } catch {}
      
          // 2) stream (or dump) the arguments as a string (OpenAI requires STRING)
          if (argsStr && argsStr.length) {
            sseWrite(res, {
              id, object: "chat.completion.chunk", created, model,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: { arguments: argsStr }
                  }]
                },
                finish_reason: null
              }]
            });
            if (typeof res.flush === "function") try { res.flush(); } catch {}
          }
      
          // 3) finish with finish_reason "tool_calls"
          sseWrite(res, {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
          });