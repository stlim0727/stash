const command = process.argv[2];

const messages = {
  test: "No automated tests exist yet. This placeholder keeps root checks green until tests are added alongside app features."
};

if (!messages[command]) {
  console.error(`Unknown placeholder command: ${command ?? "<missing>"}`);
  process.exit(1);
}

console.log(messages[command]);
