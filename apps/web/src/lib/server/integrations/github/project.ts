/**
 * GitHub Projects V2 custom-field reads (GraphQL).
 *
 * Projects V2 custom fields (e.g. a "Release version" single-select) are not
 * exposed by the REST issues API — only via GraphQL — and require the
 * `read:project` OAuth scope. We resolve each issue's field value directly from
 * `issue.projectItems.fieldValueByName`, so we don't need to know whether the
 * project is org- or repo-owned.
 */

const GITHUB_GRAPHQL = 'https://api.github.com/graphql'

interface GraphQLFieldValue {
  __typename?: string
  name?: string | null
  text?: string | null
}

interface GraphQLResponse {
  data?: {
    repository?: Record<
      string,
      { projectItems?: { nodes?: Array<{ fieldValueByName?: GraphQLFieldValue | null }> } } | null
    > | null
  }
  errors?: Array<{ type?: string; message?: string }>
}

export interface ReleaseVersionResult {
  /** issue number → field value (single-select name or text). */
  versions: Map<number, string>
  /** True when the token lacks `read:project` (or the project isn't readable). */
  scopeMissing: boolean
}

/**
 * Fetch a custom project field (default "Release version") for a set of issue
 * numbers in one GraphQL request (aliased per issue). Fails soft: on error it
 * returns whatever it parsed plus `scopeMissing` so the wizard still works.
 */
export async function fetchIssueReleaseVersions(
  accessToken: string,
  ownerRepo: string,
  numbers: number[],
  fieldName = 'Release version'
): Promise<ReleaseVersionResult> {
  const versions = new Map<number, string>()
  if (numbers.length === 0) return { versions, scopeMissing: false }

  const [owner, repo] = ownerRepo.split('/')
  if (!owner || !repo) return { versions, scopeMissing: false }

  // One aliased `issue(number:N)` per issue; `i<n>` are valid GraphQL aliases.
  const aliases = numbers
    .map(
      (n) =>
        `i${n}: issue(number: ${n}) { projectItems(first: 10) { nodes { ` +
        `fieldValueByName(name: ${JSON.stringify(fieldName)}) { __typename ` +
        `... on ProjectV2ItemFieldSingleSelectValue { name } ` +
        `... on ProjectV2ItemFieldTextValue { text } } } } }`
    )
    .join('\n')
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(
    repo
  )}) { ${aliases} } }`

  let response: Response
  try {
    response = await fetch(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': 'quackback',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    })
  } catch {
    return { versions, scopeMissing: false }
  }

  if (!response.ok) {
    return { versions, scopeMissing: response.status === 401 || response.status === 403 }
  }

  const json = (await response.json()) as GraphQLResponse
  const repoData = json.data?.repository
  if (repoData) {
    for (const n of numbers) {
      const node = repoData[`i${n}`]
      const value = node?.projectItems?.nodes
        ?.map((x) => x.fieldValueByName)
        .find((v): v is GraphQLFieldValue => Boolean(v && (v.name || v.text)))
      const resolved = value?.name ?? value?.text
      if (resolved) versions.set(n, String(resolved))
    }
  }

  const scopeMissing =
    !repoData &&
    (json.errors?.some((e) =>
      /scope|read:project|insufficient|not accessible|resource not/i.test(e.message ?? '')
    ) ??
      false)

  return { versions, scopeMissing }
}
