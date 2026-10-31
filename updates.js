/* "Get updates" box: sends first name + email to the DiveFolk Join form with email opt-in. */
(function () {
  const f = document.getElementById('updatesform');
  if (!f) return;
  const ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSdzsPd7N0jV8Yk09-B-uviQF0XtCkMkgbHBFuoPnGR2dMg-hg/formResponse';
  const msg = f.querySelector('.formmsg'), btn = f.querySelector('button');
  const say = t => { msg.textContent = t; msg.hidden = false; };
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const name = f.uname.value.trim(), email = f.uemail.value.trim();
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return say('Please add your first name and a valid email address.');
    const body = new URLSearchParams();
    body.append('entry.1756586344', name);
    body.append('entry.1679550614', email);
    body.append('entry.1479853331', 'Updates signup');
    body.append('entry.1352073245', 'Yes');
    body.append('entry.1153514695', 'Yes');
    btn.disabled = true; btn.textContent = 'Sending...';
    try {
      await fetch(ACTION, { method: 'POST', mode: 'no-cors', body });
      f.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
      btn.textContent = 'Done';
      say(`Thanks, ${name}. We'll email you when something new is added.`);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Notify me';
      say('That didn\'t go through. Please check your connection and try again.');
    }
  });
})();
