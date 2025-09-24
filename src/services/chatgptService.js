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

function ensureUploadDir() {
  const uploadDir = path.resolve("upload");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  return uploadDir;
}

// helper to extract files from a prompt payload
async function extractFilesFromPrompt(prompt) {
  prompt = JSON.parse(prompt);
  const uploadDir = ensureUploadDir();
  const filePaths = [];
  if (!prompt?.messages) return { cleanedPrompt: prompt, filePaths };
  const cleanedMessages = prompt.messages.map(msg => {
    if (!msg?.content || !Array.isArray(msg.content)) return msg;
    const newContent = msg.content.filter(part => {
      if (part.image_url?.url?.startsWith("data:")) {
        try {
          // detect mime type and extension
          const match = /^data:(.+?);base64,(.*)$/.exec(part.image_url.url);
          if (!match) return false;
          const mimeType = match[1];
          const b64data = match[2];
          const ext = mimeType.split("/")[1] || "bin";
          const filename = `file_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
          const filePath = path.join(uploadDir, filename);
          fs.writeFileSync(filePath, Buffer.from(b64data, "base64"));
          filePaths.push(filePath);
          return false; // remove this content from prompt
        } catch (e) {
          console.error("Failed to decode data URL:", e);
          return true;
        }
      }
      return true; // keep normal text or other parts
    });

    return { ...msg, content: newContent };
  });

  return { cleanedPrompt: { ...prompt, messages: cleanedMessages }, filePaths };
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

  async promptChatGPT(prompt, { onChunk, timeoutMs } = {}) {
    await this.initializeBrowser();
    const release = await mutex.acquire();
    let filePaths = []; 
    try {
      // step 1: extract files
      const { cleanedPrompt, filePaths: extracted } = await extractFilesFromPrompt(prompt);
      filePaths = extracted;
  
      // step 2: attach files if any
      if (filePaths.length > 0) {
        console.log("📎 Attaching files to chat:", filePaths);
        await listenerAttachFilesToChat(session, filePaths);
      }
  
      // step 3: send cleaned prompt
      return await listenerSendMessage(
        session,
        JSON.stringify(cleanedPrompt),
        { onChunk, timeoutMs }
      );
    } finally {
      // cleanup temporary files
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
