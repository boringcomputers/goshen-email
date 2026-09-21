// Documentation pages: the small-screen navigation toggle and copy buttons on code blocks.
const toggle = document.querySelector('.docs-nav-toggle')
toggle?.addEventListener('click', () => {
  const open = toggle.getAttribute('aria-expanded') === 'true'
  toggle.setAttribute('aria-expanded', String(!open))
})
if (navigator.clipboard) {
  for (const block of document.querySelectorAll('.docs-content pre')) {
    const button = document.createElement('button')
    button.type = 'button'; button.className = 'copy-button'; button.textContent = 'Copy'
    button.setAttribute('aria-label', 'Copy code')
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(block.querySelector('code')?.textContent ?? block.textContent)
        button.textContent = 'Copied'
      } catch { button.textContent = 'Copy failed' }
      setTimeout(() => { button.textContent = 'Copy' }, 1500)
    })
    block.append(button)
  }
}
