// index.js
import { firefox } from "playwright-core";
import { launchOptions } from "camoufox-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_FILE = "session.json";
const URL = "https://chatgpt.com/?temporary-chat=true";
const PROMPT = "Hello give me a simple hw snippet code in groovy";
const INJECT_PATH = path.join(__dirname, "jsinject.js");

// Replace your injectWithNonce with this version
async function injectWithNonce(page, code) {
    // 1) Read the page's CSP nonce
    const nonce = await page.evaluate(() => {
      const s = document.querySelector('script[nonce]');
      return s ? (s.nonce || s.getAttribute('nonce')) : null;
    });
  
    if (!nonce) return false;
  
    // 2) Inject the script in the main world using the SAME nonce
    await page.evaluate(({ src, n }) => {
      const s = document.createElement("script");
      s.type = "text/javascript";
      s.setAttribute("nonce", n);
      s.textContent = src + "\n//# sourceURL=jsinject_inline.js";
      (document.head || document.documentElement).appendChild(s);
      // optional: remove after execution
      // s.remove();
    }, { src: code, n: nonce }); // ✅ single arg object
  
    // 3) Verify the interceptor flag
    return await page.evaluate(() => !!window.__chatgptInterceptorLoaded);
  }
  

(async () => {
  const browser = await firefox.launch({
    ...(await launchOptions({})),
    headless: false,
  });

  const useStorage = fs.existsSync(SESSION_FILE);
  const context = await browser.newContext(
    useStorage ? { storageState: SESSION_FILE } : {}
  );

  // Read injector source
  const injectCode = fs.readFileSync(INJECT_PATH, "utf8");

  // (Optional) still try init script — helps on Chromium; harmless on FF
  try { await context.addInitScript(injectCode); } catch {}

  // Console filter: only [MESSAGE] between [START] and [DONE]
  function attachConsoleFilter(page) {
    let started = false;
    page.on("console", (msg) => {
      const t = msg.text();
      if (t.startsWith("[START]")) { started = true; return; }
      if (t.startsWith("[DONE]"))  { started = false; console.log("[DONE]"); return; }
      if (started && t.startsWith("[MESSAGE]")) {
        const out = t.replace(/^\[MESSAGE\]\s?/, "");
        if (out) console.log(out);
      }
    });
  }
  context.pages().forEach(attachConsoleFilter);
  context.on("page", attachConsoleFilter);

  const page = await context.newPage();

  // Navigate first so we can read the real document's nonce
  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // Try nonce-based injection (CSP-compliant)
  let loaded = await injectWithNonce(page, injectCode);

  // If still not loaded, try a couple of softer fallbacks (some CSPs allow these)
  if (!loaded) {
    try { await page.addScriptTag({ content: injectCode }); } catch {}
    loaded = await page.evaluate(() => !!window.__chatgptInterceptorLoaded);
  }
  if (!loaded) {
    try {
      await page.evaluate((src) => { (0, eval)(src); }, injectCode); // may be blocked by 'unsafe-eval'
    } catch {}
    loaded = await page.evaluate(() => !!window.__chatgptInterceptorLoaded);
  }

  console.log(loaded ? "Injector found" : "Injector flag not found — blocked by CSP");

  // --- Send prompt ---
  const editorPlaceholder = page.locator('p[data-placeholder="Ask anything"]').first();
  await editorPlaceholder.click({ force: true });

  const editor = page.locator('div[contenteditable="true"]').first();
  await editor.focus();
  await page.keyboard.type(PROMPT, { delay: 5 });

  const sendBtn = page.locator('#composer-submit-button');
  await sendBtn.click();

  // Persist session
  await context.storageState({ path: SESSION_FILE });
  // await browser.close();
})();
