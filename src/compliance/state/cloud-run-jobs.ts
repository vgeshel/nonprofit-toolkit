/**
 * A `LaunchDiscovery` implementation that triggers a Cloud Run **Job**
 * execution via the Cloud Run Admin v2 REST API
 * (`run.googleapis.com/v2/projects/{p}/locations/{r}/jobs/{job}:run`),
 * passing the job id + source filter to the execution as container env
 * overrides.
 *
 * This mirrors the pattern `infra/provision.sh` already uses for the ETL
 * job (Cloud Scheduler POSTs the same `:run` endpoint with container
 * overrides), and needs no extra dependency — `google-auth-library`
 * (already a direct dependency) mints the access token. The triggered Job
 * runs `runDiscoveryAndPersist` in its own process and reports its terminal
 * status to Firestore, independent of the MCP request that launched it.
 */
import { GoogleAuth } from 'google-auth-library'
import { ResultAsync } from 'neverthrow'
import { z } from 'zod'
import type {
  DiscoveryJobFilter,
  LaunchDiscovery,
  LaunchDiscoveryError,
} from '../skills/discover-job.ts'

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/**
 * The minimal `fetch` surface this launcher uses. Narrower than the global
 * `typeof fetch` (no `preconnect`), so the real global `fetch` and simple
 * test doubles both satisfy it. Injectable so tests don't make real network
 * calls.
 */
export type FetchLike = (
  input: string,
  init: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: string
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

/**
 * Mint an OAuth access token for the Cloud Run Admin API. Injectable so
 * tests don't touch application-default credentials.
 */
export type GetAccessToken = () => Promise<string>

/**
 * Default token source: application-default credentials via
 * `google-auth-library`, scoped to the Cloud Platform API.
 */
export const defaultGetAccessToken: GetAccessToken = () => {
  const auth = new GoogleAuth({ scopes: CLOUD_PLATFORM_SCOPE })
  return auth
    .getAccessToken()
    .then((token) =>
      typeof token === 'string' && token.length > 0
        ? token
        : Promise.reject(
            new Error('GoogleAuth.getAccessToken() returned an empty token'),
          ),
    )
}

/**
 * Args for `createCloudRunJobLauncher`.
 */
export interface CloudRunJobLauncherArgs {
  readonly projectId: string
  readonly region: string
  readonly jobName: string
  readonly fetch?: FetchLike
  readonly getAccessToken?: GetAccessToken
}

/**
 * The `:run` response is a long-running `Operation`. We don't consume any
 * field, but per the external-data rule we still confirm it parses as a
 * JSON object before treating the launch as accepted.
 */
const RunOperationResponseSchema = z.object({ name: z.string().optional() })

/**
 * Build the container env overrides that carry the job id + filter to the
 * Cloud Run Job execution. The Job's entrypoint reads these back via
 * `parseDiscoverJobEnv`.
 */
export function buildDiscoveryEnvOverrides(
  jobId: string,
  filter: DiscoveryJobFilter,
): readonly { readonly name: string; readonly value: string }[] {
  const env: { name: string; value: string }[] = [
    { name: 'DISCOVERY_JOB_ID', value: jobId },
  ]
  if (filter.sources !== null && filter.sources.length > 0) {
    env.push({ name: 'DISCOVERY_SOURCES', value: filter.sources.join(',') })
  }
  if (filter.jurisdictionId !== null) {
    env.push({
      name: 'DISCOVERY_JURISDICTION_ID',
      value: filter.jurisdictionId,
    })
  }
  return env
}

/**
 * POST the `:run` request. Throws on any failure; the caller wraps this in
 * a `ResultAsync` so every failure surfaces as a `launch` error.
 */
async function triggerExecution(
  doFetch: FetchLike,
  getToken: GetAccessToken,
  url: string,
  jobId: string,
  filter: DiscoveryJobFilter,
): Promise<void> {
  const token = await getToken()
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      overrides: {
        containerOverrides: [
          { env: buildDiscoveryEnvOverrides(jobId, filter) },
        ],
      },
    }),
  })
  const text = await response.text()
  if (!response.ok) {
    return Promise.reject(
      new Error(
        `Cloud Run jobs:run returned ${String(response.status)}: ${text}`,
      ),
    )
  }
  RunOperationResponseSchema.parse(JSON.parse(text))
}

/**
 * Build a launcher that triggers a Cloud Run Job execution. The returned
 * `LaunchDiscovery` resolves once the execution is *accepted* by the API.
 */
export function createCloudRunJobLauncher(
  args: CloudRunJobLauncherArgs,
): LaunchDiscovery {
  const doFetch = args.fetch ?? fetch
  const getToken = args.getAccessToken ?? defaultGetAccessToken
  const url = `https://run.googleapis.com/v2/projects/${args.projectId}/locations/${args.region}/jobs/${args.jobName}:run`

  return ({ jobId, filter }) =>
    ResultAsync.fromPromise(
      triggerExecution(doFetch, getToken, url, jobId, filter),
      (e): LaunchDiscoveryError => ({
        type: 'launch',
        message: e instanceof Error ? e.message : String(e),
      }),
    )
}
