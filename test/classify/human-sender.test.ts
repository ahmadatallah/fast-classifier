import { describe, expect, test } from 'bun:test'
import { isHumanSender } from '../../src/classify/human-sender.js'
import { compileConfig } from '../../src/config/compile.js'
import { classifierConfigSchema } from '../../src/config/schema.js'

const compiled = compileConfig(classifierConfigSchema.parse({}))

describe('isHumanSender', () => {
  test('spaced real name from a neutral address is human', () => {
    expect(isHumanSender({ name: 'Jane Doe', email: 'jane.doe@posteo.de' }, compiled)).toBe(true)
    expect(isHumanSender({ name: 'Jane Doe', email: 'jane.doe@gmail.com' }, compiled)).toBe(true)
  })

  test('name must contain whitespace after trimming', () => {
    expect(isHumanSender({ name: 'Jane', email: 'jane@posteo.de' }, compiled)).toBe(false)
    expect(isHumanSender({ name: '  Jane  ', email: 'jane@posteo.de' }, compiled)).toBe(false)
    expect(isHumanSender({ name: '', email: 'jane@posteo.de' }, compiled)).toBe(false)
  })

  test('automated address patterns are rejected despite a spaced name', () => {
    expect(isHumanSender({ name: 'Jane Doe', email: 'noreply@example.com' }, compiled)).toBe(false)
    expect(isHumanSender({ name: 'Jane Doe', email: 'no-reply@example.com' }, compiled)).toBe(false)
    expect(isHumanSender({ name: 'The Crew', email: 'team@startup.io' }, compiled)).toBe(false)
    expect(isHumanSender({ name: 'Acme Billing', email: 'billing@shop.example' }, compiled)).toBe(
      false,
    )
    expect(isHumanSender({ name: 'Jane Doe', email: 'jane@mail.foocorp.com' }, compiled)).toBe(
      false,
    )
  })

  test('brand tokens in the display name are rejected', () => {
    expect(isHumanSender({ name: 'Amazon Web Services', email: 'foo@gmail.com' }, compiled)).toBe(
      false,
    )
  })

  test('brand tokens in the address are rejected', () => {
    expect(isHumanSender({ name: 'John Smith', email: 'john.smith@paypal.com' }, compiled)).toBe(
      false,
    )
  })
})
