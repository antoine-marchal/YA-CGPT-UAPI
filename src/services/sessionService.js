import path from "path";

export async function saveSession({ context, browser }) {
  const sessionPath = path.resolve(process.cwd(), "session.json");
  // Sauvegarde la session
  await context.storageState({ path: sessionPath });

  // Important : il faut fermer le contexte pour que l’état soit écrit
  await context.close();
  await browser.close();

  console.log("✅ Session sauvegardée dans", sessionPath);
}