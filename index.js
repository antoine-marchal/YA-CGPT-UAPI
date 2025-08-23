// index.js
import { firefox } from "playwright-core";
import { launchOptions } from "camoufox-js";
import fs from "fs";

const SESSION_FILE = "session.json";
const URL = "https://chatgpt.com/?temporary-chat=true";
const PROMPT = "Hello give me a simple hw snippet code in groovy";

/**
 * Injecte des hooks dans la page pour :
 *  - intercepter EventSource (SSE) et fetch(ReadableStream)
 *  - parser les "data:" par lignes JSON
 *  - console.log chaque morceau de texte streamé, immédiatement
 *
 * Les logs sortent côté Node via page.on('console') et sont préfixés:
 *   [STREAM_PIECE] ...   pour chaque bout de texte
 *   [STREAM_DONE]        à la fin d’un message
 *   [STREAM_RAW] ...     (fallback: brut si non parsable)
 */
const injectStreamHooks = `
(() => {
  const decoder = new TextDecoder();
  const STREAM_PIECE_PREFIX = "[STREAM_PIECE]";
  const STREAM_DONE = "[STREAM_DONE]";
  const STREAM_RAW_PREFIX = "[STREAM_RAW]";

  function handleDataLine(line) {
    // lignes SSE: "data: {json}" ou "data: [DONE]" etc.
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;

    if (payload === "[DONE]" || payload === "[CANCELLED]") {
      console.log(STREAM_DONE);
      return;
    }

    try {
      const obj = JSON.parse(payload);

      // 1) format "delta" (style patch)
      if (obj && obj.delta) {
        // cas: delta.v (append de texte)
        if (typeof obj.delta.v === "string" && obj.delta.o === "append") {
          console.log(STREAM_PIECE_PREFIX, obj.delta.v);
          return;
        }
        // cas: plusieurs deltas -> parcourir rapidement
        if (Array.isArray(obj.delta)) {
          for (const d of obj.delta) {
            if (typeof d.v === "string" && (d.o === "append" || !d.o)) {
              console.log(STREAM_PIECE_PREFIX, d.v);
            }
          }
          return;
        }
      }

      // 2) format message avec parts[]
      if (obj && obj.message && obj.message.content && Array.isArray(obj.message.content.parts)) {
        for (const part of obj.message.content.parts) {
          if (typeof part === "string" && part.length) {
            console.log(STREAM_PIECE_PREFIX, part);
          }
        }
        if (obj.message.status === "finished_successfully") {
          console.log(STREAM_DONE);
        }
        return;
      }

      // 3) autre: status fin
      if (obj && obj.message && obj.message.status === "finished_successfully") {
        console.log(STREAM_DONE);
        return;
      }

      // fallback: log brut si pas reconnu
      console.log(STREAM_RAW_PREFIX, payload);
    } catch {
      // pas du JSON -> log brut
      console.log(STREAM_RAW_PREFIX, payload);
    }
  }

  // ---- Hook EventSource (SSE) ----
  const _ES = window.EventSource;
  if (_ES) {
    window.EventSource = function(url, conf) {
      const es = new _ES(url, conf);
      es.addEventListener("message", (evt) => {
        // evt.data peut contenir une seule ligne JSON
        if (typeof evt.data === "string") {
          // Chaque message SSE correspond déjà à une "data:" logique
          handleDataLine("data: " + evt.data);
        }
      });
      return es;
    };
    window.EventSource.prototype = _ES.prototype;
  }

  // ---- Hook fetch streaming ----
  const _fetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await _fetch(...args);

    try {
      // Si ce n'est pas un flux, on renvoie tel quel
      if (!res.body || !res.body.getReader) return res;

      const reader = res.body.getReader();
      const stream = new ReadableStream({
        start(controller) {
          function push() {
            reader.read().then(({ done, value }) => {
              if (done) {
                controller.close();
                // Fin logique (certaines APIs envoient un event "message_stream_complete")
                // On ne force pas STREAM_DONE ici: il sera envoyé par la dernière "data:[DONE]"
                return;
              }
              // Décode le chunk, découpe par lignes, traite celles qui contiennent "data:"
              const text = decoder.decode(value, { stream: true });
              // Les flux type SSE via fetch renvoient souvent des blocs \n\n séparés
              for (const part of text.split(/\\r?\\n\\r?\\n/)) {
                for (const line of part.split(/\\r?\\n/)) {
                  if (line.startsWith("data:")) handleDataLine(line);
                }
              }
              controller.enqueue(value);
              push();
            }).catch(err => {
              try { controller.error(err); } catch {}
            });
          }
          push();
        }
      });

      // Retourne une nouvelle Response avec le flux proxy
      return new Response(stream, {
        headers: res.headers,
        status: res.status,
        statusText: res.statusText,
      });
    } catch {
      // En cas d'erreur, on rend la réponse originale
      return res;
    }
  };
})();
`;

(async () => {
  const browser = await firefox.launch({
    ...(await launchOptions({})),
    headless: false,
  });

  const useStorage = fs.existsSync(SESSION_FILE);
  const context = await browser.newContext(
    useStorage ? { storageState: SESSION_FILE } : {}
  );

  // Récupère les logs de la page (pour renvoyer les morceaux streamés en direct)
  context.pages().forEach(p => p.on("console", msg => console.log(msg.text())));
  context.on("page", p => p.on("console", msg => console.log(msg.text())));

  const page = await context.newPage();

  // Important: injecter les hooks AVANT que le site charge ses scripts qui ouvrent la connexion
  await page.addInitScript(injectStreamHooks);

  await page.goto(URL, { waitUntil: "domcontentloaded" });

  // --- Saisie du prompt ---
  // Le placeholder est dans un <p data-placeholder="Ask anything">; la zone éditable est un ancêtre contenteditable
  const editorPlaceholder = page.locator('p[data-placeholder="Ask anything"]').first();

  // Certains builds masquent le <p>, on clique quand même pour focus l’éditeur
  await editorPlaceholder.click({ force: true });

  // Si besoin, focuser explicitement le contenteditable
  // (on prend le premier éditeur visible)
  const editor = page.locator('div[contenteditable="true"]').first();
  await editor.focus();

  // Tape le prompt
  await page.keyboard.type(PROMPT, { delay: 5 });

  // --- Envoi (clic bouton) ---
  const sendBtn = page.locator('#composer-submit-button');
  await sendBtn.click();

  // À partir d’ici, les hooks vont logger des lignes comme :
  //   [STREAM_PIECE] <texte incrémental>
  //   [STREAM_DONE]
  // au fur et à mesure de l’arrivée du flux.

  // Optionnel: on attend la fin du flux (détecter [STREAM_DONE] depuis Node)
  let done = false;
  const off = page.on("console", (msg) => {
    const t = msg.text();
    if (t === "[STREAM_DONE]") {
      done = true;
    }
  });

  // Time-out de sécurité au cas où
  const TIMEOUT_MS = 120000;
  const start = Date.now();
  while (!done && Date.now() - start < TIMEOUT_MS) {
    await page.waitForTimeout(250);
  }
  page.off("console", off);

  // Sauvegarde la session mise à jour (cookies/localStorage)
  await context.storageState({ path: SESSION_FILE });

  // Optionnel: ferme
  // await browser.close();
})();
