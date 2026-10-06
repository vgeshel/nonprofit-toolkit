/**
 * Tests for IPv4-only fetch wrapper.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock node:dns/promises before importing the module
vi.mock('node:dns/promises', () => ({
  default: {
    lookup:
      vi.fn<
        (
          hostname: string,
          options: { family: number },
        ) => Promise<{ address: string; family: number }>
      >(),
  },
}))

import nodeDns from 'node:dns/promises'
import {
  clearIPv4Cache,
  fetchIPv4,
  invalidateIPv4Cache,
} from '../src/ipv4-fetch'

describe('fetchIPv4', () => {
  const mockLookup = vi.mocked(nodeDns.lookup)

  beforeEach(() => {
    // Clear cache and mocks before each test
    clearIPv4Cache()
    mockLookup.mockReset()
    // Mock global fetch
    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('OK', { status: 200 })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves hostname to IPv4 and makes request with Host header', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 })

    await fetchIPv4('https://api.example1.com/path')

    expect(mockLookup).toHaveBeenCalledWith('api.example1.com', { family: 4 })
    expect(fetch).toHaveBeenCalledWith(
      'https://192.168.1.1/path',
      expect.objectContaining<Record<string, unknown>>({
        headers: expect.any(Headers),
      }),
    )

    // Verify Host header is set
    const fetchMock = vi.mocked(fetch)
    const callArgs = fetchMock.mock.calls[0]
    const headers = callArgs?.[1]?.headers
    expect(headers).toBeInstanceOf(Headers)
    if (headers instanceof Headers) {
      expect(headers.get('Host')).toBe('api.example1.com')
    }
  })

  it('verifies TLS against the original hostname, not the IP', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 })

    await fetchIPv4('https://api.example11.com/path')

    // Without serverName, Bun checks the certificate against the IP in the
    // URL and fails with "unknown certificate verification error".
    expect(fetch).toHaveBeenCalledWith(
      'https://192.168.1.1/path',
      expect.objectContaining({ tls: { serverName: 'api.example11.com' } }),
    )
  })

  it('keeps caller TLS options while setting serverName', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 })

    await fetchIPv4('https://api.example12.com/path', {
      tls: { rejectUnauthorized: true },
    })

    expect(fetch).toHaveBeenCalledWith(
      'https://192.168.1.1/path',
      expect.objectContaining({
        tls: { rejectUnauthorized: true, serverName: 'api.example12.com' },
      }),
    )
  })

  it('preserves existing headers when adding Host header', async () => {
    mockLookup.mockResolvedValueOnce({ address: '10.0.0.1', family: 4 })

    await fetchIPv4('https://api.example2.com/path', {
      headers: { Authorization: 'Bearer token123' },
    })

    const fetchMock = vi.mocked(fetch)
    const callArgs = fetchMock.mock.calls[0]
    const headers = callArgs?.[1]?.headers
    expect(headers).toBeInstanceOf(Headers)
    if (headers instanceof Headers) {
      expect(headers.get('Host')).toBe('api.example2.com')
      expect(headers.get('Authorization')).toBe('Bearer token123')
    }
  })

  it('falls back to regular fetch when DNS lookup fails', async () => {
    mockLookup.mockRejectedValueOnce(new Error('DNS lookup failed'))

    await fetchIPv4('https://api.example3.com/path')

    // Should call fetch with original URL since DNS failed
    expect(fetch).toHaveBeenCalledWith(
      'https://api.example3.com/path',
      undefined,
    )
  })

  it('uses regular fetch for URLs that are already IP addresses (IPv4)', async () => {
    await fetchIPv4('https://192.168.1.1/path')

    // Should not attempt DNS lookup for IP addresses
    expect(mockLookup).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('https://192.168.1.1/path', undefined)
  })

  it('uses regular fetch for URLs that are already IP addresses (IPv6)', async () => {
    await fetchIPv4('https://[::1]/path')

    // Should not attempt DNS lookup for IP addresses
    expect(mockLookup).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('https://[::1]/path', undefined)
  })

  it('handles http:// URLs', async () => {
    mockLookup.mockResolvedValueOnce({ address: '172.16.0.1', family: 4 })

    await fetchIPv4('http://api.example4.com/path')

    expect(mockLookup).toHaveBeenCalledWith('api.example4.com', { family: 4 })
    expect(fetch).toHaveBeenCalledWith(
      'http://172.16.0.1/path',
      expect.objectContaining<Record<string, unknown>>({
        headers: expect.any(Headers),
      }),
    )
  })

  it('handles URL objects', async () => {
    mockLookup.mockResolvedValueOnce({ address: '10.10.10.10', family: 4 })

    const url = new URL('https://api.example5.com/path')
    await fetchIPv4(url)

    expect(mockLookup).toHaveBeenCalledWith('api.example5.com', { family: 4 })
  })

  it('handles Request objects', async () => {
    mockLookup.mockResolvedValueOnce({ address: '10.10.10.10', family: 4 })

    const request = new Request('https://api.example6.com/path')
    await fetchIPv4(request)

    expect(mockLookup).toHaveBeenCalledWith('api.example6.com', { family: 4 })
  })

  it('preserves port in URL', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 })

    await fetchIPv4('https://api.example7.com:8443/path')

    expect(fetch).toHaveBeenCalledWith(
      'https://192.168.1.1:8443/path',
      expect.anything(),
    )
  })

  it('preserves query parameters', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 })

    await fetchIPv4('https://api.example8.com/path?foo=bar&baz=qux')

    expect(fetch).toHaveBeenCalledWith(
      'https://192.168.1.1/path?foo=bar&baz=qux',
      expect.anything(),
    )
  })

  it('uses cached IPv4 address for repeated requests', async () => {
    mockLookup.mockResolvedValue({ address: '192.168.1.1', family: 4 })

    await fetchIPv4('https://api.example9.com/path1')
    await fetchIPv4('https://api.example9.com/path2')

    // Should only call lookup once due to caching
    expect(mockLookup).toHaveBeenCalledTimes(1)
  })

  it('passes through RequestInit options', async () => {
    mockLookup.mockResolvedValueOnce({ address: '192.168.1.1', family: 4 })

    await fetchIPv4('https://api.example10.com/path', {
      method: 'POST',
      body: JSON.stringify({ data: 'test' }),
    })

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ data: 'test' }),
      }),
    )
  })
})

describe('clearIPv4Cache', () => {
  it('clears cached entries', async () => {
    const mockLookup = vi.mocked(nodeDns.lookup)
    mockLookup.mockReset()
    mockLookup.mockResolvedValue({ address: '1.2.3.4', family: 4 })

    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('OK', { status: 200 })),
    )

    // First request populates cache
    await fetchIPv4('https://cache-test.example.com/path1')
    expect(mockLookup).toHaveBeenCalledTimes(1)

    // Second request uses cache
    await fetchIPv4('https://cache-test.example.com/path2')
    expect(mockLookup).toHaveBeenCalledTimes(1)

    // Clear cache
    clearIPv4Cache()

    // Third request should trigger new lookup
    await fetchIPv4('https://cache-test.example.com/path3')
    expect(mockLookup).toHaveBeenCalledTimes(2)

    vi.unstubAllGlobals()
  })
})

describe('invalidateIPv4Cache', () => {
  it('invalidates a specific hostname cache entry', async () => {
    const mockLookup = vi.mocked(nodeDns.lookup)
    mockLookup.mockReset()
    clearIPv4Cache()
    mockLookup.mockResolvedValue({ address: '1.2.3.4', family: 4 })

    vi.stubGlobal(
      'fetch',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('OK', { status: 200 })),
    )

    // Populate cache for two different hostnames
    await fetchIPv4('https://host-a.example.com/path')
    await fetchIPv4('https://host-b.example.com/path')
    expect(mockLookup).toHaveBeenCalledTimes(2)

    // Invalidate only host-a
    invalidateIPv4Cache('host-a.example.com')

    // Request to host-a should trigger new lookup
    await fetchIPv4('https://host-a.example.com/path')
    expect(mockLookup).toHaveBeenCalledTimes(3)

    // Request to host-b should still use cache
    await fetchIPv4('https://host-b.example.com/path')
    expect(mockLookup).toHaveBeenCalledTimes(3)

    vi.unstubAllGlobals()
  })
})

describe('cache invalidation on connection error', () => {
  it('invalidates cache when fetch throws an error', async () => {
    const mockLookup = vi.mocked(nodeDns.lookup)
    mockLookup.mockReset()
    clearIPv4Cache()
    mockLookup.mockResolvedValue({ address: '1.2.3.4', family: 4 })

    const mockFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', mockFetch)

    // First request succeeds, populating cache
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    await fetchIPv4('https://error-test.example.com/path1')
    expect(mockLookup).toHaveBeenCalledTimes(1)

    // Second request uses cache (no new DNS lookup)
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    await fetchIPv4('https://error-test.example.com/path2')
    expect(mockLookup).toHaveBeenCalledTimes(1)

    // Third request fails with connection error
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'))
    await expect(
      fetchIPv4('https://error-test.example.com/path3'),
    ).rejects.toThrow('Connection refused')

    // Cache should now be invalidated, so fourth request triggers new DNS lookup
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    await fetchIPv4('https://error-test.example.com/path4')
    expect(mockLookup).toHaveBeenCalledTimes(2)

    vi.unstubAllGlobals()
  })

  it('wraps non-Error rejection values in Error', async () => {
    const mockLookup = vi.mocked(nodeDns.lookup)
    mockLookup.mockReset()
    clearIPv4Cache()
    mockLookup.mockResolvedValue({ address: '1.2.3.4', family: 4 })

    const mockFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', mockFetch)

    // First request succeeds, populating cache
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    await fetchIPv4('https://non-error-test.example.com/path1')

    // Second request fails with a non-Error value (e.g. a string)
    mockFetch.mockRejectedValueOnce('connection reset')
    await expect(
      fetchIPv4('https://non-error-test.example.com/path2'),
    ).rejects.toThrow('connection reset')

    vi.unstubAllGlobals()
  })

  it('does not invalidate cache when fetch returns HTTP error', async () => {
    const mockLookup = vi.mocked(nodeDns.lookup)
    mockLookup.mockReset()
    clearIPv4Cache()
    mockLookup.mockResolvedValue({ address: '5.6.7.8', family: 4 })

    const mockFetch = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', mockFetch)

    // First request populates cache
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    await fetchIPv4('https://http-error.example.com/path1')
    expect(mockLookup).toHaveBeenCalledTimes(1)

    // Second request returns 500 (HTTP error, not connection error)
    mockFetch.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    )
    const response = await fetchIPv4('https://http-error.example.com/path2')
    expect(response.status).toBe(500)

    // Cache should NOT be invalidated (HTTP errors don't invalidate)
    mockFetch.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    await fetchIPv4('https://http-error.example.com/path3')
    expect(mockLookup).toHaveBeenCalledTimes(1) // Still just 1 lookup

    vi.unstubAllGlobals()
  })
})
