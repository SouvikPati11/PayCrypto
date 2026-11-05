// Contact demo form (external file, CSP-safe). No data is sent: the
// production form must be wired to a helpdesk, as the page itself says.
(function () {
  const form = document.getElementById('contactForm');
  if (!form) return;
  form.onsubmit = (e) => {
    e.preventDefault();
    form.innerHTML = '<p>Thanks — your message has been recorded in this demo form. For a production site, wire this form to the support_messages workflow in your helpdesk.</p>';
  };
})();
