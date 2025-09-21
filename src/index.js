// index.js
// OpenAI-compatible SSE proxy using a Playwright-backed ChatGPT service.
// - Buffers function calls between function_start and function_end and emits one full function_call arguments string.
// - Emits both streaming deltas and final message chunks to maximize compatibility with various clients.
// - Non-streaming mode reuses chunk handling to build a single JSON response; it parses function arguments when valid JSON.

import express from "express";
import cors from "cors";
import readline from "readline";
import { playwrightService } from "./services/chatgptService.js";

const app = express();
const port = process.env.PORT || 3000;

// Config
const MODEL_FALLBACK = process.env.OPENAI_MODEL || "gpt-5";
const STREAM_TIMEOUT_MS = parseInt(process.env.STREAM_TIMEOUT_MS || "1800000", 10); // 30 min
const MAX_BODY = process.env.MAX_BODY || "100mb";
const MAX_FUNC_ARGS_BYTES = parseInt(process.env.MAX_FUNC_ARGS_BYTES || `${1024 * 1024}`, 10); // default 1MB

// Middleware
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

// Start Playwright session early (fail fast)
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

// Console shortcuts for refresh/save
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log("Press 'r' + Enter at any time to refresh the browser context.");
console.log("Press 's' + Enter at any time to save the browser session.");
rl.on("line", async (input) => {
  const cmd = input.trim().toLowerCase();
  if (cmd === "r") {
    console.log("Refreshing browser context...");
    try {
      await playwrightService.saveSession();
      await playwrightService.closeBrowser();
      await playwrightService.initializeBrowser();
      console.log("Browser context refreshed.");
    } catch (err) {
      console.error("Failed to refresh context:", err);
    }
  } else if (cmd === "s") {
    console.log("Saving browser session...");
    try {
      await playwrightService.saveSession();
      console.log("Session saved.");
    } catch (err) {
      console.error("Failed to save session:", err);
    }
  }
});

// Helpers
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

// Routes
app.post("/v1/chat/completions", express.json({ limit: "200mb" }), async (req, res) => {
  const { messages, model = MODEL_FALLBACK, stream = true } = req.body || {};
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

  // handle \switch and \restart shortcuts
  if (promptText.trim().startsWith("\\switch")) {
    const parts = promptText.trim().split(/\s+/);
    try {
      let message;
      if (parts.length === 1) {
        const models = await playwrightService.listModels();
        message =
          "Type \\switch modelname with modelname among :\n" +
          models
            .filter((m) => m.startsWith("model-switcher-"))
            .map((m) => m.replace("model-switcher-", ""))
            .map((m) => `• ${m}`)
            .join("\n");
      } else {
        const modelName = parts[1];
        const ok = await playwrightService.switchModel(modelName);
        message = ok ? `✅ Switched to ${modelName}` : `❌ Failed to switch to ${modelName}`;
      }

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
        sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: message }, finish_reason: "stop" }] });
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
          choices: [{ index: 0, message: { role: "assistant", content: message }, finish_reason: "stop" }],
        });
      }
    } catch (err) {
      console.error("Failed to handle \\switch:", err);
      return res.status(500).json({ error: { message: "Failed to handle \\switch: " + (err?.message || "Unknown error."), type: "api_error" } });
    }
  } else if (promptText.trim() === "\\restart") {
    console.log("Restart command received via API. Refreshing browser context...");
    try {
      await playwrightService.saveSession();
      await playwrightService.closeBrowser();
      await playwrightService.initializeBrowser();
      console.log("Browser context refreshed successfully.");
      if (stream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
        sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: "🔄 Browser context refreshed successfully." }, finish_reason: "stop" }] });
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
          choices: [{ index: 0, message: { role: "assistant", content: "🔄 Browser context refreshed successfully." }, finish_reason: "stop" }],
        });
      }
    } catch (err) {
      console.error("Failed to refresh context:", err);
      return res.status(500).json({ error: { message: "Failed to refresh context: " + (err?.message || "Unknown error."), type: "api_error" } });
    }
  }

  // Normal flow
  try {
    // If streaming, set SSE headers now
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
      if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
    }

    const funcBuffers = new Map(); // key -> { name, args }
    let anonFnCounter = 0;
    const assistantTextParts = [];
    let lastFunctionCall = null;

    const findBufferKeyByName = (name) => {
      for (const [k, v] of funcBuffers.entries()) if (v && v.name === name) return k;
      return null;
    };

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

          lastFunctionCall = { name: buf.name, arguments: buf.args };

          if (stream) {
            // streaming delta
            sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { function_call: { name: buf.name, arguments: buf.args } }, finish_reason: null }] });
            if (typeof res.flush === "function") try { res.flush(); } catch (e) {}

            // final message variations for compatibility
            sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, message: { role: "assistant", function_call: { name: buf.name, arguments: buf.args } }, finish_reason: "function_call" }] });
            if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
            sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, message: { role: "assistant", function_call: { name: buf.name, arguments: buf.args } }, finish_reason: "stop" }] });
            if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
          }

          if (key) funcBuffers.delete(key);
          return;
        }

        if (chunk.type === "message") {
          assistantTextParts.push(chunk.content || "");
          if (stream) {
            sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: chunk.content }, finish_reason: null }] });
            if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
          }
          return;
        }

        console.warn("Unhandled chunk type:", chunk.type, chunk);
      } catch (err) {
        console.error("Error in onChunk:", err);
      }
    };

    // Use the same underlying Playwright call for both streaming and non-streaming.
    // We pass the entire request body (stringified) so Playwright receives the same context as streaming callers.
    await playwrightService.promptChatGPT(JSON.stringify(req.body, null, 2), { timeoutMs: STREAM_TIMEOUT_MS, onChunk });

    // flush any remaining buffered functions
    if (funcBuffers.size > 0) {
      for (const [key, buf] of funcBuffers.entries()) {
        lastFunctionCall = { name: buf.name, arguments: buf.args };
        if (stream) {
          sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { function_call: { name: buf.name, arguments: buf.args } }, finish_reason: null }] });
          if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
          sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, message: { role: "assistant", function_call: { name: buf.name, arguments: buf.args } }, finish_reason: "function_call" }] });
          if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
          sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, message: { role: "assistant", function_call: { name: buf.name, arguments: buf.args } }, finish_reason: "stop" }] });
          if (typeof res.flush === "function") try { res.flush(); } catch (e) {}
        }
        funcBuffers.delete(key);
      }
    }

    // End stream mode: send final stop and close
    if (stream) {
      sseWrite(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    // Non-streaming: produce standard OpenAI-like JSON response.
    const assistantContent = assistantTextParts.join("");

    // Construct choices[0] message:
    // - If we have a valid lastFunctionCall.arguments containing JSON, parse and return as an object so Shai can use it directly.
    // - If lastFunctionCall.arguments is empty or invalid JSON, omit the function_call to avoid downstream parse errors.
    let apiChoice = { index: 0, message: { role: "assistant", content: assistantContent }, finish_reason: "stop" };

    if (lastFunctionCall && typeof lastFunctionCall.arguments === "string" && lastFunctionCall.arguments.trim().length > 0) {
      // try to parse arguments
      try {
        const parsed = JSON.parse(lastFunctionCall.arguments);
        apiChoice.message = {
          role: "assistant",
          function_call: {
            name: lastFunctionCall.name,
            arguments: parsed, // provide object for non-stream clients
          },
        };
        apiChoice.finish_reason = "function_call";
      } catch (e) {
        // arguments present but not valid JSON - include as string (but some clients may still fail)
        // To be safe for Shai, if parsing fails we choose to include an object with a raw string field
        apiChoice.message = {
          role: "assistant",
          function_call: {
            name: lastFunctionCall.name,
            arguments: lastFunctionCall.arguments, // fallback string
          },
        };
        apiChoice.finish_reason = "function_call";
      }
    }

    const apiResponse = {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [apiChoice],
      usage: {
        prompt_tokens: promptText.length,
        completion_tokens: assistantContent.length,
        total_tokens: promptText.length + assistantContent.length,
      },
    };

    return res.status(200).json(apiResponse);
  } catch (error) {
    console.error("Error in /v1/chat/completions:", error);
    if (error?.message?.includes("413") || error?.statusCode === 413) {
      return res.status(413).json({ error: { message: "Payload too large. Please shorten your input.", type: "invalid_request_error" } });
    }
    return res.status(500).json({ error: { message: "Failed to get response from ChatGPT service. " + (error?.message || "Internal server error."), type: "api_error" } });
  }
});

// Basic info endpoint
app.get("/", (req, res) => {
  res.json({ ok: true, service: "OpenAI-compatible proxy", endpoints: ["/v1/chat/completions", "/v1/models"] });
});

app.get("/v1/models", (req, res) => {
  const model = MODEL_FALLBACK;
  const created = Math.floor(Date.now() / 1000);
  res.json({ object: "list", data: [{ id: model, object: "model", created, owned_by: "system" }] });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  try { await playwrightService.closeBrowser(); } catch (err) { console.error("Error closing browser:", err); } finally { process.exit(0); }
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
