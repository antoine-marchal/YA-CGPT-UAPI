// Register built-in system functions
import { registerFunction } from './utils/functionExecutor.js';
import {bash,ls} from './utils/systemFunctions.js';

registerFunction('bash', bash);
registerFunction('ls', ls);
// index.js
// OpenAI-compatible SSE proxy (Playwright-backed).
// - Streams only when explicitly requested (body.stream === true OR Accept: text/event-stream).
// - Buffers function chunks between function_start/function_end.
// - Non-stream returns modern tool_calls shape (arguments as STRING).
// - NEW: Fallback to fullText return when no per-chunk messages arrived (CSP/no-inject scenarios).

import express from "express";
import cors from "cors";
import readline from "readline";
import { playwrightService } from "./services/chatgptService.js";

const app = express();
const port = process.env.PORT || 3000;

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

// ---- Endpoint ----
app.post("/v1/chat/completions", express.json({ limit: "200mb" }), async (req, res) => {
  // Decide streaming: only if explicitly requested
  const acceptHeader = String(req.headers.accept || "");
  const wantsStream = req.body?.stream === true || /text\/event-stream/i.test(acceptHeader);

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
    const funcBuffers = new Map(); // key -> { name, args }
    let anonFnCounter = 0;
    const assistantTextParts = [];
    let lastFunctionCall = null; // { name, arguments: string }

    const findBufferKeyByName = (name) => {
      for (const [k, v] of funcBuffers.entries()) if (v && v.name === name) return k;
      return null;
    };

    // Collect per-chunk; we'll also use the function's return value for fallback
    const onChunk = (chunk) => {
      try {
        if (!chunk) return;
        const hasMsgId = !!chunk.message_id;

        if (chunk.type === "function_start") {
          const key = hasMsgId ? chunk.message_id : `anon:${chunk.name}:${++anonFnCounter}`;
          funcBuffers.set(key, { name: chunk.name, args: "" });
          return;
        }

        if (chunk.type === "function") {
          let key = hasMsgId ? chunk.message_id : findBufferKeyByName(chunk.name);
          if (!key) {
            key = `anon:${chunk.name}:${++anonFnCounter}`;
            funcBuffers.set(key, { name: chunk.name, args: "" });
          }
          const buf = funcBuffers.get(key);
          buf.args += chunk.content || "";
          if (buf.args.length > MAX_FUNC_ARGS_BYTES) {
            console.warn(`Truncating function args for ${buf.name} after ${MAX_FUNC_ARGS_BYTES} bytes.`);
            buf.args = buf.args.slice(0, MAX_FUNC_ARGS_BYTES);
          }
          funcBuffers.set(key, buf);
          return;
        }

        if (chunk.type === "function_end") {
          const key = hasMsgId ? chunk.message_id : findBufferKeyByName(chunk.name);
          const buf = funcBuffers.get(key) || { name: chunk.name || "unknown", args: "" };
          lastFunctionCall = { name: buf.name, arguments: buf.args || "" };

          if (wantsStream) {
            // Legacy streaming (delta.function_call)
            sseWrite(res, {
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { function_call: { name: buf.name, arguments: buf.args } }, finish_reason: null }],
            });
            if (typeof res.flush === "function") try { res.flush(); } catch {}
            // Optional final message chunk (some clients expect it)
            sseWrite(res, {
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, message: { role: "assistant", function_call: { name: buf.name, arguments: buf.args } }, finish_reason: "function_call" }],
            });
            if (typeof res.flush === "function") try { res.flush(); } catch {}
          }

          if (key) funcBuffers.delete(key);
          return;
        }

        if (chunk.type === "message") {
          assistantTextParts.push(chunk.content || "");
          if (wantsStream) {
            sseWrite(res, {
              id, object: "chat.completion.chunk", created, model,
              choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }],
            });
            if (typeof res.flush === "function") try { res.flush(); } catch {}
          }
          return;
        }

        console.warn("Unhandled chunk type:", chunk.type, chunk);
      } catch (err) {
        console.error("Error in onChunk:", err);
      }
    };

    // Call underlying provider with the full API body (stringified)
    const fullBodyStr = JSON.stringify(req.body, null, 2);
    const fullText = await playwrightService.promptChatGPT(fullBodyStr, { timeoutMs: STREAM_TIMEOUT_MS, onChunk });

    // --- Fallbacks when no chunks arrived ---
    const gotAnyTextChunk = assistantTextParts.length > 0;
    const gotToolCall = !!lastFunctionCall;

    if (wantsStream) {
      // If no text/function chunks arrived but we did get a fullText, stream it now
      if (!gotAnyTextChunk && !gotToolCall && typeof fullText === "string" && fullText.trim()) {
        sseWrite(res, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { content: fullText }, finish_reason: null }],
        });
      }

      // Finalize SSE
      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // --- NON-STREAM: build JSON response ---
    const assistantContent = (gotAnyTextChunk ? assistantTextParts.join("") : (typeof fullText === "string" ? fullText : "")) || "";

    const message = { role: "assistant", content: assistantContent };

    // If a tool call exists, emit modern tool_calls (arguments as STRING) and
    // ensure content is a JSON string so JSON.parse(content) won't fail.
    if (lastFunctionCall && typeof lastFunctionCall.arguments === "string") {
      const rawArgs = (lastFunctionCall.arguments || "").trim();

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
            name: lastFunctionCall.name,
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
          finish_reason: lastFunctionCall ? "stop" : (assistantContent ? "stop" : "stop"),
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
  res.json({
    ok: true,
    service: "OpenAI-compatible proxy",
    endpoints: ["/v1/chat/completions", "/v1/models"],
    capabilities: {
      can_use_attachments: true
    }
  });
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
