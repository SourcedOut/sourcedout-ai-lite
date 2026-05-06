import { createServerFn } from "@tanstack/react-start";
import { buildExtensionZip } from "./extension-zip.server";

export const getExtensionZipBase64 = createServerFn({ method: "GET" }).handler(
  async () => {
    const bytes = await buildExtensionZip();
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { base64: btoa(binary) };
  },
);
