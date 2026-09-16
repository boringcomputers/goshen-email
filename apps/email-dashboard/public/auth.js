const $ = (selector) => document.querySelector(selector)
const path = location.pathname
const query = new URLSearchParams(location.search)
const signup = path === '/sign-up', forgot = path === '/forgot-password', reset = path === '/reset-password', verify = path === '/verify-email'
const form = $('#auth-form'), button = $('#submit'), error = $('#error'), message = $('#message')
let email = '', busy = false
if (query.get('reason') === 'access_denied') error.textContent = 'Your account does not have access to this workspace. Contact the owner.'
const title = signup ? 'Make room for your email.' : forgot ? 'Forgot your password?' : reset ? 'A fresh start.' : verify ? 'Check your email.' : 'Welcome back.'
$('#title').textContent = title
document.title = `${signup ? 'Sign up' : forgot || reset ? 'Reset password' : verify ? 'Verify email' : 'Sign in'} — Bezalel Email`
$('#description').textContent = signup ? 'Create your account. Your first inbox is a few steps away.' : forgot ? 'We’ll send you a link to choose a new password.' : reset ? 'Choose a new password for your account.' : verify ? 'Verify your address to open your workspace.' : 'Sign in to your email workspace.'
$('#name-field').hidden = !signup
$('#name').required = signup
$('#email-field').hidden = reset || verify
$('#email').required = !reset && !verify
$('#password-field').hidden = forgot || verify
$('#password').required = !forgot && !verify
$('#password').autocomplete = signup || reset ? 'new-password' : 'current-password'
$('#password').minLength = signup || reset ? 12 : 1
$('#password-hint').hidden = !signup && !reset
$('#forgot-link').hidden = signup || reset
button.firstChild.textContent = signup ? 'Create account ' : forgot ? 'Send reset link ' : reset ? 'Save new password ' : 'Sign in '
const alternate = $('#alternate')
alternate.replaceChildren(document.createTextNode(signup ? 'Already have an account? ' : forgot || reset || verify ? '' : 'New to Bezalel? '))
const link = document.createElement('a'); link.href = signup || forgot || reset || verify ? '/sign-in' : '/sign-up'; link.textContent = signup ? 'Sign in' : forgot || reset || verify ? 'Back to sign in' : 'Create an account'; alternate.append(link)
function notice(text) { message.textContent = text; message.hidden = false }
async function post(endpoint, body) {
  const response = await fetch(`/api/auth/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const value = await response.json()
  if (!response.ok) { const failure = new Error(value.error ?? value.message ?? 'Something went wrong. Try again.'); failure.code = value.code; throw failure }
  return value
}
if (verify) {
  form.hidden = true
  if (query.has('error')) notice('This verification link is invalid or has expired. Sign in to request a new email.')
  else if (query.get('verified') === '1') {
    notice('Your email is verified. Opening your workspace…')
    location.replace('/app')
  } else notice('Open the verification link in your email. You can sign in to request another one.')
}
const resetToken = query.get('token')
if (reset) {
  history.replaceState(null, '', '/reset-password')
  if (!resetToken || query.has('error')) { form.hidden = true; notice('This reset link is invalid or has expired. Request a new password reset.'); link.href = '/forgot-password'; link.textContent = 'Request a new link' }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (busy) return
  busy = true; button.disabled = true; error.textContent = ''; message.hidden = true
  email = $('#email').value.trim()
  try {
    if (forgot) {
      await post('request-password-reset', { email, redirectTo: `${location.origin}/reset-password` })
      form.hidden = true; notice('If an account exists for this email, a password reset link is on its way. Check your inbox and spam folder.')
    } else if (reset) {
      await post('reset-password', { token: resetToken, newPassword: $('#password').value })
      form.reset(); form.hidden = true; notice('Your password has been updated. Sign in with your new password.'); link.focus()
    } else {
      await post(signup ? 'sign-up/email' : 'sign-in/email', { email, password: $('#password').value,
        ...(signup ? { name: $('#name').value.trim() } : {}), callbackURL: `${location.origin}/verify-email?verified=1` })
      if (signup) { form.reset(); form.hidden = true; notice('Check your email for a verification link. If you already have an account, sign in or reset your password.'); $('#resend').hidden = false }
      else location.replace('/app')
    }
  } catch (failure) {
    error.textContent = failure.message || 'Could not connect. Try again.'
    if (failure.code === 'EMAIL_NOT_VERIFIED') { notice('Verify your email before signing in. Check your inbox and spam folder.'); $('#resend').hidden = false }
  } finally { busy = false; button.disabled = false }
})
$('#resend').addEventListener('click', async () => {
  const resend = $('#resend'); resend.disabled = true; error.textContent = ''
  try { await post('send-verification-email', { email, callbackURL: `${location.origin}/verify-email?verified=1` }); notice('If your account needs verification, a new link is on its way.') }
  catch (failure) { notice(failure.message || 'Could not send the email. Try again.') }
  finally { resend.disabled = false }
})
if (!verify && !reset && !forgot) void fetch('/api/session').then((response) => response.json()).then((session) => { if (session.authenticated) location.replace('/app') }).catch(() => {})
