import { init as listenerInit, sendMessage as listenerSendMessage, listModels as listenerListModels, switchModel as listenerSwitchModel } from "../chatgptlistener.js";
import { Mutex } from "../utils/mutex.js";

let browser, context, page, sessionFile;
let readyPromise = null;
const mutex = new Mutex();

export const playwrightService = {
  async initializeBrowser() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const s = await listenerInit({
        headless: true, // process.env.HEADLESS !== "0"
      });
      browser = s.browser;
      context = s.context;
      page = s.page;
      sessionFile = s.sessionFile;
      return s;
    })();
    return readyPromise;
  },
  async listModels() {
    await this.initializeBrowser();
    return await listenerListModels(page);
  },
  async switchModel(modelName) {
    await this.initializeBrowser();
    return await listenerSwitchModel(page, modelName);
  },
  async promptChatGPT(prompt, { onChunk, timeoutMs } = {}) {
    await this.initializeBrowser();
    const release = await mutex.acquire();
    try {
      return await listenerSendMessage(page, prompt, { onChunk, timeoutMs });
    } finally {
      release();
    }
  },
  async  saveSession() {
    // Sauvegarde la session (manual write to avoid nexe Buffer issue)
    const state = await context.storageState();
    import("fs").then(fs => {
      fs.writeFileSync(sessionFile, JSON.stringify(state, null, 2), "utf8");
    });
    console.log("✅ Session saved to", sessionFile);
  },
  async closeBrowser() {
    try {
      if (browser) await browser.close();
    } finally {
      browser = context = page = sessionFile = undefined;
      readyPromise = null;
    }
  },
  
};
