const command = process.argv[2];

const messages = {
  dev: "No runnable app exists yet. Milestone 1 will add the Expo mobile scaffold under apps/mobile.",
  test: "No automated tests exist yet. This placeholder keeps Milestone 0 checks green until app code is added.",
  typecheck: "No TypeScript project exists yet. Milestone 1 will add the first TypeScript app configuration."
};

if (!messages[command]) {
  console.error(`Unknown placeholder command: ${command ?? "<missing>"}`);
  process.exit(1);
}

console.log(messages[command]);
