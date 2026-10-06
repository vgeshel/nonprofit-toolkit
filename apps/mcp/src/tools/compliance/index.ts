/**
 * Registration entry point for the compliance MCP surface.
 *
 * The MCP server's `createMcpServerInstance` calls
 * `registerComplianceSurface(mcp, deps)` once per server-instance to
 * attach the tools, resources, and prompts described in
 * `docs/compliance-mcp/PLAN.md`.
 *
 * Per the plan, this commit ships the read surface only:
 *   - Tool:  compliance-status
 *   - Resources: compliance://status,
 *                compliance://sources/registry,
 *                compliance://onboarding/interview-questions,
 *                compliance://sources/{sourceId}/manual-evidence-instructions
 *
 * Write tools (onboard, onboard-update, discover-start/-status/-result,
 * record-evidence) attach in later commits.
 *
 * The callbacks are exported individually so they can be tested without
 * driving a real MCP transport.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js'
import type {
  CallToolResult,
  ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from 'pino'
import { z } from 'zod'
import type { FirestoreClientLike } from '../../../../../src/compliance/state/firestore-jobs.ts'
import type { Config } from '../../config'
import {
  DiscoverStartInputSchema,
  handleComplianceDiscoverResult,
  handleComplianceDiscoverStart,
  handleComplianceDiscoverStatus,
  type DiscoverResultError,
  type DiscoverResultRunner,
  type DiscoverStartError,
  type DiscoverStartRunner,
  type DiscoverStatusError,
  type DiscoverStatusRunner,
} from './discover'
import {
  ConfirmSchema,
  OnboardingAnswersInputSchema,
  PartialOnboardingAnswersInputSchema,
  handleComplianceOnboard,
  handleComplianceOnboardUpdate,
  type OnboardError,
  type OnboardRunner,
  type OnboardUpdateRunner,
} from './onboard'
import { buildComplianceOverviewPrompt } from './prompt'
import {
  RecordEvidenceInputSchema,
  handleComplianceRecordEvidence,
  type RecordEvidenceError,
  type RecordEvidenceRunner,
} from './record-evidence'
import { renderComplianceStatusMarkdown } from './render-status'
import {
  COMPLIANCE_INTERVIEW_QUESTIONS_URI,
  COMPLIANCE_MANUAL_EVIDENCE_URI_TEMPLATE,
  COMPLIANCE_SOURCES_REGISTRY_URI,
  COMPLIANCE_STATUS_URI,
  buildInterviewQuestionsResource,
  buildManualEvidenceInstructionsResource,
  buildSourceRegistryResource,
  buildStatusResource,
} from './resources'
import { handleComplianceStatus, type ComplianceStatusReader } from './status'

/**
 * Deps the registration function consumes. The optional `readStatus`
 * override lets the e2e test exercise the registered tool/resource
 * without hitting GCP.
 */
export interface RegisterComplianceSurfaceDeps {
  readonly config: Config
  readonly logger: Logger
  /**
   * Firestore handle for async-job lifecycle tracking. The MCP server
   * already has one for OAuth state; pass it through here so the
   * compliance-discover tools can do read-after-write status reads
   * (which BigQuery can't reliably do during its 30-90 minute
   * streaming buffer window).
   */
  readonly firestore: FirestoreClientLike
  readonly readStatus?: ComplianceStatusReader
  readonly runOnboard?: OnboardRunner
  readonly runOnboardUpdate?: OnboardUpdateRunner
  readonly runRecordEvidence?: RecordEvidenceRunner
  readonly runDiscoverStart?: DiscoverStartRunner
  readonly runDiscoverStatus?: DiscoverStatusRunner
  readonly runDiscoverResult?: DiscoverResultRunner
}

/**
 * Format an `OnboardError` for inclusion in a tool's text response.
 * Exported so the test suite asserts on the same formatting the model
 * sees.
 */
export function formatOnboardErrorText(error: OnboardError): string {
  return `Error (${error.type}): ${error.message}`
}

/**
 * Format a `RecordEvidenceError` similarly.
 */
export function formatRecordEvidenceErrorText(
  error: RecordEvidenceError,
): string {
  return `Error (${error.type}): ${error.message}`
}

/**
 * Format an async-discover tool error.
 */
export function formatDiscoverErrorText(
  error: DiscoverStartError | DiscoverStatusError | DiscoverResultError,
): string {
  return `Error (${error.type}): ${error.message}`
}

/**
 * Build the tool callback for `compliance-status`. Exported for direct
 * unit-testing of the formatting/error branches.
 */
export function createStatusToolCallback(
  deps: RegisterComplianceSurfaceDeps,
): () => Promise<CallToolResult> {
  return async () => {
    const result = await handleComplianceStatus({
      config: deps.config,
      logger: deps.logger,
      readStatus: deps.readStatus,
    })
    if (result.isErr()) {
      return {
        content: [
          {
            type: 'text',
            text: `Error (${result.error.type}): ${result.error.message}`,
          },
        ],
        isError: true,
      }
    }
    // Return ONLY the server-rendered Markdown report. We previously
    // also returned the raw JSON (in a second text block + as
    // structuredContent) on the theory the model could "use the
    // structured data and paraphrase". In practice the model would
    // pluck a few fields from the JSON, ignore the rendered Markdown's
    // links + computed dates, and produce an unlinked narrative with
    // wrong date math ("due this week" when the renderer had already
    // computed "Overdue by 7 days"). With only the Markdown in the
    // content array, the model has nothing else to splice from and
    // tends to emit the report verbatim.
    //
    // The JSON shape is still available via the compliance://status
    // resource for programmatic clients that need structured access.
    const markdown = renderComplianceStatusMarkdown(result.value)
    return {
      content: [{ type: 'text', text: markdown }],
    }
  }
}

/**
 * Build the resource read callback for `compliance://status`.
 */
export function createStatusResourceCallback(
  deps: RegisterComplianceSurfaceDeps,
): () => Promise<ReadResourceResult> {
  return async () => {
    const result = await handleComplianceStatus({
      config: deps.config,
      logger: deps.logger,
      readStatus: deps.readStatus,
    })
    if (result.isErr()) {
      return {
        contents: [
          {
            uri: COMPLIANCE_STATUS_URI,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                error: {
                  type: result.error.type,
                  message: result.error.message,
                },
              },
              null,
              2,
            ),
          },
        ],
      }
    }
    return buildStatusResource(result.value)
  }
}

/**
 * Build the manual-evidence resource template's read callback. Used by
 * both the registration code and direct unit tests.
 */
export function manualEvidenceTemplateCallback(
  uri: URL,
  variables: Variables,
): ReadResourceResult {
  const sourceIdRaw = variables.sourceId
  const sourceId = Array.isArray(sourceIdRaw) ? sourceIdRaw[0] : sourceIdRaw
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              error: 'missing_source_id',
              message:
                'The compliance://sources/{sourceId}/manual-evidence-instructions URI requires a non-empty sourceId.',
            },
            null,
            2,
          ),
        },
      ],
    }
  }
  const built = buildManualEvidenceInstructionsResource(sourceId)
  if (built === null) {
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              error: 'unknown_source',
              message: `No registered compliance source with id "${sourceId}".`,
              sourceId,
            },
            null,
            2,
          ),
        },
      ],
    }
  }
  return built
}

/**
 * Build the tool callback for `compliance-onboard`. Exported so the
 * confirm-gate / error-formatting branches can be tested directly.
 */
export function createOnboardToolCallback(
  deps: RegisterComplianceSurfaceDeps,
): (input: {
  confirm: boolean
  answers: z.infer<typeof OnboardingAnswersInputSchema>
}) => Promise<CallToolResult> {
  return async (input) => {
    const result = await handleComplianceOnboard(
      { confirm: input.confirm, answers: input.answers },
      {
        config: deps.config,
        logger: deps.logger,
        runOnboard: deps.runOnboard,
      },
    )
    if (result.isErr()) {
      return {
        content: [{ type: 'text', text: formatOnboardErrorText(result.error) }],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              legalName: result.value.legalName,
              identifiers: result.value.identifiers,
              migration: result.value.migration,
            },
            null,
            2,
          ),
        },
      ],
    }
  }
}

/**
 * Build the tool callback for `compliance-onboard-update`.
 */
export function createOnboardUpdateToolCallback(
  deps: RegisterComplianceSurfaceDeps,
): (input: {
  confirm: boolean
  partial: z.infer<typeof PartialOnboardingAnswersInputSchema>
}) => Promise<CallToolResult> {
  return async (input) => {
    const result = await handleComplianceOnboardUpdate(
      { confirm: input.confirm, partial: input.partial },
      {
        config: deps.config,
        logger: deps.logger,
        runOnboardUpdate: deps.runOnboardUpdate,
      },
    )
    if (result.isErr()) {
      return {
        content: [{ type: 'text', text: formatOnboardErrorText(result.error) }],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              legalName: result.value.legalName,
              identifiers: result.value.identifiers,
            },
            null,
            2,
          ),
        },
      ],
    }
  }
}

/**
 * Build the tool callback for `compliance-record-evidence`.
 */
export function createRecordEvidenceToolCallback(
  deps: RegisterComplianceSurfaceDeps,
): (input: {
  confirm: boolean
  sourceId: string
  observedAt?: string
  evidence: Record<string, unknown>
}) => Promise<CallToolResult> {
  return async (input) => {
    const result = await handleComplianceRecordEvidence(input, {
      config: deps.config,
      logger: deps.logger,
      runRecordEvidence: deps.runRecordEvidence,
    })
    if (result.isErr()) {
      return {
        content: [
          { type: 'text', text: formatRecordEvidenceErrorText(result.error) },
        ],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              sourceId: result.value.sourceId,
              jurisdictionId: result.value.jurisdictionId,
              runId: result.value.runId,
              recordedAt: result.value.recordedAt,
              findings: result.value.findings,
            },
            null,
            2,
          ),
        },
      ],
    }
  }
}

/**
 * Build the tool callback for `compliance-discover-start`.
 */
export function createDiscoverStartToolCallback(
  deps: RegisterComplianceSurfaceDeps,
): (input: {
  confirm: boolean
  sources?: readonly string[]
  jurisdictionId?: string
}) => Promise<CallToolResult> {
  return async (input) => {
    const result = await handleComplianceDiscoverStart(input, {
      config: deps.config,
      logger: deps.logger,
      firestore: deps.firestore,
      runDiscoverStart: deps.runDiscoverStart,
    })
    if (result.isErr()) {
      return {
        content: [
          { type: 'text', text: formatDiscoverErrorText(result.error) },
        ],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { ok: true, jobId: result.value.jobId },
            null,
            2,
          ),
        },
      ],
    }
  }
}

/**
 * Build the tool callback for `compliance-discover-status`.
 */
export function createDiscoverStatusToolCallback(
  deps: RegisterComplianceSurfaceDeps,
): (input: { jobId: string }) => Promise<CallToolResult> {
  return async (input) => {
    const result = await handleComplianceDiscoverStatus(input, {
      config: deps.config,
      logger: deps.logger,
      firestore: deps.firestore,
      runDiscoverStatus: deps.runDiscoverStatus,
    })
    if (result.isErr()) {
      return {
        content: [
          { type: 'text', text: formatDiscoverErrorText(result.error) },
        ],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result.value, null, 2),
        },
      ],
    }
  }
}

/**
 * Build the tool callback for `compliance-discover-result`.
 */
export function createDiscoverResultToolCallback(
  deps: RegisterComplianceSurfaceDeps,
): (input: { jobId: string }) => Promise<CallToolResult> {
  return async (input) => {
    const result = await handleComplianceDiscoverResult(input, {
      config: deps.config,
      logger: deps.logger,
      firestore: deps.firestore,
      runDiscoverResult: deps.runDiscoverResult,
    })
    if (result.isErr()) {
      return {
        content: [
          { type: 'text', text: formatDiscoverErrorText(result.error) },
        ],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, result: result.value }, null, 2),
        },
      ],
    }
  }
}

/**
 * Build the prompt callback for `compliance-overview`. Exported so
 * the registration code path is covered by direct unit tests.
 */
export function createComplianceOverviewPromptCallback(
  deps: RegisterComplianceSurfaceDeps,
): () => {
  messages: {
    role: 'user'
    content: { type: 'text'; text: string }
  }[]
} {
  return () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: buildComplianceOverviewPrompt(deps.config),
        },
      },
    ],
  })
}

/**
 * Resource callback for `compliance://sources/registry`. Exported so
 * the registration code path is covered by direct unit tests.
 */
export function sourceRegistryResourceCallback(): ReadResourceResult {
  return buildSourceRegistryResource()
}

/**
 * Resource callback for `compliance://onboarding/interview-questions`.
 */
export function interviewQuestionsResourceCallback(): ReadResourceResult {
  return buildInterviewQuestionsResource()
}

/**
 * Register the read-only compliance surface on an MCP server.
 */
export function registerComplianceSurface(
  mcp: McpServer,
  deps: RegisterComplianceSurfaceDeps,
): void {
  const statusToolCallback = createStatusToolCallback(deps)
  const statusResourceCallback = createStatusResourceCallback(deps)

  mcp.registerTool(
    'compliance-status',
    {
      title: 'Compliance Status',
      description:
        "Read the nonprofit's current compliance state: entity row, identifiers, latest per-source discovery runs, and open findings. Returns an overall flag (clear | attention_required | unknown).",
      inputSchema: {},
    },
    statusToolCallback,
  )

  mcp.registerTool(
    'compliance-onboard',
    {
      title: 'Compliance Onboard (full submit)',
      description:
        'First-time onboarding: persists the nonprofit identity to BigQuery and Secret Manager. Requires confirm: true. Use the compliance://onboarding/interview-questions resource to drive the conversational collection of the answers parameter.',
      inputSchema: {
        confirm: ConfirmSchema,
        answers: OnboardingAnswersInputSchema,
      },
    },
    createOnboardToolCallback(deps),
  )

  mcp.registerTool(
    'compliance-onboard-update',
    {
      title: 'Compliance Onboard Update (partial)',
      description:
        'Update one or more onboarding fields (e.g. a newly issued AG charity number) without resubmitting the whole bundle. Requires confirm: true. Rejects if no prior onboarding exists.',
      inputSchema: {
        confirm: ConfirmSchema,
        partial: PartialOnboardingAnswersInputSchema,
      },
    },
    createOnboardUpdateToolCallback(deps),
  )

  mcp.registerTool(
    'compliance-record-evidence',
    {
      title: 'Compliance Record Evidence',
      description:
        'Persist user-provided evidence for a manual or user-assisted-authenticated source. Pull compliance://sources/{sourceId}/manual-evidence-instructions first to learn the expected evidence keys. Requires confirm: true.',
      inputSchema: {
        confirm: ConfirmSchema,
        sourceId: RecordEvidenceInputSchema.shape.sourceId,
        observedAt: RecordEvidenceInputSchema.shape.observedAt,
        evidence: RecordEvidenceInputSchema.shape.evidence,
      },
    },
    createRecordEvidenceToolCallback(deps),
  )

  mcp.registerTool(
    'compliance-discover-start',
    {
      title: 'Compliance Discover (start)',
      description:
        'Launch an async compliance-discovery job. Returns a jobId immediately; the discovery runs in the background. Poll compliance-discover-status until status is "completed" then call compliance-discover-result. Requires confirm: true. Optional sources and jurisdictionId filters scope the run.',
      inputSchema: {
        confirm: ConfirmSchema,
        sources: DiscoverStartInputSchema.sources,
        jurisdictionId: DiscoverStartInputSchema.jurisdictionId,
      },
    },
    createDiscoverStartToolCallback(deps),
  )

  mcp.registerTool(
    'compliance-discover-status',
    {
      title: 'Compliance Discover (status)',
      description:
        'Read the lifecycle status of a discovery job: running / completed / failed, plus a per-source completion count.',
      inputSchema: {
        jobId: z
          .string()
          .min(1)
          .describe('The job id returned by compliance-discover-start.'),
      },
    },
    createDiscoverStatusToolCallback(deps),
  )

  mcp.registerTool(
    'compliance-discover-result',
    {
      title: 'Compliance Discover (result)',
      description:
        'Fetch the assembled DiscoveryReport for a completed job. Rejects with not_ready if the job is still running or failed.',
      inputSchema: {
        jobId: z
          .string()
          .min(1)
          .describe('The job id returned by compliance-discover-start.'),
      },
    },
    createDiscoverResultToolCallback(deps),
  )

  mcp.registerResource(
    'compliance-status-resource',
    COMPLIANCE_STATUS_URI,
    {
      title: 'Compliance Status',
      description:
        'Current compliance state as a JSON snapshot. Mirrors the compliance-status tool but is URI-addressable so the model can pull it as grounding context.',
      mimeType: 'application/json',
    },
    statusResourceCallback,
  )

  mcp.registerResource(
    'compliance-sources-registry',
    COMPLIANCE_SOURCES_REGISTRY_URI,
    {
      title: 'Compliance Sources Registry',
      description:
        'The list of compliance sources known to this server, with access URLs, automation/auth status, and manual-evidence availability.',
      mimeType: 'application/json',
    },
    sourceRegistryResourceCallback,
  )

  mcp.registerResource(
    'compliance-interview-questions',
    COMPLIANCE_INTERVIEW_QUESTIONS_URI,
    {
      title: 'Compliance Onboarding Interview Questions',
      description:
        'Field metadata for the onboarding interview. Each entry has a field name, prompt, kind, and whether it is optional. The host model uses this to drive the question-by-question collection before calling compliance-onboard.',
      mimeType: 'application/json',
    },
    interviewQuestionsResourceCallback,
  )

  mcp.registerPrompt(
    'compliance-overview',
    {
      title: 'Compliance Toolkit Overview',
      description:
        'Short prose describing the compliance tools, resources, and the recommended order of operations. Use this prompt to ground the host LLM before answering compliance questions.',
    },
    createComplianceOverviewPromptCallback(deps),
  )

  mcp.registerResource(
    'compliance-manual-evidence-instructions',
    new ResourceTemplate(COMPLIANCE_MANUAL_EVIDENCE_URI_TEMPLATE, {
      list: undefined,
    }),
    {
      title: 'Compliance Manual Evidence Instructions',
      description:
        'Per-source instructions and evidence-field metadata for sources that require user-assisted authenticated checks. The model uses these to walk the user through a portal login + paste workflow before calling compliance-record-evidence.',
      mimeType: 'application/json',
    },
    manualEvidenceTemplateCallback,
  )
}
