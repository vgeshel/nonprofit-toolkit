/**
 * Tests for the compliance-migrate CLI glue. The orchestration logic is
 * tested in migrate.test.ts; this file covers:
 *   - `parseExists` shape narrowing
 *   - `toPortError` discriminating Error vs non-Error
 *   - `makeBqPort` wiring (each method delegates to the right BQ method)
 *   - `runCli` exit-code paths (argv parse error, runtime error, success)
 */
import { describe, expect, it, vi } from 'vitest'
import {
  makeBqPort,
  parseExists,
  runCli,
  toPortError,
  type BqClient,
  type BqDataset,
  type CliIo,
} from '../skills/migrate-cli.ts'

interface RecordingIo extends CliIo {
  readonly out: string[]
  readonly errs: string[]
  readonly exits: number[]
}

function fakeIo(): RecordingIo {
  const out: string[] = []
  const errs: string[] = []
  const exits: number[] = []
  return {
    out,
    errs,
    exits,
    stdout: (s) => out.push(s),
    stderr: (s) => errs.push(s),
    exit: (c) => exits.push(c),
  }
}

interface FakeDatasetState {
  exists: ReturnType<typeof vi.fn<BqDataset['exists']>>
  createTable: ReturnType<typeof vi.fn<BqDataset['createTable']>>
  tableExists: ReturnType<typeof vi.fn<() => Promise<unknown>>>
}

function fakeDataset(state: FakeDatasetState): BqDataset {
  return {
    exists: state.exists,
    createTable: state.createTable,
    table: () => ({ exists: state.tableExists }),
  }
}

function fakeBq(state: {
  dataset: FakeDatasetState
  createDataset: ReturnType<typeof vi.fn<BqClient['createDataset']>>
  query?: ReturnType<typeof vi.fn<BqClient['query']>>
}): BqClient {
  return {
    dataset: () => fakeDataset(state.dataset),
    createDataset: state.createDataset,
    query: state.query ?? vi.fn<BqClient['query']>(() => Promise.resolve([])),
  }
}

function fakeBqDefault(): BqClient {
  return fakeBq({
    dataset: {
      exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([false])),
      createTable: vi.fn<BqDataset['createTable']>(() => Promise.resolve([{}])),
      tableExists: vi.fn<() => Promise<unknown>>(() =>
        Promise.resolve([false]),
      ),
    },
    createDataset: vi.fn<BqClient['createDataset']>(() =>
      Promise.resolve([{}]),
    ),
  })
}

describe('parseExists', () => {
  it('returns the wrapped boolean', () => {
    expect(parseExists([true])).toBe(true)
    expect(parseExists([false])).toBe(false)
  })

  it('returns false for malformed input', () => {
    expect(parseExists('no')).toBe(false)
    expect(parseExists([])).toBe(false)
    expect(parseExists([1, 2])).toBe(false)
  })
})

describe('toPortError', () => {
  it('uses Error.message when given an Error', () => {
    const e = toPortError(new Error('boom'))
    expect(e.type).toBe('sdk')
    expect(e.message).toBe('boom')
  })

  it('stringifies non-Error values', () => {
    const e = toPortError('weird')
    expect(e.type).toBe('sdk')
    expect(e.message).toBe('weird')
  })

  it('handles null and undefined', () => {
    expect(toPortError(null).message).toBe('null')
    expect(toPortError(undefined).message).toBe('undefined')
  })
})

describe('makeBqPort', () => {
  it('routes datasetExists through the BQ dataset.exists()', async () => {
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([false]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })
    const port = makeBqPort(bq)
    const r = await port.datasetExists('compliance')
    expect(r.isOk()).toBe(true)
    expect(r._unsafeUnwrap()).toBe(true)
  })

  it('returns a typed error when datasetExists rejects', async () => {
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() =>
          Promise.reject(new Error('forbidden')),
        ),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([false]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })
    const port = makeBqPort(bq)
    const r = await port.datasetExists('compliance')
    expect(r.isErr()).toBe(true)
    if (r.isErr()) {
      expect(r.error.message).toBe('forbidden')
    }
  })

  it('routes createDataset', async () => {
    const createDataset = vi.fn<BqClient['createDataset']>(() =>
      Promise.resolve([{ name: 'compliance' }]),
    )
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([false])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([false]),
        ),
      },
      createDataset,
    })
    const port = makeBqPort(bq)
    const r = await port.createDataset('compliance')
    expect(r.isOk()).toBe(true)
    expect(createDataset).toHaveBeenCalledWith('compliance')
  })

  it('returns a typed error when createDataset rejects', async () => {
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([false])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([false]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.reject(new Error('quota')),
      ),
    })
    const port = makeBqPort(bq)
    const r = await port.createDataset('compliance')
    expect(r.isErr()).toBe(true)
  })

  it('routes tableExists through dataset(...).table(...).exists()', async () => {
    const tableExists = vi.fn<() => Promise<unknown>>(() =>
      Promise.resolve([true]),
    )
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists,
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })
    const port = makeBqPort(bq)
    const r = await port.tableExists({
      dataset: 'compliance',
      tableId: 'entity',
    })
    expect(r.isOk()).toBe(true)
    expect(r._unsafeUnwrap()).toBe(true)
    expect(tableExists).toHaveBeenCalledTimes(1)
  })

  it('returns a typed error when tableExists rejects', async () => {
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.reject(new Error('flaky')),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })
    const port = makeBqPort(bq)
    const r = await port.tableExists({
      dataset: 'compliance',
      tableId: 'entity',
    })
    expect(r.isErr()).toBe(true)
  })

  it('routes createTable, passing schema and description through', async () => {
    const createTable = vi.fn<BqDataset['createTable']>(() =>
      Promise.resolve([{ name: 'entity' }]),
    )
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable,
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([false]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })
    const port = makeBqPort(bq)
    await port.createTable({
      dataset: 'compliance',
      tableId: 'entity',
      schema: { fields: [{ name: 'id', type: 'STRING', mode: 'REQUIRED' }] },
      description: 'rows',
    })
    const [tableId, options] = createTable.mock.calls[0] ?? []
    expect(tableId).toBe('entity')
    expect(options?.description).toBe('rows')
    expect(options?.schema).toEqual({
      fields: [{ name: 'id', type: 'STRING', mode: 'REQUIRED' }],
    })
  })

  it('returns a typed error when createTable rejects', async () => {
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.reject(new Error('schema invalid')),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([false]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })
    const port = makeBqPort(bq)
    const r = await port.createTable({
      dataset: 'compliance',
      tableId: 'entity',
      schema: { fields: [] },
      description: '',
    })
    expect(r.isErr()).toBe(true)
  })

  it('routes addTableColumn through BigQuery DDL', async () => {
    const query = vi.fn<BqClient['query']>(() => Promise.resolve([]))
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([true]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
      query,
    })
    const port = makeBqPort(bq)
    const result = await port.addTableColumn({
      dataset: 'compliance',
      tableId: 'sources',
      field: { name: 'access_url', type: 'STRING', mode: 'NULLABLE' },
    })
    expect(result.isOk()).toBe(true)
    expect(query).toHaveBeenCalledWith({
      query:
        'ALTER TABLE `compliance.sources` ADD COLUMN IF NOT EXISTS access_url STRING',
    })
  })

  it('routes createOrReplaceView through BigQuery DDL', async () => {
    const query = vi.fn<BqClient['query']>(() => Promise.resolve([]))
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([true]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
      query,
    })
    const port = makeBqPort(bq)
    const result = await port.createOrReplaceView({
      dataset: 'compliance',
      viewId: 'current_open_findings',
      query: 'SELECT * FROM `compliance.findings`',
      description: 'current findings',
    })

    expect(result.isOk()).toBe(true)
    expect(query).toHaveBeenCalledWith({
      query:
        'CREATE OR REPLACE VIEW `compliance.current_open_findings` AS SELECT * FROM `compliance.findings`',
    })
  })

  it('routes tableColumnExists through INFORMATION_SCHEMA.COLUMNS', async () => {
    const query = vi.fn<BqClient['query']>(() =>
      Promise.resolve([[{ column_name: 'access_url' }], {}]),
    )
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([true]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
      query,
    })
    const port = makeBqPort(bq)
    const result = await port.tableColumnExists({
      dataset: 'compliance',
      tableId: 'sources',
      columnName: 'access_url',
    })

    expect(result.isOk()).toBe(true)
    if (!result.isOk()) return
    expect(result.value).toBe(true)
    expect(query).toHaveBeenCalledWith({
      query:
        'SELECT 1 FROM `compliance.INFORMATION_SCHEMA.COLUMNS` ' +
        'WHERE table_name = @tableId ' +
        'AND column_name = @columnName ' +
        'LIMIT 1',
      params: { tableId: 'sources', columnName: 'access_url' },
      parameterMode: 'named',
    })
  })

  it('returns a typed error when addTableColumn rejects', async () => {
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([true]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
      query: vi.fn<BqClient['query']>(() =>
        Promise.reject(new Error('ddl failed')),
      ),
    })
    const port = makeBqPort(bq)
    const result = await port.addTableColumn({
      dataset: 'compliance',
      tableId: 'sources',
      field: { name: 'access_url', type: 'STRING', mode: 'NULLABLE' },
    })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) {
      expect(result.error.message).toBe('ddl failed')
    }
  })
})

describe('runCli', () => {
  it('exits 0 and prints a success summary on a clean run', async () => {
    const io = fakeIo()
    await runCli({
      argv: ['--project', 'p'],
      io,
      bqFactory: () => fakeBqDefault(),
    })
    expect(io.exits).toEqual([0])
    expect(io.out.join('')).toContain('compliance-migrate:')
    expect(io.out.join('')).toContain('dataset=created')
  })

  it('marks dataset as present if it already exists', async () => {
    const io = fakeIo()
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() => Promise.resolve([true])),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([true]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })

    await runCli({
      argv: ['--project', 'p'],
      io,
      bqFactory: () => bq,
    })
    expect(io.exits).toEqual([0])
    expect(io.out.join('')).toContain('dataset=present')
  })

  it('appends "(dry-run)" suffix when --dry-run is set', async () => {
    const io = fakeIo()
    await runCli({
      argv: ['--project', 'p', '--dry-run'],
      io,
      bqFactory: () => fakeBqDefault(),
    })
    expect(io.exits).toEqual([0])
    expect(io.out.join('')).toContain('(dry-run)')
  })

  it('exits 2 when CLI args fail to parse', async () => {
    const io = fakeIo()
    await runCli({
      argv: [],
      io,
      bqFactory: () => fakeBqDefault(),
    })
    expect(io.exits).toEqual([2])
    expect(io.errs.join('')).toContain('compliance-migrate:')
  })

  it('exits 1 when migration fails at the BQ level', async () => {
    const io = fakeIo()
    const bq = fakeBq({
      dataset: {
        exists: vi.fn<BqDataset['exists']>(() =>
          Promise.reject(new Error('forbidden')),
        ),
        createTable: vi.fn<BqDataset['createTable']>(() =>
          Promise.resolve([{}]),
        ),
        tableExists: vi.fn<() => Promise<unknown>>(() =>
          Promise.resolve([false]),
        ),
      },
      createDataset: vi.fn<BqClient['createDataset']>(() =>
        Promise.resolve([{}]),
      ),
    })

    await runCli({
      argv: ['--project', 'p'],
      io,
      bqFactory: () => bq,
    })
    expect(io.exits).toEqual([1])
    expect(io.errs.join('')).toContain('forbidden')
  })
})
