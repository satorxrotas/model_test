// Password gate. Only a SHA-256 hash of the password is stored here.
// Note: this keeps casual visitors out; it is not server-side security.
const HASH = '83aa0a92fd7c19574579f876f0442e69f12d026f730a8096f1918be778394bfe';
const KEY = 'gms-unlock';

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stored() {
  try { return localStorage.getItem(KEY) || sessionStorage.getItem(KEY); } catch { return null; }
}

async function unlock() {
  document.body.classList.remove('locked');
  document.getElementById('gate')?.remove();
  await import('./studio.js');
}

(async () => {
  if (stored() === HASH) return unlock();
  const form = document.getElementById('gate-form'), input = document.getElementById('gate-pw'), err = document.getElementById('gate-err');
  input.focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if ((await sha256(input.value)) === HASH) {
      try { (document.getElementById('gate-remember').checked ? localStorage : sessionStorage).setItem(KEY, HASH); } catch {}
      unlock();
    } else {
      err.textContent = 'Wrong password.'; input.select();
      form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
    }
  });
})();
