/* "Share your tip" box on dive site pages: sends to the DiveFolk Site Tips Google Form. */
(function () {
  const ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSdbKrFw5ESL8Ba45zXdkjzqenU93vua_BCLCmlXgI7AUn65wg/formResponse';
  document.querySelectorAll('form.tipform').forEach(f => {
    const msg = f.querySelector('.formmsg'), btn = f.querySelector('button');
    const say = t => { msg.textContent = t; msg.hidden = false; };
    f.addEventListener('submit', async e => {
      e.preventDefault();
      const name = f.tname.value.trim(), when = f.twhen.value.trim(), tip = f.ttip.value.trim();
      const pub = (f.querySelector('input[name=tpub]:checked') || {}).value;
      if (!name || !when || !tip || !pub) return say('Please fill in your first name, when you dived, and your tip.');
      const body = new URLSearchParams();
      body.append('entry.1824908107', name);
      body.append('entry.988543253', f.dataset.site);
      body.append('entry.2057106233', when);
      body.append('entry.2073552456', tip);
      body.append('entry.1716773215', pub);
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        await fetch(ACTION, { method: 'POST', mode: 'no-cors', body });
        f.querySelectorAll('input, textarea, button').forEach(el => { el.disabled = true; });
        btn.textContent = 'Sent';
        say(`Thanks, ${name}. We read every tip and add the helpful ones about once a month.`);
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Send my tip';
        say('That didn\'t go through. Please check your connection and try again.');
      }
    });
  });
})();
