import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const mode = process.argv[2];
const shouldWrite = mode === "--write";
const shouldCheck = mode === "--check";

if (!shouldWrite && !shouldCheck) {
  console.error("Usage: node scripts/format.mjs --check|--write");
  process.exit(1);
}

const { stdout } = await execFileAsync("git", [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
  "*.md",
  "*.json",
  "*.yaml",
  "*.yml",
  "*.mjs",
  "*.js",
  "*.ts",
  "*.tsx"
]);

const files = stdout.split("\n").filter(Boolean);
const changed = [];

for (const file of files) {
  let original;
  try {
    original = await readFile(file, "utf8");
  } catch {
    // Tracked but deleted from the working tree (e.g. unstaged deletion).
    continue;
  }
  const formatted = original
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n*$/, "\n");

  if (formatted !== original) {
    changed.push(file);
    if (shouldWrite) {
      await writeFile(file, formatted);
    }
  }
}

if (changed.length > 0 && shouldCheck) {
  console.error("Formatting check failed for:");
  for (const file of changed) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

if (changed.length > 0) {
  console.log(`Formatted ${changed.length} file(s).`);
} else {
  console.log("Formatting check passed.");
}
