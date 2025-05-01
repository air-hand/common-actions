async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryGraphQLRequestFunc(func, retries = 3, sleep_ms = 1000) {
    let attempts = 0;
    while (attempts < retries) {
        try {
            return await func();
        } catch (error) {
            if (attempts >= retries) {
                console.error('Max retries reached. Exiting...');
                throw error;
            }
            if (!(error instanceof GraphqlResponseError)) {
                throw error;
            }
            attempts++;
            console.log(`Retrying... (${attempts}/${retries})`);
            await sleep(sleep_ms);
        }
    }
}

module.exports = async ({github, context}) => {
    const {
        BASE_BRANCH,
        LIMITS,
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

    const autoMergeEnabledPRs = pullRequestNodes
        .filter(pr => pr.autoMergeRequest && pr.autoMergeRequest.enabledAt && pr.mergeable !== 'CONFLICTING')
        .map(pr => ({id: pr.id, url: pr.url}))
        .slice(0, limit)
    ;

    if (autoMergeEnabledPRs.length === 0) {
        console.log('No PRs to update');
        return;
    }

    console.log('Updating PRs:', autoMergeEnabledPRs.map(pr => pr.url).join('\n'));

    for (const pr of autoMergeEnabledPRs) {
        console.log(`Rebasing PR: ${pr.url}`);
        const res = await retryGraphQLRequestFunc(async() => {
            return await github.graphql(`mutation($prId: ID!) {
                updatePullRequestBranch(input: {pullRequestId: $prId, updateMethod: REBASE}) {
                    pullRequest {
                        url
                        autoMergeRequest {
                            enabledAt
                        }
                    }
                }
            }`, {prId: pr.id});
        });
        console.debug(JSON.stringify(res));
        console.log(`Rebased PR: ${pr.url}`);
    }
}