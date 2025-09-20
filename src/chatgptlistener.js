import { firefox } from "playwright-core";
import { launchOptions } from "camoufox-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const SESSION_FILE = "session.json";
const URL = "https://chatgpt.com/?model=gpt-4-1&temporary-chat=true"; //&model=gpt-5-instant"; //or gpt-5-t-mini or gpt-5-thinking or gpt-5
const INJECT_PATH = path.join(__dirname, "jsinject.js");

// --- Helpers ---
async function injectWithNonce(page, code) {
  const nonce = await page.evaluate(() => {
    const s = document.querySelector("script[nonce]");
    return s ? (s.nonce || s.getAttribute("nonce")) : null;
  });
  if (!nonce) return false;

  await page.evaluate(({ src, n }) => {
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.setAttribute("nonce", n);
    s.textContent = src + "\n//# sourceURL=jsinject_inline.js";
    (document.head || document.documentElement).appendChild(s);
  }, { src: code, n: nonce });

  return await page.evaluate(() => !!window.__chatgptInterceptorLoaded);
}

async function injectMainWorld(page, code) {
  // Prefer CSP nonce path
  let ok = await injectWithNonce(page, code);
  if (ok) return true;

  // Fallbacks (may be blocked by CSP)
  try { await page.addScriptTag({ content: code }); } catch {}
  ok = await page.evaluate(() => !!window.__chatgptInterceptorLoaded);
  if (ok) return true;

  try { await page.evaluate((src) => { (0, eval)(src); }, code); } catch {}
  ok = await page.evaluate(() => !!window.__chatgptInterceptorLoaded);
  return ok;
}

async function ensureEditor(page) {
  const placeholder = page.locator('p[data-placeholder="Ask anything"]').first();
  await placeholder.click({ force: true });
  const editor = page.locator('div[contenteditable="true"]').first();
  await editor.focus();
  return editor;
}

function waitForStreamOnce(page, { onChunk, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let acc = "";
    let done = false;

    function onConsole(msg) {
      const t = msg.text();
      //console.log(t);
      if (t.startsWith("[MESSAGE]")) {
        const payload = JSON.parse(t.replace(/^\[MESSAGE\]\s?/, ""));
        if (onChunk) onChunk({ type: "message", ...payload });
        acc += payload.content || "";
      }
      else if (t.startsWith("[FUNCTION")) {
        const payload = JSON.parse(t.replace(/^\[FUNCTION.*?\]\s?/, ""));
        if (onChunk) onChunk({ type: "function", ...payload });
      }
      else if (t.startsWith("[DONE]")) {
        done = true;
        page.off("console", onConsole);
        resolve({ text: acc });
      }
    }

    page.on("console", onConsole);
  });
}


// --- Public API ---
export async function init({
  headless = false,
  url = URL,
  sessionFile = SESSION_FILE,
  injectPath = INJECT_PATH,
} = {}) {
  const userDataDir = path.resolve(process.cwd(), "userdata");
  let storageState;
  if (fs.existsSync(sessionFile)) {
    try {
      const raw = fs.readFileSync(sessionFile, "utf8");
      storageState = JSON.parse(raw);
    } catch (e) {
      console.warn("⚠️ Failed to parse session file, starting fresh:", e);
    }
  }
  const context = await firefox.launchPersistentContext(userDataDir, {
    ...(await launchOptions({})),
    headless,
    storageState,
  });
  const browser = context.browser();
 
  const page = await context.newPage();
  const injectBuf = fs.readFileSync(injectPath);
  const injectCode = injectBuf.toString("utf8");
 
  // (Optional) useful on Chromium; harmless on FF
  try { await context.addInitScript(injectCode); } catch {}
 
  await page.goto(url, { waitUntil: "domcontentloaded" });
 
  const injected = await injectMainWorld(page, injectCode);
  console.log(injected ? "Injector found" : "Injector flag not found — likely CSP");

  return { browser, context, page, injected, sessionFile };
}
// Put this near your other helpers
const CMD = process.platform === "darwin" ? "Meta" : "Control";

async function getEditorText(page) {
  const editor = page.locator('div[contenteditable="true"]').first();
  return (await editor.evaluate(el => (el.innerText || "").replace(/\r/g, "")));
}

async function clearEditor(page) {
  await page.keyboard.down(CMD);
  await page.keyboard.press("KeyA");
  await page.keyboard.up(CMD);
  await page.keyboard.press("Backspace");
}

async function pasteIntoEditor(page, text) {
  const editor = await ensureEditor(page);

  // Fast path: directly set content with evaluate
  await page.evaluate((t) => {
    const editor = document.querySelector('div[contenteditable="true"]');
    if (!editor) return;
    // Replace with plain text preserving newlines
    editor.innerHTML = "";
    const lines = t.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) editor.appendChild(document.createElement("br"));
      editor.appendChild(document.createTextNode(lines[i]));
    }

    // Dispatch input events so React notices
    editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
  }, text);
}



async function waitSendEnabled(page, timeout = 8000) {
  // Poll until the button is actually enabled (no disabled/aria-disabled)
  await page.waitForFunction(() => {
    const btn = document.getElementById("composer-submit-button");
    if (!btn) return false;
    const disabled = btn.disabled || btn.getAttribute("aria-disabled") === "true";
    const style = btn.ownerDocument.defaultView.getComputedStyle(btn);
    const visible = style.visibility !== "hidden" && style.display !== "none" && style.pointerEvents !== "none";
    return visible && !disabled;
  }, { timeout });
}

async function submitPrompt(page) {
  const editor = page.locator('div[contenteditable="true"]').first();
  await editor.focus();

  // 1) Try the official button if it's enabled
  const sendBtn = page.locator('#composer-submit-button');
  try {
    await waitSendEnabled(page, 5000);
    await sendBtn.click({ timeout: 3000 });
    return;
  } catch { /* fall through */ }

  // 2) Fallback: press Enter in editor (ChatGPT sends on Enter)
  try {
    await editor.focus();
    await page.keyboard.press("Enter");
    return;
  } catch { /* fall through */ }

  // 3) Last resort: force click (in case of overlay but React is ready)
  try {
    await sendBtn.click({ force: true, timeout: 2000 });
  } catch { /* swallow; stream will time out if it really failed */ }
}

export async function listModels(page) {
  const dropdown = page.locator('button[data-testid="model-switcher-dropdown-button"]');
  const box = await dropdown.last().boundingBox();
  if (!box) throw new Error("Dropdown not visible");

  // Move the mouse and click
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const items = page.locator(
    'div[role="menuitem"].__menu-item[tabindex="0"]:not([aria-disabled="true"])'
  );
  const testIds = await items.evaluateAll(els =>
    els.map(el => el.getAttribute("data-testid"))
  );
  await page.mouse.click(box.x + box.width * 2, box.y + box.height / 2);
  return testIds.filter(Boolean);
}

export async function switchModel(page, modelName) {
  const dropdown = page.locator('button[data-testid="model-switcher-dropdown-button"]');
  const box = await dropdown.last().boundingBox();
  if (!box) throw new Error("Dropdown not visible");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  const item = page.locator(
    `div[role="menuitem"].__menu-item[tabindex="0"][data-testid*="${modelName}"]:not([aria-disabled="true"])`
  );
  const itemBox = await item.first().boundingBox();
  if (!itemBox) throw new Error(`Model ${modelName} not found`);

  await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
  await page.mouse.click(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);

  return true;
}


export async function sendMessage(session, text, { onChunk, timeoutMs } = {}) {
  let { context, page, sessionFile, browser } = session;

  await ensureEditor(page);
  const streamPromise = waitForStreamOnce(page, { onChunk, timeoutMs });

  await pasteIntoEditor(page, text);
  await submitPrompt(page);

  const { text: fullText } = await streamPromise;

// close old context
try {
  await context.storageState({ path: sessionFile });
  await context.close();
} catch (e) {
  console.warn("Error closing context:", e);
}

// 🔄 recreate a new persistent context instead of newContext
const userDataDir = path.resolve(process.cwd(), "userdata");
const freshContext = await firefox.launchPersistentContext(userDataDir, {
  ...(await launchOptions({})),
  headless: true,
  storageState: fs.existsSync(sessionFile)
    ? JSON.parse(fs.readFileSync(sessionFile, "utf8"))
    : undefined,
});
const freshPage = await freshContext.newPage();


  // reinject js
  const injectBuf = fs.readFileSync(INJECT_PATH);
  const injectCode = injectBuf.toString("utf8");
  try { await freshContext.addInitScript(injectCode); } catch {}
  await freshPage.goto(URL, { waitUntil: "domcontentloaded" });
  const reinjected = await injectMainWorld(freshPage, injectCode);

  // 🔄 mutate the original session object
  session.context = freshContext;
  session.page = freshPage;
  session.browser = freshContext.browser(); // keep updated
  session.injected = reinjected;

  return fullText;
}

// --- Execute test when run directly ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      await testFlow();
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}
