import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("Usage: npm run migration:checksum -- <file> [file...]");
  process.exitCode = 2;
} else {
  for (const path of paths) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const info = await stat(path);
    console.log(JSON.stringify({
      path: path.replaceAll("\\", "/"),
      sha256: hash.digest("hex"),
      bytes: info.size,
    }));
  }
}
