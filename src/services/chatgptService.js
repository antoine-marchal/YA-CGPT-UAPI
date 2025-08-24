import { init as listenerInit, sendMessage as listenerSendMessage } from "../chatgptlistener.js";
import { Mutex } from "../utils/mutex.js";

let browser, context, page, sessionFile;
let readyPromise = null;
const mutex = new Mutex();

export const playwrightService = {
  async initializeBrowser() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const s = await listenerInit({
        headless: false, // process.env.HEADLESS !== "0"
      });
      browser = s.browser;
      context = s.context;
      page = s.page;
      sessionFile = s.sessionFile;
      return s;
    })();
    return readyPromise;
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
    // Sauvegarde la session
    await context.storageState({ path: sessionFile });
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
