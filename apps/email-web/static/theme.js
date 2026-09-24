// Apply the saved theme before the first paint so a light-theme reload never flashes dark.
try {
  if (localStorage.getItem('theme') === 'light') document.documentElement.classList.add('light')
} catch {}
