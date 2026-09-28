const form = document.getElementById('feedbackForm');
const statusEl = document.getElementById('feedbackStatus');
const submitBtn = form.querySelector('button[type="submit"]');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'form-status' + (kind ? ` ${kind}` : '');
}

if (new URLSearchParams(location.search).has('error')) {
  setStatus('Sorry, your message could not be sent. Please try again.', 'error');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  if (!String(data.message || '').trim()) { setStatus('Please write a message.', 'error'); return; }

  submitBtn.disabled = true;
  setStatus('Sending…');
  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      form.reset();
      setStatus('Thanks! Your message has been sent.', 'ok');
    } else {
      setStatus(body.error || 'Sorry, your message could not be sent. Please try again.', 'error');
    }
  } catch {
    setStatus('Could not reach the server. Check your connection and try again.', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
