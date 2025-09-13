import { firefox } from "playwright-core";
import { launchOptions } from "camoufox-js";
import fs from "fs";
import readline from "readline";
import path from "path";

const SESSION_FILE = path.resolve(process.cwd(), "session.json");
const HAR_FILE = path.resolve(process.cwd(), "network.har");

const browser = await firefox.launch({
  ...(await launchOptions({})),
  headless: false,
});

const context = await browser.newContext({
  ...(fs.existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {})
});

const page = await context.newPage();
await page.goto("https://chatgpt.com/?temporary-chat=true");
function waitForEnter(prompt = "➡️  Appuie sur Entrée pour sauvegarder et fermer...") {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${prompt}\n`, () => {
        rl.close();
        resolve();
      });
    });
  }

async function saveAll({ context, browser }) {
// Sauvegarde la session
await context.storageState({ path: SESSION_FILE });

// Important : il faut fermer le contexte pour que le HAR soit écrit
await context.close();
await browser.close();

console.log("✅ Session sauvegardée dans", SESSION_FILE);
}
// Gestion Ctrl+C → on sauvegarde proprement
let saving = false;
const onSigint = async () => {
  if (saving) return;
  saving = true;
  console.log("\n⏳ Ctrl+C détecté — sauvegarde en cours…");
  await saveAll({ context, browser });
  process.exit(0);
};
process.on("SIGINT", onSigint);

// Attends l’appui sur Entrée
await waitForEnter();

// Sauvegarde finale
process.off("SIGINT", onSigint);
await saveAll({ context, browser });