export const ITEM_IDENTIFIER_QUERY = `
  query GitHubItemIdentifier($itemId: ID!) {
    node(id: $itemId) {
      __typename
      ... on Issue {
        id
        url
      }
      ... on PullRequest {
        id
        url
      }
    }
  }
`;
