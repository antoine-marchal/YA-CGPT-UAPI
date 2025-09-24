import { cliOptions } from "./config/cliOptions.js";
// index.js
// OpenAI-compatible SSE proxy (Playwright-backed).
// Streams only regular assistant messages (no tool/function calls).

import express from "express";
import cors from "cors";
import readline from "readline";
import { playwrightService } from "./services/chatgptService.js";

const app = express();
const port = process.env.PORT || 3000;



const MODEL_FALLBACK = process.env.OPENAI_MODEL || "gpt-5";
const STREAM_TIMEOUT_MS = parseInt(process.env.STREAM_TIMEOUT_MS || "1800000", 10); // 30 min
const MAX_BODY = process.env.MAX_BODY || "100mb";

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



function sseWrite(res, obj) {
  try {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch (e) {
    console.error("sseWrite error:", e?.message || e);
  }
}

// ---- Endpoint ----
app.post("/v1/chat/completions", express.json({ limit: "200mb" }), async (req, res) => {
  const acceptHeader = String(req.headers.accept || "");
  const wantsStream = req.body?.stream === true || /text\/event-stream/i.test(acceptHeader);
  const { messages, model = MODEL_FALLBACK } = req.body || {};


  const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);

  try {
    // ---------- STREAM MODE ----------
    if (wantsStream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      //if (typeof res.flushHeaders === "function") res.flushHeaders();

      // Initial role chunk
      sseWrite(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      });
      //if (typeof res.flush === "function") try { res.flush(); } catch {}

      // Stream text as it arrives, buffer entire assistant message too
      let assistantContent = "";

      const onChunk = (chunk) => {
       
        if (!chunk) return;
        // Accept only "message" or plain content chunks
        if (chunk.type === "message" || chunk.type === "function" || chunk.type === undefined || chunk.type === null) {
          const text = chunk.content || "";
          if (text) {
            assistantContent += text;
            sseWrite(res, {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
            });
            //if (typeof res.flush === "function") try { res.flush(); } catch {}
          }
        }
      };

      // Compose prompt, send to underlying service
      const bodyToSend = JSON.stringify(req.body, null, 2);
      const fullBodyStr = bodyToSend;
      await playwrightService.promptChatGPT(fullBodyStr, { timeoutMs: STREAM_TIMEOUT_MS, onChunk },cliOptions.useprefix);

      // At the end: try to detect function call in full buffer
      function tryFindFunctionCall(text) {
        // 1. Try direct JSON.parse (if string, or already object)
        let obj = null;
        if (typeof text === "object" && text !== null && typeof text.name === "string" && text.arguments) {
          return { json: text, raw: JSON.stringify(text), start: 0, end: JSON.stringify(text).length };
        }
        if (typeof text === "string") {
          try {
            obj = JSON.parse(text);
            if (obj && typeof obj === "object" && typeof obj.name === "string" && obj.arguments) {
              return { json: obj, raw: text, start: 0, end: text.length };
            }
          } catch {}
          // 2. Regex for embedded JSON object
          const regex = /({\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*{[\s\S]*?}})/;
          const match = regex.exec(text);
          if (match) {
            try {
              const obj2 = JSON.parse(match[1]);
              if (typeof obj2 === "object" && obj2.name && obj2.arguments) {
                return { json: obj2, raw: match[1], start: match.index, end: match.index + match[1].length };
              }
            } catch {}
          }
        }
        return null;
      }

      const foundFn = tryFindFunctionCall(assistantContent);

      if (foundFn) {
        // OpenAI spec: stream the function tool_call
        const name = foundFn.json.name;
        let argsStr = "";
        try { argsStr = JSON.stringify(foundFn.json.arguments); } catch {}
        const callId = `tool_${Date.now()}_${Math.floor(Math.random()*1e8)}`;

        // 1) Announce the tool call with function name
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

        // 2) Stream the arguments as a string
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

        // 3) End with finish_reason "tool_calls"
        sseWrite(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
        });
        res.end();
        return;
      } else {
        // No function call found, normal end of stream
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        });
        res.end();
        return;
      }
    }

    // ---------- NON-STREAM MODE ----------
    // Call underlying provider as a full text (non-streaming) request
    const bodyToSend = JSON.stringify(req.body, null, 2);
    const fullBodyStr = bodyToSend;
    const fullText = await playwrightService.promptChatGPT(fullBodyStr, { timeoutMs: STREAM_TIMEOUT_MS },cliOptions.useprefix);

    let content = typeof fullText === "string" ? fullText : "";

    function tryFindFunctionCall(text) {
      // 1. Try direct JSON.parse (if string, or already object)
      let obj = null;
      if (typeof text === "object" && text !== null && typeof text.name === "string" && text.arguments) {
        return { json: text, raw: JSON.stringify(text), start: 0, end: JSON.stringify(text).length };
      }
      if (typeof text === "string") {
        try {
          obj = JSON.parse(text);
          if (obj && typeof obj === "object" && typeof obj.name === "string" && obj.arguments) {
            return { json: obj, raw: text, start: 0, end: text.length };
          }
        } catch {}
        // 2. Regex for embedded JSON object
        const regex = /({\s*"name"\s*:\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*{[\s\S]*?}})/;
        const match = regex.exec(text);
        if (match) {
          try {
            const obj2 = JSON.parse(match[1]);
            if (typeof obj2 === "object" && obj2.name && obj2.arguments) {
              return { json: obj2, raw: match[1], start: match.index, end: match.index + match[1].length };
            }
          } catch {}
        }
      }
      return null;
    }
    

    const foundFn = tryFindFunctionCall(content);

    if (foundFn) {
      // Return only the tool_call, OpenAI spec (as if it's function_call mode)
      const name = foundFn.json.name;
      let argsStr = "";
      try { argsStr = JSON.stringify(foundFn.json.arguments); } catch {}
      const callId = `tool_${Date.now()}_${Math.floor(Math.random()*1e8)}`;
      const apiResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: callId,
                  type: "function",
                  function: {
                    name,
                    arguments: argsStr
                  }
                }
              ]
            },
            finish_reason: "tool_calls"
          },
        ],
        usage: {
          prompt_tokens: String(fullBodyStr || "").length,
          completion_tokens: argsStr.length,
          total_tokens: String(fullBodyStr || "").length + argsStr.length,
        }
      };

      return res.status(200).json(apiResponse);
    } else {
      // Standard message
      const message = { role: "assistant", content: content.trim() };
      const apiResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: String(fullBodyStr || "").length,
          completion_tokens: String(message.content || "").length,
          total_tokens: String(fullBodyStr || "").length + String(message.content || "").length,
        },
      };
      return res.status(200).json(apiResponse);
    }
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
