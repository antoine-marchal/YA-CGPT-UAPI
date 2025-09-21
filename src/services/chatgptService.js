import {
  init as listenerInit,
  sendMessage as listenerSendMessage,
  listModels as listenerListModels,
  switchModel as listenerSwitchModel,
} from "../chatgptlistener.js";
import { Mutex } from "../utils/mutex.js";
import { executeFunction } from "../utils/functionExecutor.js";

let session;  // store the full session
let readyPromise = null;
const mutex = new Mutex();

export const playwrightService = {
  async initializeBrowser() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      session = await listenerInit({
        headless: true, // or process.env.HEADLESS !== "0"
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
    try {
      return await listenerSendMessage(session, prompt, {
        onChunk: async (chunk) => {
          if (chunk.type === "function") {
            try {
              const result = await executeFunction(
                chunk.name,
                chunk.arguments
              );
              if (onChunk) {
                onChunk({
                  type: "function_result",
                  name: chunk.name,
                  result,
                });
              }
            } catch (err) {
              if (onChunk) {
                onChunk({
                  type: "function_error",
                  name: chunk.name,
                  error: err.message,
                });
              }
            }
          } else if (chunk.type === "attachment") {
            if (onChunk) {
              onChunk({
                type: "attachment",
                name: chunk.name,
                mime: chunk.mime,
                data: chunk.data,
              });
            }
          } else {
            if (onChunk) onChunk(chunk);
          }
        },
        timeoutMs,
      });
    } finally {
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
