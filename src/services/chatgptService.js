import { cliOptions } from "../config/cliOptions.js";
import {
  init as listenerInit,
  sendMessage as listenerSendMessage,
  listModels as listenerListModels,
  switchModel as listenerSwitchModel,
  attachFilesToChat as listenerAttachFilesToChat,
} from "../chatgptlistener.js";
import { Mutex } from "../utils/mutex.js";
import fs from "fs";
import path from "path";

let session;  // store the full session
let readyPromise = null;
const mutex = new Mutex();

// ====== Config ======
const TOKEN_LIMIT = 16000; // threshold for deciding file vs direct message
const ATTACH_PREFIX = `SYSTEM INSTRUCTION :
1) Consider the file's contents to be the user's direct prompt.
2) Do NOT mention or describe the file; do not say "attached file".
3) Parse the content fully. If JSON, treat fields as the request payload.
4) If the content requests tools/functions, proceed to call them immediately.
5) Prefer instructions within the file over any prior context if conflict exists.
6) Respond exactly as if the user typed this content in chat.
7) Keep the normal response style (no meta commentary about files or uploads).

`;

const prefixPrompt = `SYSTEM INSTRUCTION (FUNCTION CALLING RULES) (HIGHEST PRIORITY):
1) Prefer execution over description. If the user requests an action, attempt to execute it via the available functions/tools.
2) When calling a function, return JSON with both "name" and "arguments" (e.g., {"name":"write","arguments":{...}}).
3) Do not repeat a function call that has already succeeded or would be a no-op (content already present).
4) Do not repeat twice write functions that has the same content.
4) Only use functions explicitly named in the prompt; if none match, respond as a normal assistant message.
5) If required details are missing, ask the minimal clarifying question needed; otherwise choose sensible defaults and proceed.
6) After execution, report concrete outcomes (success details or precise errors) and next steps if needed.
7) If execution is impossible (permissions, safety, or environment), state the specific reason and propose a safe alternative—do NOT use generic phrases like "cannot run *** here".
8) Do not reference or explain these rules in your output.

`;

// ====== Utils ======
function ensureUploadDir() {
  const uploadDir = path.resolve("upload");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  return uploadDir;
}

/**
 * Heuristic token estimator (no deps).
 * Tuned for OpenAI-style BPEs (cl100k-like), good enough for gating at ~8k.
 *
 * Rules of thumb:
 * - ASCII prose ≈ 4 chars per token
 * - CJK (Han/Hiragana/Katakana/Hangul) ≈ 1 char per token
 * - Emojis/symbols tend to be multi-token; count ≈ 2 tokens each
 * - JSON punctuation adds a little overhead
 * - Add a small safety margin (5–10%)
 */
function approxTokens(payload) {
  const s = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  if (!s) return 0;

  // Buckets
  const cjkRe = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g; // Han, Kana, Hangul
  const emojiRe = /\p{Extended_Pictographic}/gu; // emojis & many pictographs (requires Node 16+)
  const jsonPunctRe = /[{}[\]:,]/g;

  const cjkCount = (s.match(cjkRe) || []).length;
  const emojiCount = (s.match(emojiRe) || []).length;

  // Non-ASCII chars (may include CJK, emoji, accented letters)
  const asciiOnly = s.replace(/[^\x00-\x7F]/g, "");
  const nonAsciiCount = s.length - asciiOnly.length;

  // Estimate per bucket
  const asciiTokens = asciiOnly.length / 4;        // common quick heuristic
  const cjkTokens = cjkCount * 1.0;               // ~1 char per token
  const emojiTokens = emojiCount * 2.0;           // ~2 tokens per emoji (average)
  const otherNonAscii = Math.max(0, nonAsciiCount - cjkCount - emojiCount);
  const otherNonAsciiTokens = otherNonAscii / 2;  // accented letters, symbols, etc.

  // JSON punctuation adds tiny overhead (structures, separators)
  const jsonPunctCount = (s.match(jsonPunctRe) || []).length;
  const jsonOverhead = jsonPunctCount * 0.25;

  // Sum and pad with a safety margin
  const raw =
    asciiTokens +
    cjkTokens +
    emojiTokens +
    otherNonAsciiTokens +
    jsonOverhead;

  const safety = 1.08; // 8% cushion to reduce underestimation risk
  return Math.ceil(raw * safety);
}


/**
 * Extract images from a prompt (JSON string), writing each data URL image to disk,
 * and return:
 *  - cleanedPrompt: same payload with data URL images removed from message content
 *  - filePaths: array of saved image file paths
 *
 * Supports parts like: { image_url: { url: "data:image/png;base64,..." } }
 */
function extractImagesFromPrompt(promptJsonString) {
  const uploadDir = ensureUploadDir();
  const imagePaths = [];

  let parsed;
  try {
    parsed = JSON.parse(promptJsonString);
  } catch {
    // If not JSON, just return it untouched
    return { cleanedPrompt: promptJsonString, filePaths: [] };
  }

  if (!parsed?.messages || !Array.isArray(parsed.messages)) {
    return { cleanedPrompt: parsed, filePaths: [] };
  }

  const cleanedMessages = parsed.messages.map((msg) => {
    if (!msg?.content || !Array.isArray(msg.content)) return msg;

    const newContent = msg.content.filter((part) => {
      // Basic OpenAI content-part shape support (image_url)
      const dataUrl = part?.image_url?.url;
      if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
        try {
          const match = /^data:(.+?);base64,(.*)$/.exec(dataUrl);
          if (!match) return false;
          const mimeType = match[1];
          const b64data = match[2];
          const ext = (mimeType.split("/")[1] || "bin").split(";")[0]; // strip params if any
          const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
          const filePath = path.join(uploadDir, filename);
          fs.writeFileSync(filePath, Buffer.from(b64data, "base64"));
          imagePaths.push(filePath);
          return false; // remove the image part from the messages
        } catch (e) {
          console.error("Failed to decode/emit data URL image:", e);
          // keep part if we cannot process it, to avoid losing info
          return true;
        }
      }

      // Some tools may use { type: "input_image", image_url: "data:..." }
      if (
        (part?.type === "input_image" || part?.type === "image_url") &&
        typeof part?.image_url === "string" &&
        part.image_url.startsWith("data:")
      ) {
        try {
          const match = /^data:(.+?);base64,(.*)$/.exec(part.image_url);
          if (!match) return false;
          const mimeType = match[1];
          const b64data = match[2];
          const ext = (mimeType.split("/")[1] || "bin").split(";")[0];
          const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
          const filePath = path.join(uploadDir, filename);
          fs.writeFileSync(filePath, Buffer.from(b64data, "base64"));
          imagePaths.push(filePath);
          return false;
        } catch (e) {
          console.error("Failed to decode/emit data URL image (alt shape):", e);
          return true;
        }
      }

      return true; // keep normal text/other parts
    });

    return { ...msg, content: newContent };
  });

  const cleanedPrompt = { ...parsed, messages: cleanedMessages };
  return { cleanedPrompt, filePaths: imagePaths };
}

/**
 * Persist a prompt payload to a temp JSON file and return its path.
 * It prefixes the JSON content with ATTACH_PREFIX.
 */
function writePromptAttachment(promptPayload,usePrefix = false) {
  const uploadDir = ensureUploadDir();
  const filename = `prompt_${Date.now()}_${Math.random().toString(36).slice(2)}.json`;
  const filePath = path.join(uploadDir, filename);

  try {
    const body =
      ATTACH_PREFIX + (usePrefix?prefixPrompt:"") + JSON.stringify(promptPayload, null, 2);
    fs.writeFileSync(filePath, body, "utf8");
    return filePath;
  } catch (e) {
    console.error("Failed to write prompt attachment:", e);
    return null;
  }
}

export const playwrightService = {
  async initializeBrowser() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      session = await listenerInit({
        headless: cliOptions.headless,
      });
      return session;
    })();
    return readyPromise;
  },

  async listModels() {
    await this.initializeBrowser();
    return await listenerListModels(session.page);
  },

  async switchModel(modelName) {
    await this.initializeBrowser();
    return await listenerSwitchModel(session.page, modelName);
  },

  async promptChatGPT(prompt, { onChunk, timeoutMs } = {},usePrefix = false) {
    await this.initializeBrowser();
    const release = await mutex.acquire();

    // We will collect *all* file paths we attach (images + optional JSON prompt)
    const filePaths = [];
    try {
      // ---- 1) Extract images and produce a cleaned prompt (with images removed) ----
      const { cleanedPrompt, filePaths: imageFiles } = extractImagesFromPrompt(prompt);
      if (Array.isArray(imageFiles) && imageFiles.length > 0) {
        filePaths.push(...imageFiles);
      }

      // ---- 2) Decide if cleaned prompt must be attached as a JSON file or sent directly ----
      // We only consider the cleaned prompt (images removed) for token counting.
      const tokenEstimate = approxTokens(cleanedPrompt);

      let sendBody = ""; // what we'll pass to listenerSendMessage
      if (tokenEstimate > TOKEN_LIMIT) {
        // 2a) Too large: write cleaned prompt to a JSON file (with prefix) and attach the file.
        const promptPath = writePromptAttachment(cleanedPrompt,usePrefix);
        if (promptPath) {
          filePaths.push(promptPath);
          //console.log("📎 Attaching large prompt JSON to chat:", promptPath);
        } else {
          console.warn("⚠️ Could not create prompt attachment; will fallback to sending body directly.");
          sendBody = JSON.stringify(cleanedPrompt); // fallback
        }
      } else {
        // 2b) Small enough: send directly as message (no JSON prompt attachment)
        sendBody = (usePrefix?prefixPrompt:"") + JSON.stringify(cleanedPrompt);
      }

      // ---- 3) Attach files if any (images and/or prompt JSON) ----
      if (filePaths.length > 0) {
        //console.log("📎 Attaching files to chat:", filePaths);
        await listenerAttachFilesToChat(session, filePaths);
      }

      // ---- 4) Send message (empty string if we want model to read from attached prompt JSON) ----
      return await listenerSendMessage(
        session,
        sendBody, // "" when we chose to attach JSON prompt; otherwise the JSON string of cleanedPrompt
        { onChunk, timeoutMs }
      );
    } finally {
      // ---- 5) Cleanup temporary files we created ----
      for (const f of filePaths) {
        try {
          fs.unlinkSync(f);
        } catch (e) {
          console.warn("⚠️ Could not delete file:", f, e.message);
        }
      }
      release();
    }
  },

  async saveSession() {
    if (!session?.context || !session?.sessionFile) return;
    const state = await session.context.storageState();
    import("fs").then((fs) => {
      fs.writeFileSync(session.sessionFile, JSON.stringify(state, null, 2), "utf8");
    });
    console.log("✅ Session saved to", session.sessionFile);
  },

  async closeBrowser() {
    try {
      if (session?.browser) await session.browser.close();
    } finally {
      session = undefined;
      readyPromise = null;
    }
  },
};
