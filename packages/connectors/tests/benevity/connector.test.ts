/**
 * Tests for the Benevity connector.
 */
import { createConnectorError, type DonationEvent } from '@donations-etl/types'
import { DateTime } from 'luxon'
import { errAsync, okAsync } from 'neverthrow'
import { describe, expect, it } from 'vitest'
import type { IBenevityClient } from '../../src/benevity/client'
import {
  BenevityConnector,
  createBenevityConnector,
} from '../../src/benevity/connector'
import {
  BenevityCsvRowSchema,
  type BenevityReport,
} from '../../src/benevity/schema'
import type { FetchOptions } from '../../src/types'

const RUN_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'

const OPTIONS: FetchOptions = {
  from: DateTime.utc(2026, 1, 1),
  to: DateTime.utc(2026, 12, 31),
  runId: RUN_ID,
}

function report(
  disbursementId: string,
  transactionId: string,
  amount: string,
): BenevityReport {
  const row = BenevityCsvRowSchema.parse({
    Company: 'Google',
    Project: 'LELEKA FOUNDATION',
    'Donation Date': '2026-07-06T20:56:08Z',
    'Donor First Name': 'James',
    'Donor Last Name': 'Duke',
    Email: 'jamesduke@example.com',
    'Transaction ID': transactionId,
    Currency: 'USD',
    'Total Donation to be Acknowledged': amount,
    'Match Amount': '0.00',
    'Cause Support Fee': '0.00',
    'Merchant Fee': '0.00',
  })

  return {
    filename: `${disbursementId}.csv`,
    meta: {
      charityName: 'LELEKA FOUNDATION',
      charityId: '840-472377309',
      periodEnding: 'Mon 17 Aug 2026 0:00:00',
      currency: 'USD',
      paymentMethod: 'EFT',
      disbursementId,
    },
    rows: [row],
    totals: {
      grossCents: Math.round(Number(amount) * 100),
      paymentFeeCents: 0,
      netCents: Math.round(Number(amount) * 100),
    },
  }
}

function stubClient(overrides: Partial<IBenevityClient> = {}): IBenevityClient {
  return {
    readAllReports: () => okAsync([]),
    healthCheck: () => okAsync(undefined),
    ...overrides,
  }
}

describe('BenevityConnector', () => {
  it('declares the benevity source', () => {
    const connector = new BenevityConnector(
      { reportDirPath: '/tmp/benevity' },
      stubClient(),
    )
    expect(connector.source).toBe('benevity')
  })

  it('constructs its own client when none is injected', () => {
    const connector = new BenevityConnector({ reportDirPath: '/tmp/benevity' })
    expect(connector.source).toBe('benevity')
  })

  describe('createBenevityConnector', () => {
    it('creates a connector from configuration', () => {
      const connector = createBenevityConnector({
        reportDirPath: '/tmp/benevity',
      })
      expect(connector).toBeInstanceOf(BenevityConnector)
      expect(connector.source).toBe('benevity')
    })

    it('accepts an injected client', async () => {
      const connector = createBenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient({
          readAllReports: () => okAsync([report('D1', 'TX1', '25.00')]),
        }),
      )
      const result = await connector.fetchAll(OPTIONS)
      expect(result._unsafeUnwrap()).toHaveLength(1)
    })
  })

  describe('fetchAll', () => {
    it('flattens events across every report', async () => {
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient({
          readAllReports: () =>
            okAsync([
              report('D1', 'TX1', '25.00'),
              report('D2', 'TX2', '10.00'),
            ]),
        }),
      )

      const result = await connector.fetchAll(OPTIONS)
      expect(result.isOk()).toBe(true)

      const events = result._unsafeUnwrap()
      expect(events).toHaveLength(2)
      expect(events.map((event: DonationEvent) => event.external_id)).toEqual([
        'TX1',
        'TX2',
      ])
      expect(
        events.every((event: DonationEvent) => event.run_id === RUN_ID),
      ).toBe(true)
      expect(events[0]?.source_metadata.disbursement_id).toBe('D1')
    })

    it('returns an empty list when no reports are present', async () => {
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient(),
      )

      const result = await connector.fetchAll(OPTIONS)
      expect(result._unsafeUnwrap()).toEqual([])
    })

    it('propagates a client error', async () => {
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient({
          readAllReports: () =>
            errAsync(
              createConnectorError('network', 'benevity', 'directory gone'),
            ),
        }),
      )

      const result = await connector.fetchAll(OPTIONS)
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().message).toBe('directory gone')
    })

    it('fails the run when a report does not reconcile', async () => {
      const broken = report('D1', 'TX1', '25.00')
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient({
          readAllReports: () =>
            okAsync([
              {
                ...broken,
                totals: { ...broken.totals, grossCents: 999999 },
              },
            ]),
        }),
      )

      const result = await connector.fetchAll(OPTIONS)
      expect(result.isErr()).toBe(true)

      const error = result._unsafeUnwrapErr()
      expect(error.source).toBe('benevity')
      expect(error.type).toBe('validation')
      expect(error.message).toContain(
        'D1.csv: donation rows sum to 2500 cents but the report trailer reports 999999 cents',
      )
    })
  })

  describe('fetchPage', () => {
    it('returns every event in a single page', async () => {
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient({
          readAllReports: () => okAsync([report('D1', 'TX1', '25.00')]),
        }),
      )

      const result = await connector.fetchPage(OPTIONS)
      const page = result._unsafeUnwrap()
      expect(page.events).toHaveLength(1)
      expect(page.hasMore).toBe(false)
      expect(page.nextCursor).toBeUndefined()
    })

    it('propagates errors', async () => {
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient({
          readAllReports: () =>
            errAsync(createConnectorError('network', 'benevity', 'nope')),
        }),
      )

      const result = await connector.fetchPage(OPTIONS)
      expect(result.isErr()).toBe(true)
    })
  })

  describe('healthCheck', () => {
    it('delegates to the client', async () => {
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient(),
      )
      const result = await connector.healthCheck()
      expect(result.isOk()).toBe(true)
    })

    it('surfaces a client failure', async () => {
      const connector = new BenevityConnector(
        { reportDirPath: '/tmp/benevity' },
        stubClient({
          healthCheck: () =>
            errAsync(
              createConnectorError('network', 'benevity', 'missing dir'),
            ),
        }),
      )

      const result = await connector.healthCheck()
      expect(result.isErr()).toBe(true)
      expect(result._unsafeUnwrapErr().message).toBe('missing dir')
    })
  })
})
