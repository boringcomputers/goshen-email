const $ = (selector) => document.querySelector(selector)
const signup = location.pathname === '/sign-up', confirming = location.pathname === '/magic-link'
const query = new URLSearchParams(location.search)
const form = $('#auth-form'), button = $('#submit'), error = $('#error'), message = $('#message')
let email = '', name = '', method = 'link', sent = false, busy = false, resendAt = 0
let confirmation
if (confirming) {
  const fragment = new URLSearchParams(location.hash.slice(1))
  try {
    if (fragment.has('token')) sessionStorage.setItem('bezalel-link', JSON.stringify({ token: fragment.get('token'), email: fragment.get('email'), expires: Date.now() + 600_000 }))
    confirmation = JSON.parse(sessionStorage.getItem('bezalel-link') ?? 'null')
    if (!confirmation || confirmation.expires <= Date.now()) { sessionStorage.removeItem('bezalel-link'); confirmation = null }
  } catch { confirmation = null }
  history.replaceState(null, '', '/magic-link')
}
const originalTitle = signup ? 'Make room for your email.' : 'Welcome back.'
$('#title').textContent = confirming ? 'You’re one click away.' : originalTitle
document.title = `${signup ? 'Sign up' : 'Sign in'} — Bezalel Email`
$('#description').textContent = confirming ? `Sign in as ${confirmation?.email || 'your account'}. Continue only if this is your email address.` : signup ? 'Create your account with a sign-in link or email code.' : 'A link or a code. Your inbox is one email away.'
$('#name-field').hidden = !signup || confirming
$('#name').required = signup && !confirming
$('#email-field').hidden = confirming
$('#email').required = !confirming
$('#method-field').hidden = confirming
if (query.get('reason') === 'access_denied') error.textContent = 'Your account does not have access to this workspace. Contact the owner.'
else if (query.has('error')) error.textContent = 'This sign-in link is invalid, expired, or already used. Request a new one below.'
if (query.has('error') || query.has('reason')) history.replaceState(null, '', location.pathname)
if (confirming) {
  button.firstChild.textContent = 'Continue to workspace '
  if (!confirmation?.email || !/^[A-Za-z0-9_-]{20,256}$/.test(confirmation?.token ?? '')) { form.hidden = true; notice('This sign-in link is incomplete. Request a new email to continue.') }
}
const alternate = $('#alternate')
alternate.replaceChildren(document.createTextNode(confirming ? '' : signup ? 'Already have an account? ' : 'New to Bezalel? '))
const link = document.createElement('a'); link.href = signup || confirming ? '/sign-in' : '/sign-up'; link.textContent = signup ? 'Sign in' : confirming ? 'Request a new sign-in email' : 'Create an account'; alternate.append(link)
function notice(text) { message.textContent = text; message.hidden = false }
async function post(endpoint, body) {
  const response = await fetch(`/api/auth/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  let value
  try { value = await response.json() } catch { throw new Error('Could not connect. Please try again.') }
  if (!response.ok) throw new Error(value.error ?? value.message ?? 'Something went wrong. Try again.')
  return value
}
function updateButton() { if (!confirming) button.firstChild.textContent = sent && method === 'code' ? 'Verify code and sign in ' : method === 'code' ? 'Email me a code ' : 'Email me a sign-in link ' }
form.addEventListener('change', (event) => { if (event.target.name === 'method') { method = event.target.value; updateButton() } })
async function sendEmail() {
  await post(method === 'code' ? 'email-otp/send-verification-otp' : 'sign-in/magic-link', {
    email, ...(method === 'code' ? { type: 'sign-in' } : { ...(name ? { name } : {}), callbackURL: `${location.origin}/app`, errorCallbackURL: `${location.origin}/sign-in` }),
  })
  sent = true; resendAt = Date.now() + 60_000
  $('#title').textContent = 'Check your email.'
  $('#description').textContent = `We sent ${method === 'code' ? 'a six-digit code' : 'a sign-in link'} to ${email}.`
  $('#name-field').hidden = true; $('#name').required = false
  $('#email-field').hidden = true; $('#email').required = false
  $('#method-field').hidden = true
  $('#code-field').hidden = method !== 'code'; $('#code').required = method === 'code'
  $('#resend').hidden = false; $('#change-email').hidden = false
  form.hidden = method === 'link'
  if (method === 'link') notice('Open the link in your email, then choose Continue to workspace. The link works once and expires in 10 minutes. Check your spam folder if you don’t see it.')
  else { message.hidden = true; $('#code').value = ''; $('#code').focus() }
  updateButton()
}
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy) return
  busy = true; button.disabled = true; error.textContent = ''
  try {
    if (confirming) {
      await post('magic-link/verify', { token: confirmation.token, email: confirmation.email })
      sessionStorage.removeItem('bezalel-link'); location.replace('/app')
    } else if (sent && method === 'code') {
      await post('sign-in/email-otp', { email, otp: $('#code').value.trim(), ...(name ? { name } : {}) })
      location.replace('/app')
    } else { email = $('#email').value.trim(); name = $('#name').value.trim(); await sendEmail() }
  } catch (failure) { error.textContent = failure.message || 'Could not connect. Please try again.' }
  finally { busy = false; button.disabled = false }
})
$('#resend').addEventListener('click', async () => {
  if (busy) return
  if (Date.now() < resendAt) { notice('Please wait a minute before requesting another email.'); return }
  busy = true; $('#resend').disabled = true; error.textContent = ''
  try { await sendEmail() }
  catch (failure) { notice(failure.message || 'Could not send the email. Please try again.') }
  finally { busy = false; $('#resend').disabled = false }
})
$('#change-email').addEventListener('click', () => { if (!busy) location.reload() })
if (!confirming) void fetch('/api/session').then((response) => response.json()).then((session) => { if (session.authenticated) location.replace('/app') }).catch(() => {})
