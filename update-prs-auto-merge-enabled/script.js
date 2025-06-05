async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryGraphQLRequestFunc(func, retries = 3, sleep_ms = 1000) {
    let attempts = 0;
    while (attempts < retries) {
        try {
            return await func();
        } catch (error) {
            if (error.name !== "GraphqlResponseError") {
                throw error;
            }
            attempts++;
            if (attempts >= retries) {
                console.error('Max retries reached. Exiting...');
                throw error;
            }
            console.log(`Retrying... (${attempts}/${retries})`);
            await sleep(sleep_ms * attempts);
        }
    }
}

module.exports = async ({github, context}) => {
    const {
        BASE_BRANCH,
        LIMITS,
        UPDATE_METHOD,
    } = process.env;

    const limit = (() => {
        let limit = parseInt(LIMITS, 10);
        return limit > 0 ? limit : 30;
    })();

    const query = `query($owner: String!, $repo: String!, $baseRef: String!) {
        repository(owner: $owner, name: $repo) {
            pullRequests(baseRefName: $baseRef, states: OPEN, first: 100) {
                nodes {
                    id
                    url
                    author {
                        login
                    }
                    autoMergeRequest {
                        enabledAt
                    }
                    mergeable
                }
            }
        }
    }`;

    const {repository: {pullRequests: {nodes: pullRequestNodes}}} = await github.graphql(query, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        baseRef: BASE_BRANCH,
    });

    console.debug(JSON.stringify(pullRequestNodes));

    const updateMethod = UPDATE_METHOD.toUpperCase() === 'MERGE' ? 'MERGE' : 'REBASE';
    console.log(`Update method: ${updateMethod}`);

    // Exclude bot PRs that auto-update themselves to avoid conflicts
    const excludedAuthors = ['renovate[bot]', 'dependabot[bot]'];

    const autoMergeEnabledPRs = pullRequestNodes
        .filter(pr => pr.autoMergeRequest && pr.autoMergeRequest.enabledAt && pr.mergeable !== 'CONFLICTING')
        .filter(pr => {
            const authorLogin = pr.author?.login;
            if (excludedAuthors.includes(authorLogin)) {
                console.log(`Skipping PR by ${authorLogin}: ${pr.url}`);
                return false;
            }
            return true;
        })
        .map(pr => ({id: pr.id, url: pr.url}))
        .slice(0, limit)
    ;

    if (autoMergeEnabledPRs.length === 0) {
        console.log('No PRs to update');
        return;
    }

    console.log('Updating PRs:', autoMergeEnabledPRs.map(pr => pr.url).join('\n'));

    let errors = [];

    for (const pr of autoMergeEnabledPRs) {
        console.log(`Updating PR: ${pr.url}`);
        try {
            const res = await retryGraphQLRequestFunc(async() => {
                return await github.graphql(`mutation($prId: ID!, $updateMethod: PullRequestBranchUpdateMethod!) {
                    updatePullRequestBranch(input: {pullRequestId: $prId, updateMethod: $updateMethod}) {
                        pullRequest {
                            url
                            autoMergeRequest {
                                enabledAt
                            }
                        }
                    }
                }`, {prId: pr.id, updateMethod: updateMethod});
            });
            console.debug(JSON.stringify(res));
        } catch (e) {
            errors.push(e);
            continue;
        }
        console.log(`Updated PR: ${pr.url}`);
    }

    if (errors.length !== 0) {
        throw new Error(errors.map(e=>e.message).join("\n"));
    }
}
