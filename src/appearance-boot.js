(() => {
  const palettes = new Set(['carbon', 'parchment', 'signal', 'vermilion', 'tide']);
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('hey-ditto-local:appearance') || '{}') || {}; }
  catch { saved = {}; }
  const palette = palettes.has(saved.palette) ? saved.palette : 'carbon';
  const systemMode = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  const mode = saved.mode === 'light' || saved.mode === 'dark' ? saved.mode : systemMode;
  document.documentElement.dataset.dittoTheme = palette;
  document.documentElement.dataset.dittoMode = mode;
})();
