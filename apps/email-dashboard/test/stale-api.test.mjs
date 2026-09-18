import assert from 'node:assert/strict'
import { test } from 'node:test'
import { settingsErrorMessage, staleApiMessage } from '../public/settings.js'

const failure = (message, status) => Object.assign(new Error(message), status === undefined ? {} : { status })

test('settings errors explain a stale email API and pass other failures through', () => {
  assert.equal(settingsErrorMessage(failure('Unknown dashboard operation', 404)), staleApiMessage)
  assert.equal(settingsErrorMessage(failure('Not found', 404)), staleApiMessage)
  assert.match(staleApiMessage, /Deploy the latest API Worker/)
  assert.equal(settingsErrorMessage(failure('Settings temporarily unavailable', 503)), 'Settings temporarily unavailable')
  assert.equal(settingsErrorMessage(failure('Your session ended. Reload this page to sign in.')), 'Your session ended. Reload this page to sign in.')
  assert.equal(settingsErrorMessage(failure('', 500)), 'Settings request failed')
  assert.equal(settingsErrorMessage(undefined), 'Settings request failed')
})
