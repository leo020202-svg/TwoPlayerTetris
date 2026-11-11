// Tells the server this page was viewed, for the site's own visitor counts (no
// cookies, nothing stored on your device). Bots that only download the HTML
// never run this, which keeps them out of the numbers.
(() => {
  const send = () => {
    try {
      const body = JSON.stringify({ p: location.pathname, r: document.referrer, s: location.search });
      const sent = navigator.sendBeacon?.('/api/page', new Blob([body], { type: 'application/json' }));
      if (!sent) fetch('/api/page', { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    } catch {}
  };
  // A page the browser prerendered only counts once it's actually shown.
  if (document.prerendering) document.addEventListener('prerenderingchange', send, { once: true });
  else send();
})();
