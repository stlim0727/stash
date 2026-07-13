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

function main() {
  const query = `
    query {
      repository(owner: "${OWNER}", name: "${REPO}") {
        pullRequests(states: [CLOSED, MERGED], last: 50) {
          nodes {
            number
            title
            closedAt
            reviewThreads(first: 50) {
              nodes {
                id
                isResolved
                isOutdated
                comments(first: 50) {
                  nodes {
                    id
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
    const prs = data.data.repository.pullRequests.nodes;
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    console.log(`Scanning closed/merged PRs since ${twentyFourHoursAgo.toISOString()}...`);
    let foundUnresolved = false;

    for (const pr of prs) {
      const closedAt = new Date(pr.closedAt);
      if (closedAt < twentyFourHoursAgo) {
        continue;
      }

      const unresolvedThreads = pr.reviewThreads.nodes.filter(t => !t.isResolved);
      if (unresolvedThreads.length === 0) {
        continue;
      }

      foundUnresolved = true;
      console.log(`\n=== PR #${pr.number}: ${pr.title} (Closed: ${pr.closedAt}) ===`);

      for (const thread of unresolvedThreads) {
        console.log(`Thread ID: ${thread.id} (Outdated: ${thread.isOutdated})`);
        for (const comment of thread.comments.nodes) {
          console.log(`  [${comment.author?.login || 'ghost'} at ${comment.createdAt} on ${comment.path}:${comment.line}]:`);
          console.log(`    ${comment.body.replace(/\n/g, '\n    ')}`);
        }
      }
    }

    if (!foundUnresolved) {
      console.log('No unresolved review comments found on PRs closed in the last 24 hours.');
    }
  } catch (e) {
    console.error('Error fetching unresolved comments:', e.message);
  }
}

main();
