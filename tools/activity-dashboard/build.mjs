import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot } from "./model.mjs";

const directory = dirname(fileURLToPath(import.meta.url));

export async function fetchIssues(repository, token, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected owner/repository");
  if (!token) throw new Error("GH_TOKEN or GITHUB_TOKEN is required");
  const [owner, name] = repository.split("/");
  const issues = [];
  let after = null;
  const cursors = new Set();
  do {
    const response = await request("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "job-hunt-activity-dashboard",
      },
      body: JSON.stringify({
        query: `query($owner:String!,$name:String!,$after:String) {
          repository(owner:$owner,name:$name) {
            issues(first:100,after:$after,orderBy:{field:CREATED_AT,direction:ASC}) {
              nodes {
                number title state stateReason closedAt
                parent { number }
                labels(first:100) { nodes { name } pageInfo { hasNextPage } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        variables: { owner, name, after },
      }),
    });
    if (!response.ok) throw new Error(`GitHub request failed: HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(`GitHub GraphQL: ${payload.errors.map(e => e.message).join("; ")}`);
    const page = payload.data?.repository?.issues;
    if (!Array.isArray(page?.nodes) || typeof page.pageInfo?.hasNextPage !== "boolean") {
      throw new Error("GitHub returned no valid issue page");
    }
    if (page.nodes.some(issue => issue.labels?.pageInfo?.hasNextPage)) {
      throw new Error("Issue labels were truncated; refusing an incomplete goal selection");
    }
    issues.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new Error("Invalid GitHub pagination cursor");
    cursors.add(after);
  } while (true);
  return issues;
}

export async function build({ repository, token, output, request = fetch }) {
  const snapshot = buildSnapshot(await fetchIssues(repository, token, request));
  if (snapshot.goals.length === 0) throw new Error("No goal-labelled issues found");
  await mkdir(output, { recursive: true });
  for (const file of ["index.html", "styles.css", "app.mjs", "model.mjs"]) {
    await copyFile(join(directory, file), join(output, file));
  }
  await writeFile(join(output, "activity.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(join(output, ".nojekyll"), "");
  console.log(`Built aggregate activity for ${snapshot.goals.length} goals in ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await build({
      repository: process.env.GITHUB_REPOSITORY || "ihorton1/job-search",
      token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
      output: resolve(process.argv[2] || join(directory, "dist")),
    });
  } catch (error) {
    console.error(`Dashboard build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
