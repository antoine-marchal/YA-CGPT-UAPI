// index.js
import express from "express";
import cors from "cors";
import readline from "readline";
import { playwrightService } from "./services/chatgptService.js";

const app = express();
const port = process.env.PORT || 3000;

// ------- Config -------
const MODEL_FALLBACK = process.env.OPENAI_MODEL || "gpt-5";
const STREAM_TIMEOUT_MS = parseInt(process.env.STREAM_TIMEOUT_MS || "30*60000", 10);

// ------- CORS & JSON -------
app.use(
  cors({
    origin: (origin, cb) => {
      // allow localhost & file:// (null)
      if (!origin || origin === "null" || origin.startsWith("http://localhost")) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
  })
);
const MAX_BODY = process.env.MAX_BODY || '100mb';
app.use(express.json({
  limit: MAX_BODY,
  type: ['application/json', 'application/*+json']  // covers common clients
}));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY }));


// ------- Startup: initialize browser (fail fast if it can’t) -------
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

// ------- Refresh context (manual shortcut) -------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log("Press 'r' + Enter at any time to refresh the browser context.");
console.log("Press 's' + Enter at any time to save the browser session.");
rl.on("line", async (input) => {
  if (input.trim().toLowerCase() === "r") {
    console.log("♻️  Refreshing browser context...");
    try {
      await playwrightService.saveSession();
      await playwrightService.closeBrowser();
      await playwrightService.initializeBrowser();
      console.log("✅ Browser context refreshed successfully.");
    } catch (err) {
      console.error("❌ Failed to refresh context:", err);
    }
  }
  else if(input.trim().toLowerCase() === "s") {
    console.log("♻️  Saving browser session...");
    try {
      await playwrightService.saveSession();
    } catch (err) {
      console.error("❌ Failed to save session:", err);
    }
  }
  
});





// ------- Helpers -------
function extractLastUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Invalid request: 'messages' must be a non-empty array.");
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object") throw new Error(`Invalid message at index ${i}.`);
    if (typeof m.role !== "string" || !m.role.trim())
      throw new Error(`Invalid role at index ${i}.`);
    if (typeof m.content !== "string" || !m.content.trim())
      throw new Error(`Invalid content at index ${i}.`);
    if (m.role === "user") return m.content;
  }
  throw new Error("No user message with content found in 'messages'.");
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// ------- Routes -------
app.post(
  '/v1/chat/completions',
  express.json({ limit: '200mb' }), // route-specific limit
  async (req, res) => {
  const { messages, model = MODEL_FALLBACK, stream = false } = req.body || {};
  let promptText;
  try {
    promptText = extractLastUserMessage(messages);
  } catch (err) {
    return res.status(400).json({
      error: {
        message: err.message,
        type: "invalid_request_error",
        param: "messages",
      },
    });
  }

  const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  
  // Handle special restart command
  if (promptText.trim() === "\\restart") {
    console.log("♻️  Restart command received via API. Refreshing browser context...");
    try {
      await playwrightService.saveSession();
      await playwrightService.closeBrowser();
      await playwrightService.initializeBrowser();
      console.log("✅ Browser context refreshed successfully.");
      if (stream) {
        // SSE headers
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        // First chunk: role only
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        });

        // Stream the fixed message in a single chunk
        const message = "🔄 Browser context refreshed successfully.";
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: message },
              finish_reason: "stop",
            },
          ],
        });

        // Final empty delta with finish_reason
        sseWrite(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        return res.status(200).json({
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "🔄 Browser context refreshed successfully." },
              finish_reason: "stop",
            },
          ],
        });
      }
    } catch (err) {
      console.error("❌ Failed to refresh context:", err);
      return res.status(500).json({
        error: {
          message: "Failed to refresh context: " + (err?.message || "Unknown error."),
          type: "api_error",
        },
      });
    }
  }

  try {
    if (stream) {
      // SSE headers
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");

      // First chunk: role only
      sseWrite(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      });

      // Stream body
      let firstContent = true;
      console.log("Received a prompt : "+ id);
      const fullText = await playwrightService.promptChatGPT(promptText, {
        timeoutMs: STREAM_TIMEOUT_MS,
        onChunk: (chunk) => {
          if (!chunk) return;
          // Emit deltas as they arrive
          sseWrite(res, {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { content: chunk },
                finish_reason: null,
              },
            ],
          });
          // Optionally flush, helpful behind some proxies
          if (typeof res.flushHeaders === "function" && firstContent) {
            res.flushHeaders();
            firstContent = false;
          }
        },
      });

      // Final empty delta with finish_reason
      sseWrite(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      });

      // [DONE]
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      const responseText = await playwrightService.promptChatGPT(promptText, {
        timeoutMs: STREAM_TIMEOUT_MS,
      });

      const apiResponse = {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseText },
            finish_reason: "stop",
          },
        ],
        usage: {
          // crude approximations by char length
          prompt_tokens: promptText.length,
          completion_tokens: responseText.length,
          total_tokens: promptText.length + responseText.length,
        },
      };
      res.status(200).json(apiResponse);
    }
  } catch (error) {
    console.error("Error in /v1/chat/completions:", error);
    if (error?.message?.includes("413") || error?.statusCode === 413) {
      return res.status(413).json({
        error: {
          message: "Payload too large. Please shorten your input.",
          type: "invalid_request_error",
        },
      });
    }
    res.status(500).json({
      error: {
        message:
          "Failed to get response from ChatGPT service. " +
          (error?.message || "Internal server error."),
        type: "api_error",
      },
    });
  }
});

app.get("/", (req, res) => {
  res.json({ ok: true, service: "OpenAI-compatible proxy", endpoints: ["/v1/chat/completions", "/v1/models"] });
});

// OpenAI-compatible models endpoint
app.get("/v1/models", (req, res) => {
  const model = MODEL_FALLBACK;
  const created = Math.floor(Date.now() / 1000);
  res.json({
    object: "list",
    data: [
      {
        id: model,
        object: "model",
        created,
        owned_by: "system",
      },
    ],
  });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

// ------- Graceful shutdown -------
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
