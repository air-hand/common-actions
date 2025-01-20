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
        .filter(pr => pr.autoMergeRequest && pr.autoMergeRequest.enabledAt && pr.mergeable === 'MERGEABLE')
        .map(pr => ({id: pr.id, url: pr.url}))
        .slice(0, limit)
    ;

    if (autoMergeEnabledPRs.length === 0) {
        console.log('No PRs to update');
        return;
    }

    console.log('Updating PRs:', autoMergeEnabledPRs.map(pr => pr.url).join('\n'));

    if (!context.payload.pull_request?.merged) {
        console.warn('This action should only be run after a PR is merged');
        return;
    }

    for (const pr of autoMergeEnabledPRs) {
        console.log(`Rebasing PR: ${pr.url}`);
        const res = await github.graphql(`mutation($prId: ID!) {
            updatePullRequestBranch(input: {pullRequestId: $prId, updateMethod: REBASE}) {
                pullRequest {
                    url
                    autoMergeRequest {
                        enabledAt
                    }
                }
            }
        }`, {prId: pr.id});
        console.debug(JSON.stringify(res));
        console.log(`Rebased PR: ${pr.url}`);
    }
}