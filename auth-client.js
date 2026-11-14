(() => {
  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('pt-BR').format(date);
  }

  function getDemoSession() {
    try {
      const raw = localStorage.getItem('aquaflow_demo_session');
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data?.authenticated ? data : null;
    } catch {
      return null;
    }
  }

  function loginUrl() {
    return location.protocol === 'file:' ? 'login.html' : '/login.html';
  }

  async function fetchSession() {
    const demo = getDemoSession();
    if (demo) return demo;

    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
      if (!response.ok) {
        location.href = loginUrl();
        return null;
      }
      return response.json();
    } catch {
      location.href = loginUrl();
      return null;
    }
  }

  function applyUser(user) {
    document.querySelectorAll('.user-name').forEach(el => { el.textContent = user.name || 'Administrador'; });
    document.querySelectorAll('.user-subtitle').forEach(el => { el.textContent = `Plano ${user.planName || 'Business'}`; });

    const planPanel = document.querySelector('.user-panel');
    if (planPanel) {
      const topName = planPanel.querySelector('.user-panel__top strong');
      if (topName) topName.textContent = user.name || 'Administrador';
      const chip = planPanel.querySelector('.plan-card__chip');
      if (chip) chip.textContent = `Plano ${user.planName || 'Business'}`;
      const rows = planPanel.querySelectorAll('.plan-card__list li');
      rows.forEach(row => {
        const label = row.querySelector('span')?.textContent?.trim();
        const strong = row.querySelector('strong');
        if (!strong) return;
        if (label === 'Empresa') strong.textContent = user.company || 'Minha empresa';
        if (label === 'Validade') strong.textContent = formatDate(user.planExpiresAt);
      });
    }

    const expiration = new Date(user.planExpiresAt);
    if (!Number.isNaN(expiration.getTime())) {
      const days = Math.ceil((expiration - new Date()) / 86400000);
      const notification = document.querySelector('.notification-item--warning');
      if (notification) {
        const title = notification.querySelector('.notification-item__content > strong');
        const body = notification.querySelector('.notification-item__content > p');
        if (days >= 0 && days <= 30) {
          title.textContent = days === 0 ? 'Plano da empresa expira hoje' : `Plano da empresa expira em ${days} dia${days === 1 ? '' : 's'}`;
          body.innerHTML = `Renove até <strong>${formatDate(user.planExpiresAt)}</strong> para manter o monitoramento e o histórico ativos.`;
        } else if (days < 0) {
          title.textContent = 'Plano da empresa expirado';
          body.innerHTML = `O plano venceu em <strong>${formatDate(user.planExpiresAt)}</strong>. Regularize para continuar usando os recursos contratados.`;
        }
      }
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const session = await fetchSession();
      if (session?.user) applyUser(session.user);
    } catch {
      location.href = loginUrl();
    }
  });
})();
