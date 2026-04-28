/**
 * Tests for the shared BigQuery adapters.
 *
 * Two adapters live in `src/compliance/state/bq-adapters.ts`:
 *
 *   - `adaptBigQueryToBqClient(bq)` — adapts a real `BigQuery` instance to
 *     the narrow `BqClient` shape `runMigration` expects.
 *   - `adaptBigQueryToQueryRunner(bq)` — adapts a real `BigQuery` instance to
 *     the `BqQueryRunner` port the entity / runs / findings accessors expect.
 *
 * Both adapters are pure pass-throughs; tests verify each method delegates
 * to the expected `BigQuery` method with the expected arguments and that
 * errors are propagated.
 *
 * We mock the `BigQuery` SDK at the module level so the constructor returns
 * a plain object with mockable methods. This matches the pattern used in
 * `packages/bq/tests/client.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'

const mockQuery =
  vi.fn<(opts: unknown) => Promise<readonly [unknown, ...unknown[]]>>()
const mockDataset = vi.fn<
  (id: string) => {
    exists: () => Promise<unknown>
    createTable: (id: string, opts: unknown) => Promise<unknown>
    table: (id: string) => { exists: () => Promise<unknown> }
  }
>()
const mockCreateDataset = vi.fn<(name: string) => Promise<unknown>>()

vi.mock('@google-cloud/bigquery', () => ({
  BigQuery: class MockBigQuery {
    query = mockQuery
    dataset = mockDataset
    createDataset = mockCreateDataset
  },
}))

// Import after mocking so the test sees the stubbed class.
const { BigQuery } = await import('@google-cloud/bigquery')
const { adaptBigQueryToBqClient, adaptBigQueryToQueryRunner } =
  await import('../state/bq-adapters.ts')

function freshBq(): InstanceType<typeof BigQuery> {
  vi.clearAllMocks()
  return new BigQuery({ projectId: 'test-project' })
}

describe('adaptBigQueryToBqClient', () => {
  it('routes dataset(name).exists() through the BigQuery dataset', async () => {
    const bq = freshBq()
    const datasetExists = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve([true]),
    )
    mockDataset.mockReturnValue({
      exists: datasetExists,
      createTable: vi.fn<(id: string, opts: unknown) => Promise<unknown>>(() =>
        Promise.resolve([{}]),
      ),
      table: vi.fn<(id: string) => { exists: () => Promise<unknown> }>(() => ({
        exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([false])),
      })),
    })

    const client = adaptBigQueryToBqClient(bq)
    const got = await client.dataset('compliance').exists()

    expect(mockDataset).toHaveBeenCalledWith('compliance')
    expect(datasetExists).toHaveBeenCalledTimes(1)
    expect(got).toEqual([true])
  })

  it('routes dataset(name).createTable() and forwards schema + description', async () => {
    const bq = freshBq()
    const createTable = vi.fn<(id: string, opts: unknown) => Promise<unknown>>(
      () => Promise.resolve([{ name: 'entity' }]),
    )
    mockDataset.mockReturnValue({
      exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([true])),
      createTable,
      table: vi.fn<(id: string) => { exists: () => Promise<unknown> }>(() => ({
        exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([false])),
      })),
    })

    const client = adaptBigQueryToBqClient(bq)
    await client.dataset('compliance').createTable('entity', {
      schema: {
        fields: [
          { name: 'id', type: 'STRING', mode: 'REQUIRED' },
          { name: 'data', type: 'JSON', mode: 'NULLABLE' },
        ],
      },
      description: 'rows',
    })

    expect(createTable).toHaveBeenCalledTimes(1)
    const call = createTable.mock.calls[0]
    expect(call?.[0]).toBe('entity')
    expect(call?.[1]).toEqual({
      schema: {
        fields: [
          { name: 'id', type: 'STRING', mode: 'REQUIRED' },
          { name: 'data', type: 'JSON', mode: 'NULLABLE' },
        ],
      },
      description: 'rows',
    })
  })

  it('routes dataset(name).table(id).exists() through the BigQuery table', async () => {
    const bq = freshBq()
    const tableExists = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve([true]),
    )
    const table = vi.fn<(id: string) => { exists: () => Promise<unknown> }>(
      () => ({ exists: tableExists }),
    )
    mockDataset.mockReturnValue({
      exists: vi.fn<() => Promise<unknown>>(() => Promise.resolve([true])),
      createTable: vi.fn<(id: string, opts: unknown) => Promise<unknown>>(() =>
        Promise.resolve([{}]),
      ),
      table,
    })

    const client = adaptBigQueryToBqClient(bq)
    const got = await client.dataset('compliance').table('entity').exists()

    expect(table).toHaveBeenCalledWith('entity')
    expect(tableExists).toHaveBeenCalledTimes(1)
    expect(got).toEqual([true])
  })

  it('routes createDataset() through the BigQuery instance', async () => {
    const bq = freshBq()
    mockCreateDataset.mockResolvedValue([{ name: 'compliance' }])

    const client = adaptBigQueryToBqClient(bq)
    const got = await client.createDataset('compliance')

    expect(mockCreateDataset).toHaveBeenCalledWith('compliance')
    expect(got).toEqual([{ name: 'compliance' }])
  })
})

describe('adaptBigQueryToQueryRunner', () => {
  it('returns ok with the row array on a successful query', async () => {
    const bq = freshBq()
    const rows = [{ a: 1 }, { a: 2 }]
    mockQuery.mockResolvedValue([rows, {}])

    const runner = adaptBigQueryToQueryRunner(bq)
    const got = await runner.query('SELECT * FROM t', { foo: 'bar' })

    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toEqual(rows)
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery).toHaveBeenCalledWith({
      query: 'SELECT * FROM t',
      params: { foo: 'bar' },
      parameterMode: 'named',
    })
  })

  it('uses an empty params object when none is supplied', async () => {
    const bq = freshBq()
    mockQuery.mockResolvedValue([[], {}])

    const runner = adaptBigQueryToQueryRunner(bq)
    const got = await runner.query('SELECT 1')

    expect(got.isOk()).toBe(true)
    expect(mockQuery).toHaveBeenCalledWith({
      query: 'SELECT 1',
      params: {},
      parameterMode: 'named',
    })
  })

  it('forwards the types map to BigQuery when supplied', async () => {
    // BigQuery's nodejs SDK rejects null parameter values without an explicit
    // type hint via the `types` companion map. The adapter must forward
    // whatever the accessor passes so nullable columns work end-to-end.
    const bq = freshBq()
    mockQuery.mockResolvedValue([[], {}])

    const runner = adaptBigQueryToQueryRunner(bq)
    const got = await runner.query(
      'SELECT @maybe_null',
      { maybe_null: null },
      { maybe_null: 'STRING' },
    )

    expect(got.isOk()).toBe(true)
    expect(mockQuery).toHaveBeenCalledWith({
      query: 'SELECT @maybe_null',
      params: { maybe_null: null },
      parameterMode: 'named',
      types: { maybe_null: 'STRING' },
    })
  })

  it('omits the types field when no map is supplied', async () => {
    // Backwards compat: when an accessor binds only non-nullable values, no
    // types map is needed and the adapter should not invent an empty one.
    const bq = freshBq()
    mockQuery.mockResolvedValue([[], {}])

    const runner = adaptBigQueryToQueryRunner(bq)
    await runner.query('SELECT 1', { foo: 'bar' })

    expect(mockQuery).toHaveBeenCalledWith({
      query: 'SELECT 1',
      params: { foo: 'bar' },
      parameterMode: 'named',
    })
    const call = mockQuery.mock.calls[0]?.[0]
    expect(call).not.toHaveProperty('types')
  })

  it('returns a typed query error when BigQuery rejects with an Error', async () => {
    const bq = freshBq()
    mockQuery.mockRejectedValue(new Error('forbidden'))

    const runner = adaptBigQueryToQueryRunner(bq)
    const got = await runner.query('SELECT 1')

    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('query')
      expect(got.error.message).toBe('forbidden')
    }
  })

  it('stringifies non-Error rejections', async () => {
    const bq = freshBq()
    mockQuery.mockRejectedValue('weird')

    const runner = adaptBigQueryToQueryRunner(bq)
    const got = await runner.query('SELECT 1')

    expect(got.isErr()).toBe(true)
    if (got.isErr()) {
      expect(got.error.type).toBe('query')
      expect(got.error.message).toBe('weird')
    }
  })

  it('returns an empty array when the row array is malformed', async () => {
    // BigQuery's `query` is typed as returning `[any[], ...]`; if that shape
    // is violated (a smoke test, mostly) we coerce to an empty array rather
    // than throw. The accessor layer will see a benign no-rows response.
    const bq = freshBq()
    mockQuery.mockResolvedValue(['not an array', {}])

    const runner = adaptBigQueryToQueryRunner(bq)
    const got = await runner.query('SELECT 1')

    expect(got.isOk()).toBe(true)
    expect(got._unsafeUnwrap()).toEqual([])
  })
})
