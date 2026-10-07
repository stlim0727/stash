// Reject mutable action references in GitHub workflows before dependencies run.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2] ?? '.github/workflows';
const failures = [];
let references = 0;
for (const name of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
  readFileSync(join(directory, name), 'utf8').split('\n').forEach((line, index) => {
    const match = line.match(/^\s*(?:-\s*)?uses:\s*(.*?)\s*(?:#.*)?$/);
    if (!match) return;
    references += 1;
    const value = match[1].replace(/^(['"])(.*)\1$/, '$2');
    const local = /^\.\/[\w./-]+$/.test(value) && !value.split('/').includes('..');
    const pinned = /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/.test(value);
    if (!local && !pinned) failures.push(`${name}:${index + 1}: action must use a full commit SHA`);
  });
}
if (!references) failures.push('No workflow action references found; check the workflow directory.');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Workflow action references pinned: ${references}`);
