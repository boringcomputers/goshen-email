const featureLabels = {
  inboxes: ['Inboxes', 'standing'], sends: ['Sends', 'monthly'], triage: ['Triage analyses', 'monthly'],
  custom_domains: ['Custom domains', 'standing'], storage_mb: ['Storage', 'standing'], seats: ['Seats', 'standing'],
}
const number = new Intl.NumberFormat('en-US')
const date = value => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
export const formatAmount = (feature, value) => feature === 'storage_mb' ? (value >= 1024 ? `${number.format(value / 1024)} GB` : `${number.format(value)} MB`) : number.format(value)
export const staleBillingMessage = 'The email API is running an older version without plans. Deploy the latest API Worker, then try again.'
const errorMessage = error => error?.status === 404 && error.message === 'Unknown dashboard operation' ? staleBillingMessage : error?.message || 'Usage request failed'

export function createBillingPanel({ rpc, notify, getCustomer, onUsage }) {
  const $ = selector => document.querySelector(selector)
  const node = (tag, attributes = {}, text) => {
    const element = document.createElement(tag)
    for (const [name, value] of Object.entries(attributes)) if (value !== '' && value != null) element.setAttribute(name, value)
    if (text !== undefined) element.textContent = text
    return element
  }
  let version = 0, usage = null, busy = ''
  const includedRows = plan => [
    ['inboxes', plan.included.inboxes], ['sends', plan.included.sends], ['triage', plan.included.triage],
    ['custom_domains', plan.included.customDomains], ['storage_mb', plan.included.storageMb], ['seats', plan.included.seats],
  ]
  function meter(feature) {
    const [label, cadence] = featureLabels[feature.feature] ?? [feature.feature, 'standing']
    const item = node('li', { class: 'billing-meter' })
    item.append(node('span', { class: 'billing-meter-label' }, cadence === 'monthly' ? `${label} this month` : label))
    const amount = node('p', { class: 'billing-meter-amount' })
    amount.append(node('strong', {}, formatAmount(feature.feature, feature.used)),
      feature.unlimited ? ' used, no limit' : ` of ${formatAmount(feature.feature, feature.granted ?? 0)}`)
    item.append(amount)
    let share = 0
    if (!feature.unlimited && feature.granted) {
      // A progress element takes its width from attributes, so it needs no inline style under the dashboard's CSP.
      share = Math.min(100, Math.round(feature.used / feature.granted * 100))
      const bar = node('progress', { class: 'billing-bar', max: String(feature.granted), value: String(Math.min(feature.used, feature.granted)), 'aria-label': label })
      bar.dataset.level = share >= 100 ? 'spent' : share >= 80 ? 'high' : 'ok'
      item.append(bar)
    }
    const notes = []
    const spent = !feature.unlimited && (feature.remaining ?? 0) <= 0 && feature.granted != null
    if (spent) notes.push('Allowance spent.')
    else if (share >= 80) notes.push(`${share}% used.`)
    if (feature.resetsAt && cadence === 'monthly') notes.push(`Resets ${date(feature.resetsAt)}.`)
    if (cadence === 'standing' && feature.feature === 'inboxes' && feature.granted) notes.push('Doesn’t reset. Delete an inbox to free a slot.')
    if (notes.length) {
      const note = node('p', { class: 'settings-hint' }, notes.join(' '))
      if (spent || share >= 80) note.dataset.level = spent ? 'spent' : 'high'
      item.append(note)
    }
    return item
  }
  function planCard(plan, current) {
    const card = node('article', { class: 'billing-plan-card', 'aria-labelledby': `plan-${plan.planId}` })
    if (plan.planId === current) card.dataset.current = ''
    const heading = node('div', { class: 'billing-plan-card-heading' })
    heading.append(node('h3', { id: `plan-${plan.planId}` }, plan.name))
    if (plan.planId === current) heading.append(node('span', { class: 'badge', 'data-status': 'current' }, 'Current'))
    card.append(heading)
    const price = node('p', { class: 'billing-price' })
    price.append(node('strong', {}, `$${plan.price}`), node('span', {}, plan.price ? ' per month' : ' forever'))
    card.append(price, node('p', { class: 'billing-plan-description' }, plan.description))
    const list = node('ul', { class: 'billing-included' })
    for (const [feature, value] of includedRows(plan)) {
      if (!value) continue
      const [label, cadence] = featureLabels[feature]
      list.append(node('li', {}, `${formatAmount(feature, value)} ${value === 1 ? label.toLowerCase().replace(/es$/, '').replace(/s$/, '') : label.toLowerCase()}${cadence === 'monthly' ? ' a month' : ''}`))
    }
    if (plan.topUps) list.append(node('li', {}, '$2 top-ups: one inbox, one domain, 1,000 sends, or 1,000 analyses'))
    card.append(list)
    const order = usage.plans.map(p => p.planId)
    const upgrade = order.indexOf(plan.planId) > order.indexOf(current)
    const button = node('button', { type: 'button', class: upgrade ? 'primary' : '', 'data-plan': plan.planId }, plan.planId === current ? 'Current plan' : upgrade ? `Upgrade to ${plan.name}` : `Switch to ${plan.name}`)
    button.disabled = plan.planId === current || Boolean(busy)
    if (busy === plan.planId) button.textContent = 'Opening checkout…'
    button.addEventListener('click', () => checkout(plan))
    card.append(button)
    return card
  }
  function render() {
    $('#billing-content').hidden = false
    const plan = usage.plan, catalog = usage.plans.find(p => p.planId === plan?.planId)
    const status = usage.billing
    $('#billing-plan-name').textContent = status === 'metered' ? (catalog?.name ?? plan?.planId ?? 'No plan') : status === 'exempt' ? 'Administrator' : 'Self-hosted'
    $('#billing-plan-description').textContent = status === 'metered' ? (catalog?.description ?? 'Your account has a plan on this deployment.')
      : status === 'exempt' ? 'Administrator accounts are not billed. Plan limits do not apply.'
      : 'Billing is not configured on this deployment. Plan limits do not apply.'
    const badge = $('#billing-plan-badge')
    badge.hidden = status !== 'metered' || !plan
    if (plan) {
      badge.textContent = plan.canceledAt ? 'Cancels soon' : plan.status === 'active' ? 'Active' : plan.status
      badge.dataset.status = plan.canceledAt ? 'pending' : plan.status === 'active' ? 'active' : 'pending'
    }
    $('#billing-plan-renewal').textContent = status === 'metered' && plan?.currentPeriodEnd
      ? `${plan.canceledAt ? 'Ends' : catalog?.price ? 'Renews' : 'Allowances reset'} ${date(plan.currentPeriodEnd)}.` : ''
    $('#billing-portal').hidden = status !== 'metered'
    $('#billing-portal').disabled = busy === 'portal'
    $('#billing-portal').textContent = busy === 'portal' ? 'Opening…' : 'Manage billing'
    $('#billing-usage-description').textContent = status === 'metered'
      ? 'Sends and triage analyses reset each billing month. Inbox counts carry over. When an allowance is spent the API returns billing_limit until you upgrade or add capacity.'
      : `You have ${number.format(usage.inboxes.count)} ${usage.inboxes.count === 1 ? 'inbox' : 'inboxes'}${usage.inboxes.limit ? ` of ${number.format(usage.inboxes.limit)} allowed by the operator` : ''}. Each inbox keeps its rolling 24-hour send limit.`
    const meters = $('#billing-meters')
    // Only what the Worker meters today. Storage and seats are declared on the plans but not yet counted.
    meters.replaceChildren(...(status === 'metered' ? usage.features.filter(f => ['inboxes', 'sends', 'triage'].includes(f.feature)).map(meter)
      : [meter({ feature: 'inboxes', used: usage.inboxes.count, granted: usage.inboxes.limit, remaining: usage.inboxes.limit == null ? null : usage.inboxes.limit - usage.inboxes.count, unlimited: usage.inboxes.limit == null, resetsAt: null })]))
    $('#billing-plans').hidden = status !== 'metered' || !usage.plans.length
    $('#billing-plan-list').replaceChildren(...(status === 'metered' ? usage.plans.map(p => planCard(p, plan?.planId)) : []))
  }
  async function load() {
    // A reload supersedes any checkout or portal request still in flight, so the buttons come back.
    const requestVersion = ++version
    busy = ''
    $('#billing-error').textContent = ''; $('#billing-retry').hidden = true
    if (!usage) { $('#billing-loading').hidden = false; $('#billing-content').hidden = true }
    try {
      const result = await rpc('getUsage')
      if (version !== requestVersion) return
      usage = result; render(); onUsage?.(result)
    } catch (error) {
      if (version !== requestVersion) return
      $('#billing-error').textContent = errorMessage(error)
      $('#billing-retry').hidden = false
    } finally { if (version === requestVersion) $('#billing-loading').hidden = true }
  }
  async function checkout(plan) {
    if (busy) return
    busy = plan.planId; render()
    const requestVersion = version
    try {
      const { paymentUrl } = await rpc('startCheckout', { planId: plan.planId })
      if (version !== requestVersion) return
      if (paymentUrl) { location.assign(paymentUrl); return }
      notify(`Plan changed to ${plan.name}.`)
      busy = ''; await load()
    } catch (error) {
      if (version !== requestVersion) return
      busy = ''; render(); $('#billing-error').textContent = errorMessage(error)
    }
  }
  $('#billing-portal').addEventListener('click', async () => {
    if (busy) return
    busy = 'portal'; render()
    const requestVersion = version
    try {
      const { url } = await rpc('openBillingPortal')
      if (version !== requestVersion) return
      location.assign(url)
    } catch (error) {
      if (version !== requestVersion) return
      busy = ''; render(); $('#billing-error').textContent = errorMessage(error)
    }
  })
  $('#billing-retry').addEventListener('click', load)
  $('#billing-refresh').addEventListener('click', () => { usage = null; void load() })
  return {
    load,
    reset() {
      version++; usage = null; busy = ''
      $('#billing-error').textContent = ''; $('#billing-content').hidden = true
      $('#billing-loading').hidden = true; $('#billing-retry').hidden = true
      $('#billing-meters').replaceChildren(); $('#billing-plan-list').replaceChildren()
    },
    customer: getCustomer,
  }
}
