import fs from "node:fs";

const outPath = process.env.CLAUDE_CAPTURE_PATH;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input?.url;
  if (outPath && typeof url === "string" && url.includes("/v1/messages") && init?.body) {
    fs.writeFileSync(outPath, String(init.body));
    process.stderr.write(`[capture] wrote ${outPath}\n`);
    process.exit(0);
  }
  return originalFetch(input, init);
};
