// index.js
// OpenAI-compatible SSE proxy (Playwright-backed).
// - Streams only when explicitly requested (body.stream === true OR Accept: text/event-stream).
// - Detects hidden functions embedded in regular "message" chunks using [FUNCTION_START] ... [FUNCTION_END],
//   even when markers are split across tokens (e.g. "[FUNCTION", "_START]").
// - Buffers function JSON between markers and emits a real function call (OpenAI spec).
// - Non-stream returns modern tool_calls shape (arguments as STRING).
// - Fallback to fullText return when no per-chunk messages arrived (CSP/no-inject scenarios).

import express from "express";
import cors from "cors";
import readline from "readline";
import { playwrightService } from "./services/chatgptService.js";

const app = express();
const port = process.env.PORT || 3000;

// Instruct the upstream model to surface tool calls with explicit markers.
const prefixPrompt =
  "do not forget to add in the json response in case of a function the name of the function\n" +
  "Return tool calls wrapped with [FUNCTION_START] and [FUNCTION_END] (no code fences).\n";

// ---- Config ----
const MODEL_FALLBACK = process.env.OPENAI_MODEL || "gpt-5";
const STREAM_TIMEOUT_MS = parseInt(process.env.STREAM_TIMEOUT_MS || "1800000", 10); // 30 min
const MAX_BODY = process.env.MAX_BODY || "100mb";
const MAX_FUNC_ARGS_BYTES = parseInt(process.env.MAX_FUNC_ARGS_BYTES || `${1024 * 1024}`, 10); // 1MB

// ---- Middleware ----
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || origin === "null" || origin.startsWith("http://localhost")) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.json({ limit: MAX_BODY, type: ["application/json", "application/*+json"] }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY }));

// ---- Start Playwright early ----
(async () => {
  try {
    console.log("Initializing Playwright browser for ChatGPT interaction...");
    await playwrightService.initializeBrowser();
    console.log("Playwright browser initialized. Server ready.");
  } catch (err) {
    console.error("CRITICAL: Failed to initialize Playwright:", err);
    process.exit(1);
  }
})();

// ---- Console shortcuts ----
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Press 'r' + Enter to refresh context; 's' + Enter to save session.");
rl.on("line", async (input) => {
  const cmd = input.trim().toLowerCase();
  if (cmd === "r") {
    console.log("Refreshing browser context...");
    try {
      await playwrightService.saveSession();
      await playwrightService.closeBrowser();
      await playwrightService.initializeBrowser();
      console.log("Browser context refreshed.");
    } catch (e) {
      console.error("Refresh failed:", e);
    }
  } else if (cmd === "s") {
    console.log("Saving browser session...");
    try {
      await playwrightService.saveSession();
      console.log("Saved.");
    } catch (e) {
      console.error("Save failed:", e);
    }
  }
});

// ---- Helpers ----
function extractLastUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Invalid request: 'messages' must be a non-empty array.");
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") throw new Error(`Invalid message at index ${i}.`);
    if (typeof m.role !== "string" || !m.role.trim()) throw new Error(`Invalid role at index ${i}.`);
    if (typeof m.content !== "string" || !m.content.trim()) throw new Error(`Invalid content at index ${i}.`);
    if (m.role === "user") return m.content;
  }
  throw new Error("No user message with content found in 'messages'.");
}

function sseWrite(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch (e) {
    console.error("sseWrite error:", e?.message || e);
  }
}

// Robust parser for hidden [FUNCTION_*] markers inside streamed message deltas.
function createHiddenFnParser({ onText, onFunction }) {
  const START = "[FUNCTION_START]";
  const END = "[FUNCTION_END]";

  let buffer = "";              // rolling buffer of normal text (for scanning markers)
  let capturing = false;        // true when we're inside a function payload
  let funcBuf = "";             // captured JSON between START and END
  let bytesCount = 0;           // guard against huge payloads

  const flushText = () => {
    if (!capturing && buffer) {
      onText(buffer);
      buffer = "";
    }
  };

  const tryDrain = () => {
    // Look for function markers possibly spanning across writes.
    // We loop because a single incoming chunk can contain multiple markers and/or multiple functions.
    while (true) {
      if (!capturing) {
        const iStart = buffer.indexOf(START);
        if (iStart === -1) {
          // No start marker yet; nothing to do now.
          return;
        }
        // Emit any plain text before the marker.
        const before = buffer.slice(0, iStart);
        if (before) onText(before);
        // Enter capture mode.
        capturing = true;
        funcBuf = "";
        bytesCount = 0;
        // Remove everything through the marker.
        buffer = buffer.slice(iStart + START.length);
      }

      // We are capturing: look for END in buffer.
      const iEnd = buffer.indexOf(END);
      if (iEnd === -1) {
        // No END yet: consume all of buffer into funcBuf and wait for more.
        if (buffer) {
          funcBuf += buffer;
          bytesCount += Buffer.byteLength(buffer, "utf8");
          if (bytesCount > MAX_FUNC_ARGS_BYTES) {
            console.warn(`Truncating hidden function payload after ${MAX_FUNC_ARGS_BYTES} bytes.`);
            funcBuf = funcBuf.slice(0, MAX_FUNC_ARGS_BYTES);
          }
          buffer = "";
        }
        return;
      }

      // We found END: take payload, then emit function.
      const payload = buffer.slice(0, iEnd);
      if (payload) {
        funcBuf += payload;
        bytesCount += Buffer.byteLength(payload, "utf8");
        if (bytesCount > MAX_FUNC_ARGS_BYTES) {
          console.warn(`Truncating hidden function payload after ${MAX_FUNC_ARGS_BYTES} bytes.`);
          funcBuf = funcBuf.slice(0, MAX_FUNC_ARGS_BYTES);
        }
      }

      // Advance buffer past the END marker.
      buffer = buffer.slice(iEnd + END.length);

      // Try to parse payload as JSON object { name, arguments }
      let fnName = null;
      let rawArgs = "";
      try {
        // The payload should be a JSON object. Example:
        // { "name": "write", "arguments": { ... } }
        const obj = JSON.parse(funcBuf);
        if (obj && typeof obj === "object") {
          fnName = String(obj.name || "").trim() || null;
          // Keep arguments as a STRING per OpenAI tool_calls spec.
          rawArgs = obj.hasOwnProperty("arguments")
            ? JSON.stringify(obj.arguments)
            : "";
        }
      } catch (e) {
        console.warn("Failed to parse hidden function JSON payload; passing raw payload as args string.");
        // Fallback: treat the whole payload as a raw JSON-ish string.
        fnName = null;
        rawArgs = String(funcBuf || "");
        // Try to heuristically extract a name if present
        try {
          const maybe = JSON.parse(funcBuf);
          if (maybe && typeof maybe === "object" && typeof maybe.name === "string") {
            fnName = maybe.name;
          }
        } catch { /* ignore */ }
      }

      if (!fnName) {
        // Try to extract "name" via regex if JSON parse failed.
        const m = /"name"\s*:\s*"([^"]+)"/.exec(funcBuf);
        if (m) fnName = m[1];
      }

      onFunction({
        name: fnName || "unknown_function",
        arguments: rawArgs || "",
        raw: funcBuf
      });

      // Reset capture state, and continue the loop:
      capturing = false;
      funcBuf = "";
      bytesCount = 0;

      // Loop again in case there is more text/functions after END.
      // If next thing in buffer is plain text, we'll emit it on the next iteration (via START search).
      // The loop continues until no more START markers are found in 'buffer'.
      const nextHasStart = buffer.indexOf(START) !== -1;
      if (!nextHasStart) {
        // Emit any remaining plain text.
        if (buffer) {
          onText(buffer);
          buffer = "";
        }
        return;
      }
      // else continue loop to process additional function(s)
    }
  };

  return {
    // push incoming delta text
    push(text) {
      if (text) {
        buffer += text;
        tryDrain();
      }
    },
    // finalize: flush any remaining plain text if not in capture
    end() {
      if (!capturing) flushText();
      // If capturing at end, we drop incomplete function payload (no END marker).
    },
  };
}

// ---- Endpoint ----
app.post("/v1/chat/completions", express.json({ limit: "200mb" }), async (req, res) => {
  const acceptHeader = String(req.headers.accept || "");
  const wantsStream = req.body?.stream === true || /text\/event-stream/i.test(acceptHeader);
  console.log(JSON.stringify(req.body,0,2));
  const { messages, model = MODEL_FALLBACK } = req.body || {};
  let promptText;
  try {
    promptText = extractLastUserMessage(messages);
  } catch (err) {
    return res.status(400).json({
      error: { message: err.message, type: "invalid_request_error", param: "messages" },
    });
  }

  const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);

  // Minimal handling for control commands
  if (promptText.trim().startsWith("\\switch") || promptText.trim() === "\\restart") {
    if (wantsStream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: "Command handled." }, finish_reason: "stop" }] });
      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    } else {
      return res.status(200).json({
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "Command handled." }, finish_reason: "stop" }],
      });
    }
  }

  try {
    if (wantsStream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();
      // Initial role chunk
      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (typeof res.flush === "function") try { res.flush(); } catch {}
    }

    // Shared state
    const assistantTextParts = [];
    let lastFunctionCall = null; // { name, arguments: string }

    // Hidden-function parser wired to our streaming writer and accumulators
    const parser = createHiddenFnParser({
      onText: (txt) => {
        if (!txt) return;
        assistantTextParts.push(txt);
        if (wantsStream) {
          sseWrite(res, {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: txt }, finish_reason: null }],
          });
          if (typeof res.flush === "function") try { res.flush(); } catch {}
        }
      },
      onFunction: ({ name, arguments: argsStr }) => {
        lastFunctionCall = { name, arguments: argsStr || "" };
      
        if (wantsStream) {
          // ---- OpenAI "tool_calls" streaming (modern spec) ----
          const callId = `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      
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
          if (typeof res.flush === "function") try { res.flush(); } catch {}
      
          // IMPORTANT: do NOT emit a mid-stream "message" object here.
        }
      },
      
    });

    // Collect per-chunk; NOTICE we no longer directly stream raw chunk.content.
    const onChunk = (chunk) => {
      try {
        if (!chunk) return;
        if (chunk.type === "message") {
          const text = chunk.content || "";
          // Feed into our parser which will emit text and/or function calls.
          parser.push(text);
          return;
        }

        // In case the provider still sends explicit function_* types, handle them too (back-compat)
        if (chunk.type === "function_start" || chunk.type === "function" || chunk.type === "function_end") {
          // Convert those to hidden marker shape by pushing synthetic markers into parser:
          if (chunk.type === "function_start") {
            parser.push("[FUNCTION_START]");
          } else if (chunk.type === "function") {
            const name = chunk.name || "unknown_function";
            const argPiece = chunk.content || "";
            // When receiving 'function' pieces, maintain a JSON object inside the markers.
            // We stream a minimal, well-formed JSON wrapper incrementally:
            // To keep it simple, just append raw pieces; the end parser will JSON.parse as a whole.
            // Example cumulative buffer: {"name":"...", "arguments": <streamed pieces>}
            // Here we just push content; assume upstream sent a full JSON object across the span.
            // If not, our parser will fall back to raw string args.
            parser.push(argPiece);
          } else if (chunk.type === "function_end") {
            parser.push("[FUNCTION_END]");
          }
          return;
        }

        // If other delta types appear (e.g., tool status), ignore gracefully.
      } catch (err) {
        console.error("Error in onChunk:", err);
      }
    };

    // Call underlying provider with the full API body (stringified)
    const fullBodyStr = prefixPrompt + JSON.stringify(req.body, null, 2);
    const fullText = await playwrightService.promptChatGPT(fullBodyStr, { timeoutMs: STREAM_TIMEOUT_MS, onChunk });

    // finalize parser (flush any tail text)
    parser.end();

    const gotAnyTextChunk = assistantTextParts.length > 0;
    const gotToolCall = !!lastFunctionCall;

    if (wantsStream) {
      // If no text/function chunks arrived but we did get a fullText, post-process it now
      if (!gotAnyTextChunk && !gotToolCall && typeof fullText === "string" && fullText.trim()) {
        // Process fullText through the same parser to strip markers and detect function once.
        let tmpLastFn = null;
        const tmpParts = [];
        const finalParser = createHiddenFnParser({
          onText: (t) => tmpParts.push(t),
          onFunction: ({ name, arguments: argsStr }) => {
            tmpLastFn = { name, arguments: argsStr || "" };
            // stream it too

          },
        });
        finalParser.push(fullText);
        finalParser.end();

        if (tmpParts.length) {
          sseWrite(res, {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, delta: { content: tmpParts.join("") }, finish_reason: null }],
          });
        }
        if (tmpLastFn) {
          sseWrite(res, {
            id, object: "chat.completion.chunk", created, model,
            choices: [{ index: 0, message: { role: "assistant", function_call: tmpLastFn }, finish_reason: "function_call" }],
          });
        }
      }

      // Finalize SSE
      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // --- NON-STREAM: build JSON response ---
    // For non-streaming, if the provider only gave us fullText, parse it to strip markers and find a tool call.
    let assistantContent = gotAnyTextChunk ? assistantTextParts.join("") : (typeof fullText === "string" ? fullText : "");
    let nonStreamFn = lastFunctionCall;

    if (!gotAnyTextChunk && !gotToolCall && assistantContent) {
      let tmpLastFn = null;
      const tmpParts = [];
      const finalParser = createHiddenFnParser({
        onText: (t) => tmpParts.push(t),
        onFunction: ({ name, arguments: argsStr }) => {
          tmpLastFn = { name, arguments: argsStr || "" };
        },
      });
      finalParser.push(assistantContent);
      finalParser.end();
      assistantContent = tmpParts.join("");
      if (tmpLastFn) nonStreamFn = tmpLastFn;
    }

    const message = { role: "assistant", content: assistantContent || "" };

    if (nonStreamFn && typeof nonStreamFn.arguments === "string") {
      const rawArgs = (nonStreamFn.arguments || "").trim();
      // Make content JSON-safe so JSON.parse(content) won't throw if clients expect JSON in content.
      try {
        const parsed = rawArgs ? JSON.parse(rawArgs) : null;
        message.content = JSON.stringify(parsed ?? { __raw: rawArgs || null });
      } catch {
        message.content = JSON.stringify({ __raw: rawArgs || null });
      }
      message.tool_calls = [
        {
          id: `call_${Date.now()}`,
          type: "function",
          function: {
            name: nonStreamFn.name,
            arguments: rawArgs, // keep STRING; tool runner will parse
          },
        },
      ];
    }

    const apiResponse = {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: nonStreamFn ? "stop" : "stop",
        },
      ],
      usage: {
        // crude approximations
        prompt_tokens: String(promptText || "").length,
        completion_tokens: String(message.content || "").length,
        total_tokens: String(promptText || "").length + String(message.content || "").length,
      },
    };

    return res.status(200).json(apiResponse);
  } catch (error) {
    console.error("Error in /v1/chat/completions:", error);
    if (error?.message?.includes("413") || error?.statusCode === 413) {
      return res.status(413).json({
        error: { message: "Payload too large. Please shorten your input.", type: "invalid_request_error" },
      });
    }
    return res.status(500).json({
      error: { message: "Failed to get response from ChatGPT service. " + (error?.message || "Internal server error."), type: "api_error" },
    });
  }
});

// ---- Info endpoints ----
app.get("/", (req, res) => {
  res.json({ ok: true, service: "OpenAI-compatible proxy", endpoints: ["/v1/chat/completions", "/v1/models"] });
});

app.get("/v1/models", (req, res) => {
  const model = MODEL_FALLBACK;
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: [{ id: model, object: "model", created, owned_by: "system" }],
  });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

// ---- Graceful shutdown ----
async function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  try {
    await playwrightService.closeBrowser();
  } catch (err) {
    console.error("Error closing browser:", err);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
