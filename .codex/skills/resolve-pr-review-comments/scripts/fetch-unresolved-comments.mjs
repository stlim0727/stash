import { spawnSync } from 'node:child_process';

const OWNER = 'stlim0727';
const REPO = 'stash';

function runGhGql(query) {
  const result = spawnSync('gh', ['api', 'graphql', '-f', `query=${query}`], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`gh api graphql failed: ${result.stderr}`);
  }
  return JSON.parse(result.stdout);
}

function printPrThreads(pr) {
  const unresolvedThreads = pr.reviewThreads.nodes.filter(t => !t.isResolved);
  if (unresolvedThreads.length === 0) {
    return false;
  }

  console.log(`\n=== PR #${pr.number}: ${pr.title} (State: ${pr.state || 'UNKNOWN'}) ===`);
  for (const thread of unresolvedThreads) {
    console.log(`Thread ID: ${thread.id} (Outdated: ${thread.isOutdated})`);
    for (const comment of thread.comments.nodes) {
      console.log(`  [Comment ID: ${comment.databaseId}] [${comment.author?.login || 'ghost'} at ${comment.createdAt} on ${comment.path}:${comment.line}]:`);
      console.log(`    ${comment.body.replace(/\n/g, '\n    ')}`);
    }
  }
  return true;
}

function main() {
  const args = process.argv.slice(2);
  const targetPr = args[0] ? parseInt(args[0], 10) : null;

  if (targetPr) {
    console.log(`Scanning review threads on PR #${targetPr}...`);
    const query = `
      query {
        repository(owner: "${OWNER}", name: "${REPO}") {
          pullRequest(number: ${targetPr}) {
            number
            title
            state
            reviewThreads(first: 50) {
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 50) {
                  nodes {
                    id
                    databaseId
                    path
                    line
                    body
                    author {
                      login
                    }
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    `;
    try {
      const data = runGhGql(query);
      const pr = data.data.repository.pullRequest;
      if (!pr) {
        console.error(`PR #${targetPr} not found.`);
        return;
      }
      const hasUnresolved = printPrThreads(pr);
      if (!hasUnresolved) {
        console.log(`No unresolved review comments found on PR #${targetPr}.`);
      }
    } catch (e) {
      console.error('Error fetching PR review comments:', e.message);
    }
    return;
  }

  // Scan both open and recently closed PRs
  console.log('Scanning active open PRs and recently closed PRs...');
  const query = `
    query {
      repository(owner: "${OWNER}", name: "${REPO}") {
        openPrs: pullRequests(states: [OPEN], last: 30) {
          nodes {
            number
            title
            state
            reviewThreads(first: 50) {
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 50) {
                  nodes {
                    id
                    databaseId
                    path
                    line
                    body
                    author {
                      login
                    }
                    createdAt
                  }
                }
              }
            }
          }
        }
        closedPrs: pullRequests(states: [CLOSED, MERGED], last: 30) {
          nodes {
            number
            title
            state
            closedAt
            reviewThreads(first: 50) {
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 50) {
                  nodes {
                    id
                    databaseId
                    path
                    line
                    body
                    author {
                      login
                    }
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = runGhGql(query);
    const openPrs = data.data.repository.openPrs.nodes;
    const closedPrs = data.data.repository.closedPrs.nodes;
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    let foundUnresolved = false;

    // Scan open PRs
    for (const pr of openPrs) {
      if (printPrThreads(pr)) {
        foundUnresolved = true;
      }
    }

    // Scan recently closed/merged PRs
    for (const pr of closedPrs) {
      const closedAt = new Date(pr.closedAt);
      if (closedAt < twentyFourHoursAgo) {
        continue;
      }
      if (printPrThreads(pr)) {
        foundUnresolved = true;
      }
    }

    if (!foundUnresolved) {
      console.log('No unresolved review comments found on open or recently closed PRs.');
    }
  } catch (e) {
    console.error('Error fetching unresolved comments:', e.message);
  }
}

main();
