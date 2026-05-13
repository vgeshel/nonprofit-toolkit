/**
 * Tests for the letter modal view definition and submission handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../src/config'
import { createTestLogger } from '../test-utils'

// Mock @donations-etl/letter
const mockQueryDonations = vi.fn<
  (...args: unknown[]) => Promise<{
    isOk: () => boolean
    isErr: () => boolean
    value?: unknown[]
    error?: { message: string }
  }>
>()
const mockProcessQueryResults = vi.fn<
  (rows: unknown[]) => {
    donorName: string
    date: string
    yearGroups: unknown[]
    grandTotals: unknown[]
    totalCount: number
  }
>()
const mockGenerateLetterHtml = vi.fn<(data: unknown) => Promise<string>>()
const mockGeneratePdf = vi.fn<
  (html: string) => Promise<{
    isOk: () => boolean
    isErr: () => boolean
    value?: Buffer
    error?: { message: string }
  }>
>()

vi.mock('@donations-etl/letter', () => ({
  queryDonations: (...args: unknown[]) => mockQueryDonations(...args),
  processQueryResults: (rows: unknown[]) => mockProcessQueryResults(rows),
  generateLetterHtml: (data: unknown) => mockGenerateLetterHtml(data),
  generatePdf: (html: string) => mockGeneratePdf(html),
}))

import type { ViewSubmissionArgs } from '../../src/slack/views/letter-modal'
import {
  buildLetterModal,
  handleLetterModalSubmission,
  LETTER_MODAL_CALLBACK_ID,
} from '../../src/slack/views/letter-modal'

const config: Config = {
  PORT: 8080,
  LOG_LEVEL: 'info',
  PROJECT_ID: 'test-project',
  DATASET_CANON: 'donations',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'test-secret',
  ORG_NAME: 'Your Organization',
  ORG_ADDRESS: '',
  ORG_MISSION:
    'Our organization is dedicated to making a positive impact through charitable giving.',
  ORG_TAX_STATUS:
    'This organization is a tax-exempt organization under Section 501(c)(3) of the Internal Revenue Code. Our EIN is available upon request.',
  DEFAULT_SIGNER_NAME: 'Organization Leader',
  DEFAULT_SIGNER_TITLE: 'Director',
}

const logger = createTestLogger()

describe('LETTER_MODAL_CALLBACK_ID', () => {
  it('is a defined string', () => {
    expect(LETTER_MODAL_CALLBACK_ID).toBe('donor_letter_modal')
  })
})

describe('buildLetterModal', () => {
  it('returns a modal view with correct structure', () => {
    const modal = buildLetterModal('C123456', config)

    expect(modal.type).toBe('modal')
    expect(modal.callback_id).toBe(LETTER_MODAL_CALLBACK_ID)
    expect(modal.private_metadata).toBe('C123456')
    expect(modal.title.text).toBe('Donor Letter')
    expect(modal.submit.text).toBe('Generate')
  })

  it('has email, from, to, and format blocks', () => {
    const modal = buildLetterModal('C123456', config)

    expect(modal.blocks).toHaveLength(6)
    expect(modal.blocks[0]?.block_id).toBe('email_block')
    expect(modal.blocks[1]?.block_id).toBe('from_block')
    expect(modal.blocks[2]?.block_id).toBe('to_block')
    expect(modal.blocks[3]?.block_id).toBe('format_block')
    expect(modal.blocks[4]?.block_id).toBe('signer_name_block')
    expect(modal.blocks[5]?.block_id).toBe('signer_title_block')
  })

  it('makes optional fields optional', () => {
    const modal = buildLetterModal('C123456', config)

    expect(modal.blocks[1]).toHaveProperty('optional', true)
    expect(modal.blocks[2]).toHaveProperty('optional', true)
    expect(modal.blocks[4]).toHaveProperty('optional', true)
    expect(modal.blocks[5]).toHaveProperty('optional', true)
  })
})

describe('handleLetterModalSubmission', () => {
  function makeViewArgs(): ViewSubmissionArgs {
    return {
      ack: vi
        .fn<
          (response?: {
            response_action: string
            errors?: Record<string, string>
          }) => Promise<void>
        >()
        .mockResolvedValue(undefined),
      view: {
        state: {
          values: {
            email_block: {
              email_input: { value: 'jane@example.com' },
            },
            from_block: {
              from_input: { selected_date: null },
            },
            to_block: {
              to_input: { selected_date: null },
            },
            format_block: {
              format_input: {
                selected_option: { value: 'pdf' },
              },
            },
          },
        },
        private_metadata: 'U123456',
      },
      client: {
        files: {
          uploadV2: vi
            .fn<
              (opts: {
                channel_id: string
                content?: string
                file?: Buffer
                filename: string
                title: string
                initial_comment: string
              }) => Promise<unknown>
            >()
            .mockResolvedValue({}),
        },
        chat: {
          postMessage: vi
            .fn<(opts: { channel: string; text: string }) => Promise<unknown>>()
            .mockResolvedValue({}),
        },
        conversations: {
          open: vi
            .fn<
              (opts: {
                users: string
              }) => Promise<{ channel?: { id?: string } }>
            >()
            .mockResolvedValue({ channel: { id: 'D999999' } }),
        },
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('acknowledges the submission', async () => {
    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    })

    const args = makeViewArgs()
    await handleLetterModalSubmission(args, config, logger)

    expect(args.ack).toHaveBeenCalledWith()
  })

  it('returns validation error for empty email', async () => {
    const args = makeViewArgs()
    args.view.state.values.email_block = {
      email_input: { value: '' },
    }

    await handleLetterModalSubmission(args, config, logger)

    expect(args.ack).toHaveBeenCalledWith(
      expect.objectContaining({
        response_action: 'errors',
      }),
    )
  })

  it('posts message when no donations found', async () => {
    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    })

    const args = makeViewArgs()
    await handleLetterModalSubmission(args, config, logger)

    expect(args.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D999999',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        text: expect.stringContaining('No succeeded donations found'),
      }),
    )
  })

  it('posts error message when query fails', async () => {
    mockQueryDonations.mockResolvedValue({
      isOk: () => false,
      isErr: () => true,
      error: { message: 'Connection failed' },
    })

    const args = makeViewArgs()
    await handleLetterModalSubmission(args, config, logger)

    expect(args.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        text: expect.stringContaining('Failed to query donations'),
      }),
    )
  })

  it('uploads HTML file when format is html', async () => {
    const mockRows = [{ some: 'data' }]
    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: mockRows,
    })
    mockProcessQueryResults.mockReturnValue({
      donorName: 'Jane Doe',
      date: 'January 15, 2025',
      yearGroups: [],
      grandTotals: [],
      totalCount: 5,
    })
    mockGenerateLetterHtml.mockResolvedValue('<html>letter</html>')

    const args = makeViewArgs()
    args.view.state.values.format_block = {
      format_input: {
        selected_option: { value: 'html' },
      },
    }

    await handleLetterModalSubmission(args, config, logger)

    expect(args.client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'D999999',
        content: '<html>letter</html>',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        filename: expect.stringContaining('.html'),
      }),
    )
  })

  it('uploads PDF file by default', async () => {
    const mockRows = [{ some: 'data' }]
    const pdfBuffer = Buffer.from('fake-pdf')

    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: mockRows,
    })
    mockProcessQueryResults.mockReturnValue({
      donorName: 'Jane Doe',
      date: 'January 15, 2025',
      yearGroups: [],
      grandTotals: [],
      totalCount: 3,
    })
    mockGenerateLetterHtml.mockResolvedValue('<html>letter</html>')
    mockGeneratePdf.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: pdfBuffer,
    })

    const args = makeViewArgs()
    await handleLetterModalSubmission(args, config, logger)

    expect(args.client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: 'D999999',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        filename: expect.stringContaining('.pdf'),
      }),
    )
  })

  it('posts error when PDF generation fails', async () => {
    const mockRows = [{ some: 'data' }]

    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: mockRows,
    })
    mockProcessQueryResults.mockReturnValue({
      donorName: 'Jane Doe',
      date: 'January 15, 2025',
      yearGroups: [],
      grandTotals: [],
      totalCount: 1,
    })
    mockGenerateLetterHtml.mockResolvedValue('<html>letter</html>')
    mockGeneratePdf.mockResolvedValue({
      isOk: () => false,
      isErr: () => true,
      error: { message: 'Browser crashed' },
    })

    const args = makeViewArgs()
    await handleLetterModalSubmission(args, config, logger)

    expect(args.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        text: expect.stringContaining('Failed to generate PDF'),
      }),
    )
  })

  it('parses comma-separated emails', async () => {
    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    })

    const args = makeViewArgs()
    args.view.state.values.email_block = {
      email_input: { value: 'jane@example.com, j.doe@work.org' },
    }

    await handleLetterModalSubmission(args, config, logger)

    expect(mockQueryDonations).toHaveBeenCalledWith(
      expect.anything(),
      ['jane@example.com', 'j.doe@work.org'],
      undefined,
      undefined,
    )
  })

  it('passes date filters to query', async () => {
    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    })

    const args = makeViewArgs()
    args.view.state.values.from_block = {
      from_input: { selected_date: '2024-01-01' },
    }
    args.view.state.values.to_block = {
      to_input: { selected_date: '2024-12-31' },
    }

    await handleLetterModalSubmission(args, config, logger)

    expect(mockQueryDonations).toHaveBeenCalledWith(
      expect.anything(),
      ['jane@example.com'],
      '2024-01-01',
      '2024-12-31',
    )
  })

  it('uses singular text for 1 donation', async () => {
    const mockRows = [{ some: 'data' }]
    const pdfBuffer = Buffer.from('fake-pdf')

    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: mockRows,
    })
    mockProcessQueryResults.mockReturnValue({
      donorName: 'Jane Doe',
      date: 'January 15, 2025',
      yearGroups: [],
      grandTotals: [],
      totalCount: 1,
    })
    mockGenerateLetterHtml.mockResolvedValue('<html>letter</html>')
    mockGeneratePdf.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: pdfBuffer,
    })

    const args = makeViewArgs()
    await handleLetterModalSubmission(args, config, logger)

    expect(args.client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        initial_comment: expect.stringContaining('1 donation)'),
      }),
    )
  })

  it('uses singular text for 1 HTML donation', async () => {
    const mockRows = [{ some: 'data' }]

    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: mockRows,
    })
    mockProcessQueryResults.mockReturnValue({
      donorName: 'Jane Doe',
      date: 'January 15, 2025',
      yearGroups: [],
      grandTotals: [],
      totalCount: 1,
    })
    mockGenerateLetterHtml.mockResolvedValue('<html>letter</html>')

    const args = makeViewArgs()
    args.view.state.values.format_block = {
      format_input: {
        selected_option: { value: 'html' },
      },
    }

    await handleLetterModalSubmission(args, config, logger)

    expect(args.client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        initial_comment: expect.stringContaining('1 donation)'),
      }),
    )
  })

  it('handles null email value as empty', async () => {
    const args = makeViewArgs()
    args.view.state.values.email_block = {
      email_input: { value: null },
    }

    await handleLetterModalSubmission(args, config, logger)

    // Should trigger validation error since empty emails
    expect(args.ack).toHaveBeenCalledWith(
      expect.objectContaining({
        response_action: 'errors',
      }),
    )
  })

  it('falls back to userId when conversations.open returns no channel', async () => {
    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    })

    const args = makeViewArgs()
    args.client.conversations.open = vi
      .fn<(opts: { users: string }) => Promise<{ channel?: { id?: string } }>>()
      .mockResolvedValue({})

    await handleLetterModalSubmission(args, config, logger)

    // Should use userId as channel fallback
    expect(args.client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'U123456',
      }),
    )
  })

  it('handles missing block values with defaults', async () => {
    mockQueryDonations.mockResolvedValue({
      isOk: () => true,
      isErr: () => false,
      value: [],
    })

    const args = makeViewArgs()
    // Remove optional blocks to hit ?? fallback branches
    args.view.state.values = {
      email_block: {
        email_input: { value: 'jane@example.com' },
      },
    }

    await handleLetterModalSubmission(args, config, logger)

    // Should still succeed (using defaults for from/to/format)
    expect(args.ack).toHaveBeenCalledWith()
  })
})
