/**
 * Tests for shared thread history builder.
 */
import { describe, expect, it } from 'vitest'
import { buildThreadHistory } from '../../src/slack/thread-history'

describe('buildThreadHistory', () => {
  it('maps user and bot messages', () => {
    const messages = [
      { ts: '1', text: 'question?', user: 'U1' },
      { ts: '2', text: 'answer', bot_id: 'B1' },
      { ts: '3', text: 'follow-up', user: 'U1' },
    ]
    const history = buildThreadHistory(messages, '3')

    expect(history).toEqual([
      { role: 'user', content: 'question?' },
      { role: 'assistant', content: 'answer' },
    ])
  })

  it('excludes current message by timestamp', () => {
    const messages = [
      { ts: '1', text: 'first', user: 'U1' },
      { ts: '2', text: 'current', user: 'U1' },
    ]
    const history = buildThreadHistory(messages, '2')

    expect(history).toHaveLength(1)
    expect(history[0]?.content).toBe('first')
  })

  it('skips SQL thread replies', () => {
    const messages = [
      { ts: '1', text: 'question', user: 'U1' },
      { ts: '2', text: 'answer', bot_id: 'B1' },
      { ts: '3', text: '_Generated SQL:_\n```SELECT 1```', bot_id: 'B1' },
      { ts: '4', text: 'follow-up', user: 'U1' },
    ]
    const history = buildThreadHistory(messages, '4')

    expect(history).toHaveLength(2)
    expect(history.every((m) => !m.content.includes('SQL'))).toBe(true)
  })

  it('strips @mentions from all messages', () => {
    const messages = [
      { ts: '1', text: '<@B123> how much raised?', user: 'U1' },
      { ts: '2', text: 'answer', bot_id: 'B1' },
      { ts: '3', text: '<@B123> follow-up', user: 'U1' },
    ]
    const history = buildThreadHistory(messages, '3')

    expect(history[0]?.content).toBe('how much raised?')
    expect(history[1]?.content).toBe('answer')
  })

  it('skips messages with no text', () => {
    const messages = [
      { ts: '1', text: undefined, user: 'U1' },
      { ts: '2', text: 'real question', user: 'U1' },
      { ts: '3', text: 'current', user: 'U1' },
    ]
    const history = buildThreadHistory(messages, '3')

    expect(history).toHaveLength(1)
    expect(history[0]?.content).toBe('real question')
  })

  it('skips messages that are only @mentions', () => {
    const messages = [
      { ts: '1', text: '<@B123>', user: 'U1' },
      { ts: '2', text: '<@B123> real question', user: 'U1' },
      { ts: '3', text: 'current', user: 'U1' },
    ]
    const history = buildThreadHistory(messages, '3')

    expect(history).toHaveLength(1)
    expect(history[0]?.content).toBe('real question')
  })

  it('returns empty array for empty messages', () => {
    expect(buildThreadHistory([], '1')).toEqual([])
  })

  it('returns empty array when only current message exists', () => {
    const messages = [{ ts: '1', text: 'only message', user: 'U1' }]
    expect(buildThreadHistory(messages, '1')).toEqual([])
  })
})
