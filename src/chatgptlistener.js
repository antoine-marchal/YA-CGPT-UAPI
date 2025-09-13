import { firefox } from "playwright-core";
import { launchOptions } from "camoufox-js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const SESSION_FILE = "session.json";
const URL = "https://chatgpt.com/?temporary-chat=true&model=gpt-5-instant"; //or gpt-5-t-mini or gpt-5-thinking or gpt-5
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
    let started = false;
    let acc = "";
    let done = false;
/**
    const timer = setTimeout(() => {
      if (!done) {
        page.off("console", onConsole);
        reject(new Error("Stream timeout"));
      }
    }, timeoutMs);
 */
    function onConsole(msg) {
      const t = msg.text();
      
      if (t.startsWith("[START]")) {
        started = true;
        return;
      }
      if (!started) return;

      if (t.startsWith("[MESSAGE]")) {
        const out = t.replace(/^\[MESSAGE\]\s?/, "");
        acc += out;
        if (onChunk && out) onChunk(out);
        return;
      }
      if (t.startsWith("[DONE]")) {
        done = true;
        //clearTimeout(timer);
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
  await clearEditor(page);

  // 1) Try real clipboard paste (fires paste handlers)
  try {
    const origin = new URL(page.url()).origin;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await page.evaluate(async (t) => { await navigator.clipboard.writeText(t); }, text);
    await editor.focus();
    await page.keyboard.press(`${CMD}+V`);

    // verify newlines if any were requested
    if (!text.includes("\n")) return; // single-line, we’re good
    const pasted = await getEditorText(page);
    if (pasted.includes("\n")) return; // newlines preserved, done
    // else fall through to the robust fallback
  } catch (_) {
    // ignore and fall back
  }

  // 2) Robust fallback: insert line-by-line with Shift+Enter between lines
  await clearEditor(page);
  await editor.focus();

  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const part = lines[i];
    if (part) await page.keyboard.insertText(part);
    if (i < lines.length - 1) {
      await page.keyboard.down("Shift");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Shift");
    }
  }
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

export async function sendMessage(page, text, { onChunk, timeoutMs } = {}) {
  await ensureEditor(page);

  // Start listening BEFORE submit to catch [START]
  const streamPromise = waitForStreamOnce(page, { onChunk, timeoutMs });

  // Paste the content (handles newlines with Shift+Enter fallback)
  await pasteIntoEditor(page, text);

  // Submit (robust: enabled click → Enter → force click)
  await submitPrompt(page);

  // Wait for completion
  const { text: fullText } = await streamPromise;
  return fullText;
}




export async function testFlow() {
  const { browser, context, page, sessionFile } = await init({ headless: true });

  const first = await sendMessage(page, "Hello give me a simple hw snippet code in groovy", {
    onChunk: (t) => process.stdout.write(t),
  });
  console.log("\n--- FIRST DONE ---\n");

  const second = await sendMessage(page, "Now show a class-based version too", {
    onChunk: (t) => process.stdout.write(t),
  });
  console.log("\n--- SECOND DONE ---\n");

  await context.storageState({ path: sessionFile });
  await browser.close();

  return { first, second };
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
