(() => {
  const views = [...document.querySelectorAll('[data-auth-view]')];
  const alertBox = document.getElementById('authAlert');
  let verificationEmail = '';
  let resetEmail = '';

  function showAlert(message, type = 'info') {
    if (!alertBox) return;
    alertBox.hidden = false;
    alertBox.textContent = message;
    alertBox.className = 'auth-alert';
    if (type === 'error') alertBox.classList.add('is-error');
    if (type === 'success') alertBox.classList.add('is-success');
  }

  function clearAlert() {
    if (!alertBox) return;
    alertBox.hidden = true;
    alertBox.textContent = '';
    alertBox.className = 'auth-alert';
  }

  function openView(name) {
    clearAlert();
    views.forEach(view => {
      const active = view.dataset.authView === name;
      view.hidden = !active;
      view.classList.toggle('is-active', active);
    });
    document.querySelector(`[data-auth-view="${name}"] input`)?.focus();
  }

  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      credentials: 'same-origin',
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Não foi possível concluir a solicitação.');
      Object.assign(error, data);
      throw error;
    }
    return data;
  }

  function setBusy(form, busy) {
    form?.querySelectorAll('button, input').forEach(el => { el.disabled = busy; });
  }

  document.querySelectorAll('[data-auth-open]').forEach(button => {
    button.addEventListener('click', () => openView(button.dataset.authOpen));
  });

  document.querySelectorAll('[data-password-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const input = button.parentElement?.querySelector('input');
      if (!input) return;
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      button.textContent = showing ? 'Mostrar' : 'Ocultar';
    });
  });

  document.getElementById('loginForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const identifier = String(values.email || '').trim().toLowerCase();
    const password = String(values.password || '');
    const panelUrl = location.protocol === 'file:' ? 'index.html' : '/index.html';

    setBusy(form, true);
    clearAlert();

    // Acesso de demonstração do protótipo.
    // Funciona tanto localmente quanto na hospedagem, sem depender da sessão do servidor.
    if (identifier === 'admin' && password === 'admin') {
      localStorage.setItem('aquaflow_demo_session', JSON.stringify({
        authenticated: true,
        user: {
          name: 'Administrador',
          company: 'AquaFlow',
          email: 'admin',
          planName: 'Business',
          planExpiresAt: '2027-11-14T23:59:59.000Z',
          verified: true
        }
      }));
      location.href = panelUrl;
      return;
    }

    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify(values) });
      localStorage.removeItem('aquaflow_demo_session');
      location.href = panelUrl;
    } catch (error) {
      if (error.requiresVerification) {
        verificationEmail = error.email || values.email;
        document.querySelector('[data-verify-email]').textContent = verificationEmail;
        openView('verify');
        showAlert('Seu e-mail ainda precisa ser verificado.', 'error');
      } else {
        showAlert(error.message || 'Não foi possível entrar. Confira os dados e tente novamente.', 'error');
      }
    } finally {
      setBusy(form, false);
    }
  });

  document.getElementById('registerForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(form, true);
    clearAlert();
    try {
      const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(values) });
      verificationEmail = result.email;
      document.querySelector('[data-verify-email]').textContent = verificationEmail;
      openView('verify');
      const dev = result.developmentCode ? ` Código de desenvolvimento: ${result.developmentCode}` : '';
      showAlert(`Código enviado para ${verificationEmail}.${dev}`, 'success');
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(form, false);
    }
  });

  document.getElementById('verifyForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const code = new FormData(form).get('code');
    setBusy(form, true);
    try {
      await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ email: verificationEmail, code }) });
      location.href = '/index.html';
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(form, false);
    }
  });

  document.getElementById('resendRegisterCode')?.addEventListener('click', async () => {
    if (!verificationEmail) return showAlert('Informe o e-mail novamente.', 'error');
    try {
      const result = await api('/api/auth/resend-code', { method: 'POST', body: JSON.stringify({ email: verificationEmail, purpose: 'register' }) });
      const dev = result.developmentCode ? ` Código de desenvolvimento: ${result.developmentCode}` : '';
      showAlert(`Novo código enviado.${dev}`, 'success');
    } catch (error) {
      showAlert(error.message, 'error');
    }
  });

  document.getElementById('forgotForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const email = new FormData(form).get('email');
    setBusy(form, true);
    try {
      const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
      resetEmail = email;
      openView('reset');
      const dev = result.developmentCode ? ` Código de desenvolvimento: ${result.developmentCode}` : '';
      showAlert(`Se a conta existir, o código foi enviado.${dev}`, 'success');
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(form, false);
    }
  });

  document.getElementById('resetForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    setBusy(form, true);
    try {
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email: resetEmail, code: values.code, newPassword: values.newPassword })
      });
      openView('login');
      showAlert('Senha atualizada. Você já pode entrar.', 'success');
    } catch (error) {
      showAlert(error.message, 'error');
    } finally {
      setBusy(form, false);
    }
  });

  async function handleGoogleCredential(response) {
    try {
      await api('/api/auth/google', { method: 'POST', body: JSON.stringify({ credential: response.credential }) });
      location.href = '/index.html';
    } catch (error) {
      showAlert(error.message, 'error');
    }
  }

  async function setupGoogle() {
    const fallback = document.getElementById('googleFallback');
    const host = document.getElementById('googleButtonHost');
    try {
      const config = await api('/api/config');
      if (!config.googleClientId) {
        fallback?.addEventListener('click', () => showAlert('Configure GOOGLE_CLIENT_ID no arquivo .env para ativar o login com Google.', 'error'));
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        google.accounts.id.initialize({ client_id: config.googleClientId, callback: handleGoogleCredential });
        fallback.hidden = true;
        google.accounts.id.renderButton(host, {
          theme: 'outline', size: 'large', shape: 'rectangular', text: 'continue_with', width: host.clientWidth || 470
        });
      };
      script.onerror = () => showAlert('Não foi possível carregar o login do Google.', 'error');
      document.head.appendChild(script);
    } catch (error) {
      fallback?.addEventListener('click', () => showAlert('Login com Google indisponível no momento.', 'error'));
    }
  }

  fetch('/api/auth/session', { credentials: 'same-origin' }).then(response => {
    if (response.ok) location.href = '/index.html';
  }).catch(() => {});

  setupGoogle();
})();
