import { describe, it, expect } from 'vitest'
import { normalizeDomain, isValidDomain } from './emailDomain'

describe('normalizeDomain', () => {
  it('lowercases and trims', () => {
    expect(normalizeDomain('  GoAbroad.com ')).toBe('goabroad.com')
  })
  it('strips a leading @ an admin may type', () => {
    expect(normalizeDomain('@goabroad.com')).toBe('goabroad.com')
  })
})

describe('isValidDomain', () => {
  it('accepts a plain domain', () => {
    expect(isValidDomain('goabroad.com')).toBe(true)
  })
  it('accepts a subdomain', () => {
    expect(isValidDomain('mail.goabroad.com')).toBe(true)
  })
  it('rejects a full email address', () => {
    // An admin pasting a full address must be told, not left with a row that
    // can never match anything.
    expect(isValidDomain('portia@example.com')).toBe(false)
  })
  it('rejects a bare label with no dot', () => {
    expect(isValidDomain('goabroad')).toBe(false)
  })
  it('rejects an empty string', () => {
    expect(isValidDomain('')).toBe(false)
  })
  it('rejects whitespace inside', () => {
    expect(isValidDomain('go abroad.com')).toBe(false)
  })
  it('rejects a leading hyphen', () => {
    expect(isValidDomain('-goabroad.com')).toBe(false)
  })
  it('rejects a trailing hyphen in a label', () => {
    expect(isValidDomain('goabroad-.com')).toBe(false)
  })
  it('rejects consecutive dots', () => {
    expect(isValidDomain('a..b.com')).toBe(false)
  })
  it('rejects a leading dot', () => {
    expect(isValidDomain('.com')).toBe(false)
  })
  it('rejects a trailing dot', () => {
    expect(isValidDomain('goabroad.com.')).toBe(false)
  })
  it('rejects a lone dot', () => {
    expect(isValidDomain('.')).toBe(false)
  })
})
