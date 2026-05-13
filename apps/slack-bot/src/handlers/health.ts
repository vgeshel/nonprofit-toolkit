/**
 * Health check handler.
 */

/**
 * Handle GET /health requests.
 */
export function handleHealth(): Response {
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
