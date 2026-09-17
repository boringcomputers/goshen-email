const title = value => value.charAt(0).toUpperCase() + value.slice(1)
const percent = value => `${Math.round(value * 100)}%`
const node = (tag, text, className) => {
  const element = document.createElement(tag)
  element.textContent = text
  if (className) element.className = className
  return element
}

export function triageBadges(triage) {
  const group = node('div', '', 'triage-badges')
  if (!triage) return group
  group.setAttribute('aria-label', 'Email triage')
  if (triage.status !== 'complete') {
    group.append(node('span', triage.status === 'pending' ? 'Analysis pending' : 'Analysis unavailable', 'triage-badge muted'))
    return group
  }
  const category = node('span', `${triage.category.confidence < 0.5 ? 'Maybe ' : ''}${title(triage.category.value)}`, 'triage-badge')
  category.title = `Category confidence: ${percent(triage.category.confidence)}`
  group.append(category)
  const reply = triage.needsReply.value
  group.append(node('span', reply === null ? 'Reply unclear' : reply ? 'Needs reply' : 'No reply needed', `triage-badge${reply ? ' triage-reply' : ''}`))
  const urgency = triage.urgency.value
  group.append(node('span', urgency ? `${title(urgency)} urgency` : 'Urgency unclear', `triage-badge triage-${urgency ?? 'uncertain'}`))
  return group
}

export function triageDetails(triage) {
  const details = node('details', '', 'message-details triage-details')
  details.append(node('summary', 'Email triage'))
  if (triage.status !== 'complete') {
    details.append(node('p', triage.status === 'pending'
      ? 'Analysis is queued. Refresh in a moment to see the result.'
      : 'Analysis could not finish. Your email is still available.'))
    return details
  }
  const distribution = Object.entries(triage.category.probabilities).sort((a, b) => b[1] - a[1])
    .map(([category, probability]) => `${title(category)}: ${percent(probability)}`).join(' · ')
  details.append(node('p', 'Suggestions describe this message when it arrived. Check the conversation before acting.'))
  details.append(node('p', `Reply needed: ${percent(triage.needsReply.probability)} probability.`))
  details.append(node('p', `Category: ${distribution}`))
  details.append(node('p', `Urgency: ${triage.urgency.score.toFixed(2)} / 3 · ${percent(triage.urgency.confidence)} confidence.`))
  details.append(node('p', `Analyzed ${new Date(triage.analyzedAt).toLocaleString()}${triage.bodyTruncated ? ' · Only the beginning of this long message was analyzed.' : ''}`))
  return details
}
