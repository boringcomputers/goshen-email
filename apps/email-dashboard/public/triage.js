const title = value => value.charAt(0).toUpperCase() + value.slice(1)
const percent = value => `${Math.round(value * 100)}%`
const node = (tag, text, className) => {
  const element = document.createElement(tag)
  element.textContent = text
  if (className) element.className = className
  return element
}

// Thread badges live in dashboard-shell.js so a saved thread list paints with them before this module loads.
export const triageBadges = window.BezalelDashboardShell.triageBadges

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
