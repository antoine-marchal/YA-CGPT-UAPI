export async function saveSession({ context, browser, path }) {
  // Sauvegarde la session
  await context.storageState({ path });

  // Important : il faut fermer le contexte pour que l’état soit écrit
  await context.close();
  await browser.close();

  console.log("✅ Session sauvegardée dans", path);
}