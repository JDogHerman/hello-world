// Small progressive enhancements; every page works without JS.
(function () {
  // Countdown timers: <span class="countdown" data-expires="ISO">
  function fmt(ms) {
    if (ms <= 0) return 'expiring…';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + 'h ' : '') + String(m).padStart(h ? 2 : 1, '0') + 'm ' + String(sec).padStart(2, '0') + 's';
  }
  function tick() {
    document.querySelectorAll('.countdown[data-expires]').forEach(function (el) {
      const ms = new Date(el.dataset.expires).getTime() - Date.now();
      el.textContent = fmt(ms);
      el.classList.toggle('soon', ms < 5 * 60 * 1000);
    });
  }
  setInterval(tick, 1000);
  document.addEventListener('DOMContentLoaded', tick);

  // Live board: <div data-poll="/jobs/1/board" data-interval="5000">
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-poll]').forEach(function (el) {
      const every = Number(el.dataset.interval || 5000);
      setInterval(function () {
        if (document.hidden) return;
        // Don't swap the DOM while someone is typing in it.
        if (el.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
        fetch(el.dataset.poll, { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.text() : null; })
          .then(function (html) { if (html !== null) { el.innerHTML = html; tick(); } })
          .catch(function () {});
      }, every);
    });
  });

  // Confirmation prompts: <form data-confirm="Are you sure?">
  document.addEventListener('submit', function (e) {
    const msg = e.target.dataset && e.target.dataset.confirm;
    if (msg && !window.confirm(msg)) e.preventDefault();
  });

  // Job form: add/remove position rows.
  document.addEventListener('click', function (e) {
    if (e.target.matches('[data-add-row]')) {
      const tpl = document.querySelector(e.target.dataset.addRow);
      const rows = document.querySelector(e.target.dataset.target);
      rows.appendChild(tpl.content.cloneNode(true));
    }
    if (e.target.matches('[data-remove-row]')) {
      const row = e.target.closest('.pos-row');
      if (row && row.parentElement.children.length > 1) row.remove();
    }
  });
})();
