export async function copyToClipboard(attachment) {
  try {
    if (!attachment) {
      throw new Error("No attachment provided");
    }

    const { data, mime } = attachment;

    // Text case
    if (typeof data === "string" && (!mime || mime.startsWith("text/"))) {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(data);
      } else {
        const clipboardy = await import("clipboardy");
        await clipboardy.default.write(data);
      }
      return;
    }

    // Binary base64 case
    if (typeof data === "string") {
      const binary = Uint8Array.from(atob(data), c => c.charCodeAt(0));

      if (typeof window !== "undefined" && window.navigator?.clipboard?.write) {
        const blob = new Blob([binary.buffer], { type: mime || "application/octet-stream" });
        const item = new ClipboardItem({ [blob.type]: blob });
        await navigator.clipboard.write([item]);
      } else {
        const clipboardy = await import("clipboardy");
        await clipboardy.default.write(binary.toString("base64"));
      }
      return;
    }

    throw new Error("Unsupported attachment format");
  } catch (err) {
    console.error("copyToClipboard error:", err);
    throw err;
  }
}