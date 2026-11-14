/* =============================================================================
   AquaFlow — integração Web + ESP32
   -----------------------------------------------------------------------------
   Um único arquivo é compartilhado por todas as páginas HTML.

   Fluxo principal:
   1) o navegador consulta o ESP32 (HTTP polling) ou recebe dados via WebSocket;
   2) normalizeTelemetry() converte o JSON recebido para o formato interno;
   3) applyTelemetry() atualiza o estado central;
   4) renderAll() atualiza somente os elementos existentes na página aberta.

   Para conectar ao ESP real, normalmente basta alterar AQUAFLOW_CONFIG.espBaseUrl
   ou abrir o site com ?esp=http://IP-DO-ESP32.
   ============================================================================= */

'use strict';

// -----------------------------------------------------------------------------
// CONFIGURAÇÃO DE INTEGRAÇÃO
// -----------------------------------------------------------------------------
const AQUAFLOW_CONFIG = {
  // "auto": tenta o ESP por HTTP e mantém o mock ativo somente enquanto não há
  // conexão. Também aceita "http", "websocket" ou "mock".
  transport: 'auto',

  // Endereço padrão quando o ESP32 está no modo Access Point. Se ele estiver
  // conectado ao roteador, troque pelo IP mostrado no Serial Monitor.
  espBaseUrl: 'http://192.168.4.1',

  statusPath: '/api/status',
  commandPath: '/api/command',
  websocketPath: '/ws',
  pollIntervalMs: 2000,
  requestTimeoutMs: 1500,

  // Mantém a interface funcionando visualmente enquanto o ESP não está ligado.
  fallbackToMock: true,
  // Cada consulta HTTP pode virar um ponto no gráfico. Mantemos o mesmo
  // intervalo do polling para registrar uma leitura por checagem.
  sampleIntervalMs: 2000,

  // Aproximadamente 30 minutos de histórico quando o polling está em 2 s.
  // O histórico fica salvo no navegador para sobreviver à troca de páginas.
  historyLimit: 900
};

const PAGE_FILES = {
  inicio: 'index.html',
  monitoramento: 'monitoramento.html',
  controle: 'controle.html',
  historico: 'historico.html',
  alertas: 'alertas.html'
};

// -----------------------------------------------------------------------------
// ESTADO CENTRAL
// -----------------------------------------------------------------------------
const state = {
  source: 'mock',
  connected: false,
  lastUpdate: null,
  mode: 'automatico',
  supplyRunning: false,
  sensors: { online: 4, total: 4 },
  reservoirs: {
    principal: { level: 78, liters: 3900, capacity: 5000 },
    reserva: { level: 55, liters: 1100, capacity: 2000 }
  },
  sourceStatus: { flowing: true, label: 'Enviando água' },
  condominiumStatus: { normal: true, label: 'Abastecimento normal' },
  pumps: [
    { id: 'B1', flow: 'Fonte → Principal', on: true, mode: 'Automático' },
    { id: 'B2', flow: 'Principal → Reserva', on: false, mode: 'Automático' },
    { id: 'B3', flow: 'Reserva → Principal', on: false, mode: 'Automático' },
    { id: 'B4', flow: 'Principal → Condomínio', on: true, mode: 'Automático' }
  ],
  alerts: [],
  commandLog: [
    { text: 'Interface AquaFlow iniciada', by: 'Sistema', time: nowTime(), danger: false }
  ],
  samples: loadSamples(),
  pumpRuntime: loadPumpRuntime(),
  alertFilter: 'todos',
  selectedAlertId: null
};

let pendingAction = null;
let toastTimer = null;
let lastSampleAt = 0;

// O tempo diário das bombas é acumulado a partir dos estados ligado/desligado.
// Se o ESP32 enviar o tempo acumulado do dia, esse valor passa a ser a fonte
// autoritativa e substitui o cálculo local.
let pumpRuntimeLastAt = Date.now();
let pumpRuntimeLastStates = Object.fromEntries(state.pumps.map(pump => [pump.id, pump.on]));
let pumpRuntimeTooltipPinned = false;

// Estado exclusivo do gráfico de monitoramento. offset = 0 significa que o
// usuário está vendo as leituras mais recentes; valores maiores navegam para
// janelas anteriores sem interromper a chegada de novas leituras do ESP32.
const LIVE_CHART_WINDOW = 12;
let liveChartOffset = 0;
let liveChartTooltipPinned = false;

// O histórico usa uma janela independente do monitoramento em tempo real.
// Assim, o usuário pode consultar leituras antigas no histórico sem alterar
// a posição do gráfico exibido na página de monitoramento.
const HISTORY_CHART_WINDOW = 14;
let historyChartOffset = 0;
let historyChartTooltipPinned = null;

// -----------------------------------------------------------------------------
// UTILITÁRIOS
// -----------------------------------------------------------------------------
function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

function nowTime(date = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(date);
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

function getByPath(object, path) {
  return path.split('.').reduce((acc, key) => acc?.[key], object);
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function toBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'on', 'ligada', 'ligado', 'ativo', 'ativa'].includes(normalized)) return true;
  if (['false', '0', 'off', 'desligada', 'desligado', 'inativo', 'inativa'].includes(normalized)) return false;
  return fallback;
}

function loadSamples() {
  try { return JSON.parse(localStorage.getItem('aquaflow.samples')) || []; }
  catch { return []; }
}

function saveSamples() {
  try { localStorage.setItem('aquaflow.samples', JSON.stringify(state.samples.slice(-AQUAFLOW_CONFIG.historyLimit))); }
  catch { /* localStorage pode estar bloqueado em navegação privada. */ }
}

function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function loadPumpRuntime() {
  try {
    const saved = JSON.parse(localStorage.getItem('aquaflow.pumpRuntime')) || {};
    return typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function savePumpRuntime() {
  try {
    // Mantém somente os últimos 35 dias para evitar crescimento indefinido.
    const keys = Object.keys(state.pumpRuntime).sort().slice(-35);
    const trimmed = Object.fromEntries(keys.map(key => [key, state.pumpRuntime[key]]));
    state.pumpRuntime = trimmed;
    localStorage.setItem('aquaflow.pumpRuntime', JSON.stringify(trimmed));
  } catch { /* localStorage pode estar bloqueado em navegação privada. */ }
}

function ensurePumpRuntimeDay(key) {
  state.pumpRuntime[key] ??= { B1: 0, B2: 0, B3: 0, B4: 0 };
  ['B1', 'B2', 'B3', 'B4'].forEach(id => {
    state.pumpRuntime[key][id] = Number(state.pumpRuntime[key][id]) || 0;
  });
  return state.pumpRuntime[key];
}

function trackPumpRuntime(nextPumps, timestamp = Date.now()) {
  const elapsed = timestamp - pumpRuntimeLastAt;
  // Evita contabilizar como funcionamento o tempo em que a página ficou
  // suspensa/desconectada. Consideramos no máximo três ciclos de polling.
  const safeElapsed = Math.max(0, Math.min(elapsed, AQUAFLOW_CONFIG.pollIntervalMs * 3));
  const day = ensurePumpRuntimeDay(localDateKey(pumpRuntimeLastAt));

  Object.entries(pumpRuntimeLastStates).forEach(([id, wasOn]) => {
    if (wasOn) day[id] += safeElapsed;
  });

  pumpRuntimeLastAt = timestamp;
  pumpRuntimeLastStates = Object.fromEntries(nextPumps.map(pump => [pump.id, pump.on]));
  savePumpRuntime();
}

function applyAuthoritativePumpRuntime(runtimeMs, timestamp = Date.now()) {
  if (!runtimeMs) return;
  const day = ensurePumpRuntimeDay(localDateKey(timestamp));
  ['B1', 'B2', 'B3', 'B4'].forEach(id => {
    if (Number.isFinite(Number(runtimeMs[id]))) day[id] = Math.max(0, Number(runtimeMs[id]));
  });
  savePumpRuntime();
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function navigateTo(page) {
  const file = PAGE_FILES[page];
  if (file) window.location.href = file;
}

// -----------------------------------------------------------------------------
// CONTRATO DE DADOS
// -----------------------------------------------------------------------------
/*
  Formato recomendado para GET /api/status no ESP32:

  {
    "online": true,
    "mode": "automatico",
    "supplyRunning": true,
    "reservoirs": {
      "principal": { "level": 78, "liters": 3900, "capacity": 5000 },
      "reserva":   { "level": 55, "liters": 1100, "capacity": 2000 }
    },
    "pumps": {
      "B1": true,
      "B2": false,
      "B3": false,
      "B4": true
    },
    "sensors": { "online": 4, "total": 4 },
    "alerts": []
  }

  Alguns aliases comuns também são aceitos para facilitar a primeira integração
  com o código do ESP32 (ex.: nivelPrincipal, reservatorioPrincipal.nivel etc.).
*/
function normalizeReservoir(raw, key, fallback) {
  const node = raw?.reservoirs?.[key]
    ?? raw?.[key]
    ?? raw?.[key === 'principal' ? 'reservatorioPrincipal' : 'reservatorioReserva']
    ?? {};

  const level = firstDefined(
    node.level, node.nivel, node.percent, node.porcentagem,
    raw?.[key === 'principal' ? 'nivelPrincipal' : 'nivelReserva'],
    fallback.level
  );

  const capacity = Number(firstDefined(node.capacity, node.capacidade, fallback.capacity));
  const liters = Number(firstDefined(
    node.liters, node.litros, node.volume,
    capacity * clamp(level) / 100
  ));

  return { level: clamp(level), liters, capacity };
}

function normalizePumps(raw) {
  const incoming = raw?.pumps ?? raw?.bombas;
  if (!incoming) return state.pumps;

  const baseFlows = Object.fromEntries(state.pumps.map(p => [p.id, p.flow]));
  const ids = ['B1', 'B2', 'B3', 'B4'];

  if (Array.isArray(incoming)) {
    return ids.map((id, index) => {
      const item = incoming.find(p => String(p.id || p.nome || '').toUpperCase() === id) ?? incoming[index] ?? {};
      return {
        id,
        flow: item.flow || item.fluxo || item.funcao || baseFlows[id],
        on: toBool(firstDefined(item.on, item.status, item.ligada, false), false),
        mode: item.mode || item.modo || (state.mode === 'automatico' ? 'Automático' : 'Manual')
      };
    });
  }

  return ids.map(id => {
    const item = incoming[id] ?? incoming[id.toLowerCase()];
    const on = typeof item === 'object'
      ? toBool(firstDefined(item.on, item.status, item.ligada, false), false)
      : toBool(item, false);
    return {
      id,
      flow: typeof item === 'object' ? (item.flow || item.fluxo || item.funcao || baseFlows[id]) : baseFlows[id],
      on,
      mode: typeof item === 'object' ? (item.mode || item.modo || (state.mode === 'automatico' ? 'Automático' : 'Manual')) : (state.mode === 'automatico' ? 'Automático' : 'Manual')
    };
  });
}

function extractPumpRuntimeToday(raw = {}) {
  // Formatos aceitos do ESP32 (todos opcionais):
  // pumpRuntimeMs: { B1: 120000, ... }
  // pumpRuntimeSeconds: { B1: 120, ... }
  // ou dentro de pumps.B1: { runtimeSecondsToday: 120 }.
  const directMs = raw.pumpRuntimeMs ?? raw.tempoBombasMs;
  const directSeconds = raw.pumpRuntimeSeconds ?? raw.tempoBombasSegundos;
  const result = {};
  let found = false;

  ['B1', 'B2', 'B3', 'B4'].forEach(id => {
    const pumpNode = raw?.pumps?.[id] ?? raw?.bombas?.[id] ?? {};
    const ms = firstDefined(
      directMs?.[id],
      Number.isFinite(Number(directSeconds?.[id])) ? Number(directSeconds[id]) * 1000 : undefined,
      pumpNode.runtimeMsToday,
      pumpNode.tempoMsHoje,
      Number.isFinite(Number(pumpNode.runtimeSecondsToday)) ? Number(pumpNode.runtimeSecondsToday) * 1000 : undefined,
      Number.isFinite(Number(pumpNode.tempoSegundosHoje)) ? Number(pumpNode.tempoSegundosHoje) * 1000 : undefined
    );
    if (ms !== undefined && ms !== null && Number.isFinite(Number(ms))) {
      result[id] = Number(ms);
      found = true;
    }
  });

  return found ? result : null;
}

function normalizeTelemetry(raw = {}) {
  const principal = normalizeReservoir(raw, 'principal', state.reservoirs.principal);
  const reserva = normalizeReservoir(raw, 'reserva', state.reservoirs.reserva);
  const modeRaw = String(firstDefined(raw.mode, raw.modo, state.mode)).toLowerCase();

  return {
    connected: toBool(firstDefined(raw.online, raw.connected, true), true),
    lastUpdate: raw.timestamp ? new Date(raw.timestamp) : new Date(),
    mode: modeRaw.includes('manual') ? 'manual' : 'automatico',
    supplyRunning: toBool(firstDefined(raw.supplyRunning, raw.abastecimentoAtivo, raw.abastecimento, state.supplyRunning), state.supplyRunning),
    sensors: {
      online: Number(firstDefined(raw?.sensors?.online, raw?.sensores?.online, state.sensors.online)),
      total: Number(firstDefined(raw?.sensors?.total, raw?.sensores?.total, state.sensors.total))
    },
    reservoirs: { principal, reserva },
    sourceStatus: {
      flowing: toBool(firstDefined(raw?.source?.flowing, raw?.fonte?.enviando, raw?.fonteAtiva, state.sourceStatus.flowing), state.sourceStatus.flowing),
      label: firstDefined(raw?.source?.label, raw?.fonte?.status, state.sourceStatus.label)
    },
    condominiumStatus: {
      normal: toBool(firstDefined(raw?.condominium?.normal, raw?.condominio?.normal, true), true),
      label: firstDefined(raw?.condominium?.label, raw?.condominio?.status, state.condominiumStatus.label)
    },
    pumps: normalizePumps(raw),
    pumpRuntimeTodayMs: extractPumpRuntimeToday(raw),
    alerts: Array.isArray(raw.alerts) ? raw.alerts : Array.isArray(raw.alertas) ? raw.alertas : null
  };
}

// -----------------------------------------------------------------------------
// CLIENTE ESP32
// -----------------------------------------------------------------------------
class AquaFlowGateway {
  constructor(config) {
    this.config = config;
    this.pollTimer = null;
    this.mockTimer = null;
    this.socket = null;
    this.failedAttempts = 0;
  }

  get baseUrl() {
    const query = new URLSearchParams(window.location.search).get('esp');
    if (query) {
      const normalized = /^https?:\/\//.test(query) ? query : `http://${query}`;
      localStorage.setItem('aquaflow.espBaseUrl', normalized.replace(/\/$/, ''));
      return normalized.replace(/\/$/, '');
    }
    return (localStorage.getItem('aquaflow.espBaseUrl') || this.config.espBaseUrl).replace(/\/$/, '');
  }

  start() {
    if (this.config.transport === 'mock') {
      this.startMock();
      return;
    }
    if (this.config.transport === 'websocket') {
      this.startWebSocket();
      return;
    }
    // "auto" e "http" usam polling. No modo auto o mock entra como fallback.
    this.poll();
  }

  async poll() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      const response = await fetch(`${this.baseUrl}${this.config.statusPath}`, {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      this.failedAttempts = 0;
      this.stopMock();
      applyTelemetry(payload, 'esp32');
    } catch (error) {
      this.failedAttempts += 1;
      markDisconnected();
      if (this.config.fallbackToMock && this.config.transport === 'auto' && this.failedAttempts >= 2) {
        this.startMock();
      }
    } finally {
      this.pollTimer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
    }
  }

  startWebSocket() {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    this.socket = new WebSocket(`${wsBase}${this.config.websocketPath}`);
    this.socket.addEventListener('message', event => {
      try { applyTelemetry(JSON.parse(event.data), 'esp32'); }
      catch (error) { console.error('AquaFlow: JSON WebSocket inválido.', error); }
    });
    this.socket.addEventListener('open', () => { this.stopMock(); setConnection('esp32', true); });
    this.socket.addEventListener('close', () => {
      markDisconnected();
      if (this.config.fallbackToMock) this.startMock();
      setTimeout(() => this.startWebSocket(), 3000);
    });
    this.socket.addEventListener('error', () => this.socket?.close());
  }

  startMock() {
    if (this.mockTimer) return;
    state.source = 'mock';
    setConnection('mock', true);
    renderAll();
    this.mockTimer = setInterval(() => {
      simulateMockTick();
      state.lastUpdate = new Date();
      recordSample();
      renderAll();
    }, this.config.pollIntervalMs);
  }

  stopMock() {
    if (this.mockTimer) clearInterval(this.mockTimer);
    this.mockTimer = null;
  }

  async sendCommand(command) {
    if (state.source === 'mock' || this.config.transport === 'mock') {
      applyMockCommand(command);
      renderAll();
      return { ok: true, mock: true };
    }

    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(command));
      return { ok: true };
    }

    const response = await fetch(`${this.baseUrl}${this.config.commandPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.headers.get('content-type')?.includes('application/json') ? response.json() : { ok: true };
  }
}

const gateway = new AquaFlowGateway(AQUAFLOW_CONFIG);

// -----------------------------------------------------------------------------
// APLICAÇÃO DA TELEMETRIA RECEBIDA
// -----------------------------------------------------------------------------
function applyTelemetry(raw, source) {
  const data = normalizeTelemetry(raw);
  state.source = source;
  state.connected = data.connected;
  state.lastUpdate = data.lastUpdate;
  state.mode = data.mode;
  state.supplyRunning = data.supplyRunning;
  state.sensors = data.sensors;
  state.reservoirs = data.reservoirs;
  state.sourceStatus = data.sourceStatus;
  state.condominiumStatus = data.condominiumStatus;
  trackPumpRuntime(data.pumps, Date.now());
  state.pumps = data.pumps;
  applyAuthoritativePumpRuntime(data.pumpRuntimeTodayMs, Date.now());
  if (data.alerts) state.alerts = normalizeAlerts(data.alerts);
  else if (source === 'esp32') state.alerts = [];

  setConnection(source, data.connected);
  recordSample();
  renderAll();
}

function setConnection(source, connected) {
  state.source = source;
  state.connected = connected;
  const chip = document.getElementById('connectionChip');
  const footer = document.getElementById('connectionState');
  const dot = document.getElementById('connectionDot');

  const label = source === 'mock'
    ? 'Modo simulação'
    : connected ? 'ESP32 conectado' : 'ESP32 desconectado';

  if (chip) {
    chip.textContent = label;
    chip.classList.toggle('is-online', source === 'esp32' && connected);
    chip.classList.toggle('is-offline', source === 'esp32' && !connected);
    chip.classList.toggle('is-mock', source === 'mock');
  }
  if (footer) {
    // Mantém os ícones existentes e substitui apenas o texto final.
    const textNode = [...footer.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    if (textNode) textNode.textContent = label;
  }
  if (dot) {
    dot.classList.toggle('status-dot--ok', connected || source === 'mock');
    dot.classList.toggle('status-dot--off', !connected && source !== 'mock');
  }
}

function markDisconnected() {
  if (state.source !== 'mock') setConnection('esp32', false);
}

function recordSample() {
  const now = Date.now();
  if (now - lastSampleAt < AQUAFLOW_CONFIG.sampleIntervalMs) return;
  lastSampleAt = now;

  // Se o usuário estiver olhando uma janela antiga, preservamos a posição
  // visual enquanto novas leituras chegam no fim do histórico.
  if (liveChartOffset > 0) liveChartOffset += 1;

  state.samples.push({
    time: now,
    principal: state.reservoirs.principal.level,
    reserva: state.reservoirs.reserva.level,
    activePumps: state.pumps.filter(p => p.on).length,
    source: state.source
  });
  state.samples = state.samples.slice(-AQUAFLOW_CONFIG.historyLimit);
  liveChartOffset = Math.min(liveChartOffset, Math.max(0, state.samples.length - LIVE_CHART_WINDOW));
  saveSamples();
}

// -----------------------------------------------------------------------------
// MOCK: simula o mesmo tipo de dado que será enviado pelo ESP32.
// Ele existe somente para o front continuar demonstrável sem o hardware ligado.
// -----------------------------------------------------------------------------
function simulateMockTick() {
  const p = state.reservoirs.principal;
  const r = state.reservoirs.reserva;
  const pump = Object.fromEntries(state.pumps.map(item => [item.id, item]));

  if (state.mode === 'automatico') {
    pump.B1.on = p.level < 88;
    pump.B2.on = p.level > 65 && r.level < 72;
    pump.B3.on = r.level > 65 && p.level < 35;
    pump.B4.on = p.level > 18;
  }

  p.level = clamp(p.level + (pump.B1.on ? .8 : 0) - (pump.B2.on ? .45 : 0) - (pump.B4.on ? .35 : 0));
  r.level = clamp(r.level + (pump.B2.on ? .65 : 0) - (pump.B3.on ? .55 : 0));
  p.liters = Math.round(p.capacity * p.level / 100);
  r.liters = Math.round(r.capacity * r.level / 100);
  state.supplyRunning = state.pumps.some(item => item.on);
  state.alerts = deriveAlerts();
}

function applyMockCommand(command) {
  if (command.type === 'pump') {
    const pump = state.pumps.find(p => p.id === command.id);
    if (pump) pump.on = command.action === 'on';
  }
  if (command.type === 'mode') {
    state.mode = command.value === 'manual' ? 'manual' : 'automatico';
    state.pumps.forEach(p => p.mode = state.mode === 'manual' ? 'Manual' : 'Automático');
  }
  if (command.type === 'system') {
    state.supplyRunning = command.action === 'start';
    if (command.action === 'stop') state.pumps.forEach(p => p.on = false);
    if (command.action === 'start') state.pumps[0].on = true;
  }
}

function commandLabel(command) {
  if (command.type === 'pump') return `${command.id} ${command.action === 'on' ? 'ligada' : 'desligada'}`;
  if (command.type === 'mode') return `Modo ${command.value === 'manual' ? 'Manual' : 'Automático'} ativado`;
  if (command.type === 'system') return command.action === 'start' ? 'Abastecimento iniciado' : 'Abastecimento parado';
  return 'Comando enviado';
}

// -----------------------------------------------------------------------------
// RENDERIZAÇÃO — RESERVATÓRIOS E RESUMOS
// -----------------------------------------------------------------------------
function reservoirStatus(level) {
  if (level <= 20) return { label: 'Nível crítico', kind: 'critical' };
  if (level <= 35) return { label: 'Nível baixo', kind: 'warning' };
  if (level >= 95) return { label: 'Reservatório cheio', kind: 'ok' };
  return { label: 'Nível adequado', kind: 'ok' };
}

function renderReservoirs() {
  ['principal', 'reserva'].forEach(key => {
    const data = state.reservoirs[key];
    const status = reservoirStatus(data.level);

    document.querySelectorAll(`[data-water-gauge="${key}"]`).forEach(gauge => {
      gauge.style.setProperty('--level', data.level.toFixed(1));
      gauge.classList.toggle('is-critical', status.kind === 'critical');
      gauge.classList.toggle('is-warning', status.kind === 'warning');
      gauge.setAttribute('aria-label', `${key === 'principal' ? 'Reservatório principal' : 'Reservatório reserva'} em ${Math.round(data.level)} por cento`);
    });
    document.querySelectorAll(`[data-reservoir-level="${key}"]`).forEach(el => el.textContent = `${Math.round(data.level)}%`);
    document.querySelectorAll(`[data-reservoir-liters="${key}"]`).forEach(el => el.textContent = formatNumber(data.liters));
    document.querySelectorAll(`[data-reservoir-capacity="${key}"]`).forEach(el => el.textContent = `${formatNumber(data.capacity)} L`);
    document.querySelectorAll(`[data-reservoir-current="${key}"]`).forEach(el => el.textContent = `${formatNumber(data.liters)} L`);
    document.querySelectorAll(`[data-reservoir-volume-line="${key}"]`).forEach(line => {
      const strong = line.querySelector('strong');
      line.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE && node.textContent.includes(' de ')) {
          node.textContent = ` de ${formatNumber(data.capacity)} L`;
        }
      });
      if (strong) strong.textContent = formatNumber(data.liters);
    });
    document.querySelectorAll(`[data-reservoir-status="${key}"]`).forEach(el => {
      el.innerHTML = `<span class="status-dot ${status.kind === 'ok' ? 'status-dot--ok' : status.kind === 'warning' ? 'status-dot--warning' : 'status-dot--danger'}"></span>${status.label}`;
    });
    document.querySelectorAll(`[data-summary-level="${key}"]`).forEach(el => el.textContent = `${Math.round(data.level)}%`);
  });
}

function renderSummaries() {
  const activePumps = state.pumps.filter(p => p.on).length;
  const connection = document.querySelector('[data-connection-summary]');
  const operation = document.querySelector('[data-system-operation]');
  const sensors = document.querySelector('[data-sensors-online]');
  const updateAge = document.querySelector('[data-update-age]');

  if (connection) {
    connection.textContent = state.source === 'mock' ? 'Simulação' : state.connected ? 'Online' : 'Offline';
    connection.classList.toggle('text-green', state.connected || state.source === 'mock');
    connection.classList.toggle('text-red', !state.connected && state.source !== 'mock');
  }
  if (operation) operation.textContent = deriveAlerts().some(a => a.severity === 'critical') ? 'Requer atenção' : 'Operando Normalmente';
  document.querySelectorAll('[data-active-pumps]').forEach(el => el.textContent = `${activePumps} de ${state.pumps.length}`);
  if (sensors) sensors.textContent = `${state.sensors.online} de ${state.sensors.total}`;
  if (updateAge) updateAge.textContent = state.lastUpdate ? `Agora · ${nowTime(state.lastUpdate)}` : 'Aguardando leitura';

  const mode = document.getElementById('modeSummary');
  const supply = document.getElementById('supplySummary');
  const active = document.getElementById('activePumpsSummary');
  const modeAutoIcon = document.getElementById('modeSummaryAutoIcon');
  const modeManualIcon = document.getElementById('modeSummaryManualIcon');
  if (mode) mode.textContent = state.mode === 'automatico' ? 'Automático' : 'Manual';
  if (supply) supply.textContent = state.supplyRunning ? 'Em operação' : 'Parado';
  if (active) active.textContent = `${activePumps} de ${state.pumps.length}`;
  if (modeAutoIcon && modeManualIcon) {
    const isManual = state.mode === 'manual';
    modeAutoIcon.classList.toggle('is-hidden', isManual);
    modeManualIcon.classList.toggle('is-hidden', !isManual);
  }

  document.querySelectorAll('[data-last-update]').forEach(el => el.textContent = state.lastUpdate ? nowTime(state.lastUpdate) : '—');
}

function renderOperationalStates() {
  const sourceBox = document.querySelector('[data-source-state]');
  const sourceLabel = document.querySelector('[data-source-label]');
  const sourceDetail = document.querySelector('[data-source-detail]');
  if (sourceBox) {
    sourceBox.classList.toggle('state-box--success', state.sourceStatus.flowing);
  }
  if (sourceLabel) sourceLabel.textContent = state.sourceStatus.label || (state.sourceStatus.flowing ? 'Enviando água' : 'Fonte parada');
  if (sourceDetail) sourceDetail.textContent = state.sourceStatus.flowing ? 'Captação em funcionamento' : 'Sem fluxo no momento';

  const condoBox = document.querySelector('[data-condo-state]');
  const condoLabel = document.querySelector('[data-condo-label]');
  const condoDetail = document.querySelector('[data-condo-detail]');
  if (condoBox) condoBox.classList.toggle('state-box--success', state.condominiumStatus.normal);
  if (condoLabel) condoLabel.textContent = state.condominiumStatus.label || (state.condominiumStatus.normal ? 'Abastecimento normal' : 'Abastecimento irregular');
  if (condoDetail) condoDetail.textContent = state.condominiumStatus.normal ? 'Condomínio sendo abastecido normalmente' : 'Verifique o sistema de distribuição';

  const systemStatus = document.querySelector('[data-system-status]');
  if (systemStatus) {
    const critical = deriveAlerts().some(a => a.severity === 'critical');
    systemStatus.textContent = critical ? 'Atenção' : 'Normal';
    systemStatus.classList.toggle('text-red', critical);
    systemStatus.classList.toggle('text-green', !critical);
  }
}

function renderReadings() {
  document.querySelectorAll('[data-reading="principal"]').forEach(el => el.textContent = `${Math.round(state.reservoirs.principal.level)}%`);
  document.querySelectorAll('[data-reading="reserva"]').forEach(el => el.textContent = `${Math.round(state.reservoirs.reserva.level)}%`);
  document.querySelectorAll('[data-source-reading]').forEach(el => el.textContent = state.sourceStatus.flowing ? 'Normal' : 'Parada');
  document.querySelectorAll('[data-reading-time]').forEach(el => el.textContent = state.lastUpdate ? nowTime(state.lastUpdate) : '—');
}

function getControlMessageState() {
  // No modo de simulação, os alertas demonstrativos da página "Alertas" não
  // devem transformar a tela de Controle em estado de atenção. Aqui usamos
  // somente ocorrências reais recebidas do ESP32 ou regras locais de nível.
  const alerts = state.alerts.length ? state.alerts : deriveAlerts();
  const hasCritical = alerts.some(alert => alert.status !== 'resolvido' && alert.severity === 'critical');
  const hasWarning = alerts.some(alert => alert.status !== 'resolvido' && alert.severity === 'warning');
  const principalLevel = Number(state.reservoirs.principal.level) || 0;
  const reservaLevel = Number(state.reservoirs.reserva.level) || 0;

  if ((!state.connected && state.source !== 'mock') || hasCritical || principalLevel <= 20 || reservaLevel <= 20) {
    const lowerReservoir = principalLevel <= reservaLevel ? 'principal' : 'reserva';
    const lowerLevel = Math.min(principalLevel, reservaLevel);
    const detail = !state.connected && state.source !== 'mock'
      ? 'Sem resposta do ESP32. Verifique a conexão antes de enviar novos comandos.'
      : `O reservatório ${lowerReservoir} está em ${Math.round(lowerLevel)}%. Verifique os níveis antes de iniciar ou manter o abastecimento.`;

    return {
      className: 'message message--warning',
      title: '▲ Atenção aos reservatórios',
      description: detail
    };
  }

  if (hasWarning || state.mode === 'manual' || principalLevel <= 35 || reservaLevel <= 35) {
    const detail = state.mode === 'manual'
      ? 'O sistema está em modo manual. Comandos críticos pedem confirmação antes da execução.'
      : 'O sistema segue protegido e requer acompanhamento dos níveis para evitar oscilações.';

    return {
      className: 'message message--info',
      title: 'ℹ Controle moderado',
      description: detail
    };
  }

  return {
    className: 'message message--success',
    title: '✓ Sistema operacional',
    description: 'Todos os comandos estão respondendo normalmente.'
  };
}

function renderControlMessages() {
  const container = document.getElementById('controlMessagesContainer');
  if (!container) return;

  const message = getControlMessageState();
  container.innerHTML = `<div class="${message.className}"><strong>${message.title}</strong><small>${message.description}</small></div>`;
}

// -----------------------------------------------------------------------------
// BOMBAS / COMANDOS
// -----------------------------------------------------------------------------
function renderPumpTables() {
  document.querySelectorAll('[data-pump-table]').forEach(tbody => {
    const context = tbody.dataset.pumpTable;
    tbody.innerHTML = state.pumps.map(pump => {
      const statusText = pump.on ? 'Ligada' : 'Desligada';
      const statusClass = pump.on ? 'pill--on' : 'pill--off';
      const button = `<button class="switch ${pump.on ? 'is-on' : ''}" type="button" data-pump-toggle="${pump.id}" aria-label="${pump.on ? 'Desligar' : 'Ligar'} ${pump.id}" aria-pressed="${pump.on}"></button>`;
      if (context === 'controle') {
        return `<tr><td>${pump.id}</td><td class="pump-function"><strong>${pump.flow}</strong><small>${pump.on ? 'Em operação' : 'Aguardando'}</small></td><td><span class="control-state-wrap"><span class="status-dot ${pump.on ? 'status-dot--ok' : 'status-dot--off'}"></span><span class="pill ${statusClass}">${statusText}</span></span></td><td><span class="pill pill--mode">${pump.mode}</span></td><td>${button}</td></tr>`;
      }
      return `<tr><td>${pump.id}</td><td>${pump.flow}</td><td><span class="state-cell"><span class="status-dot ${pump.on ? 'status-dot--ok' : 'status-dot--off'}"></span><span class="pill ${statusClass}">${statusText}</span></span></td><td>${button}</td></tr>`;
    }).join('');
  });
}

const MOCK_COMMAND_LOG = [
  { text: 'Sistema alterado para modo Automático', by: 'Administrador', time: '10:22', danger: false },
  { text: 'Bomba B1 desligada', by: 'Administrador', time: '10:18', danger: true },
  { text: 'Bomba B1 ligada', by: 'Administrador', time: '08:45', danger: false },
  { text: 'Abastecimento iniciado', by: 'Administrador', time: '08:30', danger: false },
  { text: 'Abastecimento parado', by: 'Administrador', time: '08:15', danger: true }
];

function addCommand(text, danger = false) {
  state.commandLog.unshift({ text, by: 'Administrador', time: nowTime(), danger });
  state.commandLog = state.commandLog.slice(0, 5);
  renderCommandTimeline();
}

function renderCommandTimeline() {
  const target = document.getElementById('commandTimeline');
  if (!target) return;
  const onlyInitialEntry = state.commandLog.length === 1 && state.commandLog[0]?.text === 'Interface AquaFlow iniciada';
  const items = state.source === 'mock' && onlyInitialEntry ? MOCK_COMMAND_LOG : state.commandLog;
  target.innerHTML = items.map(item => `<li class="timeline-item"><span class="timeline-item__dot ${item.danger ? 'timeline-item__dot--danger' : ''}"></span><div><strong>${item.text}</strong><small>Por: ${item.by}</small></div><time>${item.time}</time></li>`).join('');
}

function requestConfirmation({ title, message, onConfirm }) {
  const dialog = document.getElementById('confirmDialog');
  const titleEl = document.getElementById('confirmTitle');
  const messageEl = document.getElementById('confirmMessage');
  pendingAction = onConfirm;
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (dialog?.showModal) dialog.showModal();
  else if (window.confirm(message)) onConfirm();
}

async function sendUiCommand(command) {
  try {
    await gateway.sendCommand(command);
    addCommand(commandLabel(command), command.action === 'off' || command.action === 'stop');
    showToast(state.source === 'mock' ? 'Comando aplicado na simulação.' : 'Comando enviado ao ESP32.');
  } catch (error) {
    console.error(error);
    showToast('Não foi possível enviar o comando ao ESP32.');
  }
}

// -----------------------------------------------------------------------------
// GRÁFICOS E HISTÓRICO
// -----------------------------------------------------------------------------
function seriesPoints(values, width, height, pad = 20) {
  if (!values.length) return '';
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;
  return values.map((value, index) => {
    const x = pad + (values.length === 1 ? usableW / 2 : usableW * index / (values.length - 1));
    const y = pad + usableH * (1 - clamp(value) / 100);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function liveChartSamples() {
  // Evita misturar valores simulados com dados reais no mesmo gráfico.
  // Amostras antigas sem o campo source são tratadas como mock por compatibilidade.
  const source = state.source === 'esp32' ? 'esp32' : 'mock';
  return state.samples.filter(sample => (sample.source || 'mock') === source);
}

function getLiveChartWindow() {
  const samples = liveChartSamples();
  const maxOffset = Math.max(0, samples.length - LIVE_CHART_WINDOW);
  liveChartOffset = Math.min(Math.max(0, liveChartOffset), maxOffset);

  const end = samples.length - liveChartOffset;
  const start = Math.max(0, end - LIVE_CHART_WINDOW);
  return { samples, visible: samples.slice(start, end), start, end, maxOffset };
}

function monitorChartCoordinates(samples, key) {
  const left = 46;
  const right = 704;
  const top = 20;
  const bottom = 200;
  const width = right - left;
  const height = bottom - top;

  return samples.map((sample, index) => ({
    x: samples.length === 1 ? (left + right) / 2 : left + width * index / (samples.length - 1),
    y: top + height * (1 - clamp(sample[key]) / 100),
    value: clamp(sample[key]),
    time: sample.time
  }));
}

function svgPointList(points) {
  return points.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

function renderMonitorChart() {
  const chart = document.querySelector('[data-live-chart]');
  if (!chart) return;

  const { samples, visible, start, end, maxOffset } = getLiveChartWindow();
  const principal = monitorChartCoordinates(visible, 'principal');
  const reserva = monitorChartCoordinates(visible, 'reserva');

  document.querySelectorAll('[data-live-series="principal"]').forEach(el => el.setAttribute('points', svgPointList(principal)));
  document.querySelectorAll('[data-live-series="reserva"]').forEach(el => el.setAttribute('points', svgPointList(reserva)));

  renderLiveChartPointGroup('principal', principal, 'Reservatório Principal');
  renderLiveChartPointGroup('reserva', reserva, 'Reservatório Reserva');
  renderLiveChartAxisLabels(visible, principal);

  const empty = document.querySelector('[data-live-chart-empty]');
  if (empty) empty.hidden = visible.length > 0;

  const range = document.querySelector('[data-live-chart-range]');
  if (range) {
    if (!visible.length) {
      range.textContent = 'Sem leituras';
    } else if (liveChartOffset === 0) {
      range.textContent = `Mais recentes · ${nowTime(new Date(visible[0].time))}–${nowTime(new Date(visible.at(-1).time))}`;
    } else {
      range.textContent = `${nowTime(new Date(visible[0].time))}–${nowTime(new Date(visible.at(-1).time))}`;
    }
  }

  const prev = document.querySelector('[data-live-chart-prev]');
  const next = document.querySelector('[data-live-chart-next]');
  const nowButton = document.querySelector('[data-live-chart-now]');
  if (prev) prev.disabled = start === 0;
  if (next) next.disabled = liveChartOffset === 0;
  if (nowButton) nowButton.disabled = liveChartOffset === 0;

  // Caso o limite de histórico seja atingido, o offset nunca pode apontar para
  // uma faixa que já foi descartada do localStorage.
  if (liveChartOffset > maxOffset) liveChartOffset = maxOffset;
}

function renderLiveChartPointGroup(key, points, label) {
  const group = document.querySelector(`[data-live-points="${key}"]`);
  if (!group) return;

  const pointClass = key === 'principal' ? 'chart-point--blue' : 'chart-point--orange';
  group.innerHTML = points.map((point, index) => `
    <circle
      class="chart-point ${pointClass}"
      cx="${point.x.toFixed(1)}"
      cy="${point.y.toFixed(1)}"
      r="5"
      tabindex="0"
      role="button"
      aria-label="${label}: ${Math.round(point.value)}%, às ${nowTime(new Date(point.time))}"
      data-chart-point
      data-series-label="${label}"
      data-level="${Math.round(point.value)}"
      data-time="${point.time}"
      data-point-index="${index}">
    </circle>`).join('');
}

function renderLiveChartAxisLabels(samples, coordinates) {
  const group = document.querySelector('[data-live-axis-labels]');
  if (!group) return;
  if (!samples.length) {
    group.innerHTML = '';
    return;
  }

  // Mostra no máximo quatro horários para evitar poluição visual em telas menores.
  const wanted = new Set([0, samples.length - 1]);
  if (samples.length >= 4) {
    wanted.add(Math.round((samples.length - 1) / 3));
    wanted.add(Math.round((samples.length - 1) * 2 / 3));
  }

  group.innerHTML = [...wanted].sort((a, b) => a - b).map(index => {
    const point = coordinates[index] || { x: 46 };
    const label = nowTime(new Date(samples[index].time)).slice(0, 5);
    return `<text class="chart-axis-time" x="${point.x.toFixed(1)}" y="218" text-anchor="middle">${label}</text>`;
  }).join('');
}

function showLiveChartTooltip(point, clientX, clientY, pinned = false) {
  const chart = document.querySelector('[data-live-chart]');
  const tooltip = document.querySelector('[data-live-chart-tooltip]');
  if (!chart || !tooltip || !point) return;

  const level = Number(point.dataset.level) || 0;
  const time = new Date(Number(point.dataset.time));
  tooltip.innerHTML = `<strong>${point.dataset.seriesLabel}</strong><span>${Math.round(level)}%</span><small>${time.toLocaleString('pt-BR')}</small>`;
  tooltip.hidden = false;

  const rect = chart.getBoundingClientRect();
  const left = Math.min(Math.max(10, clientX - rect.left + 12), Math.max(10, rect.width - 190));
  const top = Math.max(8, clientY - rect.top - 76);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  liveChartTooltipPinned = pinned;
}

function hideLiveChartTooltip(force = false) {
  if (liveChartTooltipPinned && !force) return;
  const tooltip = document.querySelector('[data-live-chart-tooltip]');
  if (tooltip) tooltip.hidden = true;
  if (force) liveChartTooltipPinned = false;
}


function getHistoryChartWindow() {
  const samples = liveChartSamples();
  const maxOffset = Math.max(0, samples.length - HISTORY_CHART_WINDOW);
  historyChartOffset = Math.min(Math.max(0, historyChartOffset), maxOffset);

  const end = samples.length - historyChartOffset;
  const start = Math.max(0, end - HISTORY_CHART_WINDOW);
  return { samples, visible: samples.slice(start, end), start, end, maxOffset };
}

function historyChartCoordinates(samples, key) {
  const left = 40;
  const right = 500;
  const top = 20;
  const bottom = 180;
  const width = right - left;
  const height = bottom - top;

  return samples.map((sample, index) => ({
    x: samples.length === 1 ? (left + right) / 2 : left + width * index / (samples.length - 1),
    y: top + height * (1 - clamp(sample[key]) / 100),
    value: clamp(sample[key]),
    time: sample.time
  }));
}

function renderHistoryPointGroup(key, points, label) {
  const group = document.querySelector(`[data-history-points="${key}"]`);
  if (!group) return;

  const pointClass = key === 'principal' ? 'chart-point--blue' : 'chart-point--orange';
  group.innerHTML = points.map((point, index) => `
    <circle
      class="chart-point ${pointClass}"
      cx="${point.x.toFixed(1)}"
      cy="${point.y.toFixed(1)}"
      r="5"
      tabindex="0"
      role="button"
      aria-label="${label}: ${Math.round(point.value)}%, em ${new Date(point.time).toLocaleString('pt-BR')}"
      data-history-chart-point
      data-series-key="${key}"
      data-series-label="${label}"
      data-level="${Math.round(point.value)}"
      data-time="${point.time}"
      data-point-index="${index}">
    </circle>`).join('');
}

function renderHistoryAxisLabels(samples, coordinates, key) {
  const group = document.querySelector(`[data-history-axis-labels="${key}"]`);
  if (!group) return;
  if (!samples.length) {
    group.innerHTML = '';
    return;
  }

  // Mostra poucos rótulos no eixo X para manter a leitura limpa em desktop e mobile.
  const wanted = new Set([0, samples.length - 1]);
  if (samples.length >= 4) {
    wanted.add(Math.round((samples.length - 1) / 3));
    wanted.add(Math.round((samples.length - 1) * 2 / 3));
  }

  const firstDay = new Date(samples[0].time).toDateString();
  const sameDay = samples.every(sample => new Date(sample.time).toDateString() === firstDay);

  group.innerHTML = [...wanted].sort((a, b) => a - b).map(index => {
    const point = coordinates[index] || { x: 40 };
    const date = new Date(samples[index].time);
    const label = sameDay
      ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    return `<text class="chart-axis-time" x="${point.x.toFixed(1)}" y="214" text-anchor="middle">${label}</text>`;
  }).join('');
}

function formatHistoryRange(samples, offset) {
  if (!samples.length) return 'Sem leituras';
  const start = new Date(samples[0].time);
  const end = new Date(samples.at(-1).time);
  const sameDay = start.toDateString() === end.toDateString();

  if (sameDay) {
    const startTime = start.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const endTime = end.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${offset === 0 ? 'Mais recentes · ' : ''}${startTime}–${endTime}`;
  }

  const startLabel = start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const endLabel = end.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return `${offset === 0 ? 'Mais recentes · ' : ''}${startLabel}–${endLabel}`;
}

function renderHistoryCharts() {
  const charts = document.querySelectorAll('[data-history-chart]');
  if (!charts.length) return;

  const { visible, start, maxOffset } = getHistoryChartWindow();
  const series = [
    { key: 'principal', label: 'Reservatório Principal' },
    { key: 'reserva', label: 'Reservatório Reserva' }
  ];

  series.forEach(({ key, label }) => {
    const points = historyChartCoordinates(visible, key);
    document.querySelectorAll(`[data-history-series="${key}"]`).forEach(el => {
      el.setAttribute('points', svgPointList(points));
    });
    renderHistoryPointGroup(key, points, label);
    renderHistoryAxisLabels(visible, points, key);

    document.querySelectorAll(`[data-history-chart-empty="${key}"]`).forEach(el => {
      el.hidden = visible.length > 0;
    });
  });

  document.querySelectorAll('[data-history-chart-range]').forEach(el => {
    el.textContent = formatHistoryRange(visible, historyChartOffset);
  });

  document.querySelectorAll('[data-history-chart-prev]').forEach(button => {
    button.disabled = start === 0;
  });
  document.querySelectorAll('[data-history-chart-next]').forEach(button => {
    button.disabled = historyChartOffset === 0;
  });
  document.querySelectorAll('[data-history-chart-now]').forEach(button => {
    button.disabled = historyChartOffset === 0;
  });

  if (historyChartOffset > maxOffset) historyChartOffset = maxOffset;
}

function showHistoryChartTooltip(chart, point, clientX, clientY, pinned = false) {
  if (!chart || !point) return;
  const key = chart.dataset.historyChart;
  const tooltip = chart.querySelector(`[data-history-chart-tooltip="${key}"]`);
  if (!tooltip) return;

  const level = Number(point.dataset.level) || 0;
  const time = new Date(Number(point.dataset.time));
  tooltip.dataset.series = point.dataset.seriesKey;
  tooltip.innerHTML = `<strong>${point.dataset.seriesLabel}</strong><span>${Math.round(level)}%</span><small>${time.toLocaleString('pt-BR')}</small>`;
  tooltip.hidden = false;

  const rect = chart.getBoundingClientRect();
  const left = Math.min(Math.max(10, clientX - rect.left + 12), Math.max(10, rect.width - 190));
  const top = Math.max(8, clientY - rect.top - 76);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  historyChartTooltipPinned = pinned ? key : null;
}

function hideHistoryChartTooltip(key, force = false) {
  if (historyChartTooltipPinned === key && !force) return;
  const tooltip = document.querySelector(`[data-history-chart-tooltip="${key}"]`);
  if (tooltip) tooltip.hidden = true;
  if (force && historyChartTooltipPinned === key) historyChartTooltipPinned = null;
}

function pumpRuntimeMockDays(count = 8) {
  const rows = [];
  const base = [
    [6.8, 3.2, 2.1, 1.4], [7.6, 4.0, 2.8, 1.9], [8.4, 4.7, 3.2, 2.2], [9.1, 3.5, 4.1, 2.6],
    [6.7, 4.1, 2.5, 1.8], [7.5, 4.8, 3.3, 2.4], [8.3, 3.6, 3.9, 2.7], [9.0, 4.2, 4.4, 3.0]
  ];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - i);
    const values = base[(count - 1 - i) % base.length];
    rows.push({
      key: localDateKey(date.getTime()),
      date,
      B1: values[0] * 3600000,
      B2: values[1] * 3600000,
      B3: values[2] * 3600000,
      B4: values[3] * 3600000,
      demo: true
    });
  }
  return rows;
}

function getPumpRuntimeDays(count = 8) {
  const rows = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - i);
    const key = localDateKey(date.getTime());
    const day = state.pumpRuntime[key] || {};
    rows.push({
      key,
      date,
      B1: Number(day.B1) || 0,
      B2: Number(day.B2) || 0,
      B3: Number(day.B3) || 0,
      B4: Number(day.B4) || 0,
      demo: false
    });
  }

  const hasRealRuntime = rows.some(row => ['B1', 'B2', 'B3', 'B4'].some(id => row[id] > 0));
  if (!hasRealRuntime && state.source === 'mock') return pumpRuntimeMockDays(count);
  return rows;
}

function pumpRuntimeScale(rows) {
  const maxMs = Math.max(0, ...rows.flatMap(row => ['B1', 'B2', 'B3', 'B4'].map(id => row[id])));
  const maxMinutes = maxMs / 60000;
  const useHours = maxMinutes >= 120;
  const maxValue = useHours ? maxMs / 3600000 : maxMinutes;
  const niceMax = Math.max(useHours ? 1 : 10, Math.ceil(maxValue / 4) * 4);
  return { maxMs: niceMax * (useHours ? 3600000 : 60000), maxValue: niceMax, unit: useHours ? 'h' : 'min' };
}

function formatPumpRuntime(ms) {
  const totalMinutes = Math.max(0, Math.round(Number(ms) / 60000));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

function renderPumpRuntimeChart() {
  const chart = document.querySelector('[data-pump-runtime-chart]');
  const groups = document.querySelector('[data-pump-runtime-groups]');
  const axis = document.querySelector('[data-pump-runtime-axis]');
  const note = document.querySelector('[data-pump-runtime-note]');
  if (!chart || !groups || !axis) return;

  const rows = getPumpRuntimeDays(8);
  const scale = pumpRuntimeScale(rows);
  const pumps = state.pumps.length ? state.pumps : [
    { id: 'B1', flow: 'Fonte → Principal' }, { id: 'B2', flow: 'Principal → Reserva' },
    { id: 'B3', flow: 'Reserva → Principal' }, { id: 'B4', flow: 'Principal → Condomínio' }
  ];

  axis.innerHTML = [4, 3, 2, 1, 0].map(step => {
    const value = scale.maxValue * step / 4;
    const label = Number.isInteger(value) ? String(value) : value.toFixed(1).replace('.', ',');
    return `<span>${label}</span>`;
  }).join('') + `<small>Tempo (${scale.unit})</small>`;

  groups.innerHTML = rows.map(row => {
    const dateLabel = row.date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const bars = pumps.map(pump => {
      const value = Number(row[pump.id]) || 0;
      const height = scale.maxMs ? Math.max(value > 0 ? 2.5 : 0, Math.min(100, value / scale.maxMs * 100)) : 0;
      const fullDate = row.date.toLocaleDateString('pt-BR');
      const label = `${pump.id}, ${pump.flow}: ${formatPumpRuntime(value)} em ${fullDate}`;
      return `<button class="pump-runtime-bar pump-runtime-bar--${pump.id.toLowerCase()}" type="button" style="--pump-height:${height}%" data-pump-runtime-bar data-pump="${pump.id}" data-flow="${pump.flow}" data-runtime="${value}" data-date="${row.date.getTime()}" aria-label="${label}"><span></span></button>`;
    }).join('');
    return `<div class="pump-runtime-day"><div class="pump-runtime-bars">${bars}</div><time datetime="${row.key}">${dateLabel}</time></div>`;
  }).join('');

  if (note) {
    const showingDemo = rows.some(row => row.demo);
    note.textContent = showingDemo
      ? 'Dados demonstrativos enquanto o ESP32 não envia informações de funcionamento.'
      : 'Os tempos são acumulados automaticamente conforme o estado ligado/desligado recebido do ESP32.';
  }
}

function showPumpRuntimeTooltip(bar, clientX, clientY, pinned = false) {
  const chart = document.querySelector('[data-pump-runtime-chart]');
  const tooltip = document.querySelector('[data-pump-runtime-tooltip]');
  if (!chart || !tooltip || !bar) return;

  const date = new Date(Number(bar.dataset.date));
  tooltip.innerHTML = `<strong>${bar.dataset.pump}</strong><span>${bar.dataset.flow}</span><b>${formatPumpRuntime(Number(bar.dataset.runtime))}</b><small>${date.toLocaleDateString('pt-BR')}</small>`;
  tooltip.hidden = false;

  const rect = chart.getBoundingClientRect();
  tooltip.style.left = `${Math.min(Math.max(8, clientX - rect.left + 12), Math.max(8, rect.width - 200))}px`;
  tooltip.style.top = `${Math.max(8, clientY - rect.top - 92)}px`;
  pumpRuntimeTooltipPinned = pinned;
}

function hidePumpRuntimeTooltip(force = false) {
  if (pumpRuntimeTooltipPinned && !force) return;
  const tooltip = document.querySelector('[data-pump-runtime-tooltip]');
  if (tooltip) tooltip.hidden = true;
  if (force) pumpRuntimeTooltipPinned = false;
}

function renderCharts() {
  renderMonitorChart();
  renderHistoryCharts();
  renderPumpRuntimeChart();

  // Resumos e tabela usam as leituras da mesma origem exibida nos gráficos,
  // evitando misturar dados simulados com dados reais recebidos do ESP32.
  const history = liveChartSamples().slice(-20);

  const avg = document.querySelector('[data-history-average]');
  if (avg && history.length) {
    const values = history.flatMap(s => [s.principal, s.reserva]);
    avg.textContent = `${Math.round(values.reduce((a,b) => a+b, 0) / values.length)}%`;
  }
  const pumpCount = document.querySelector('[data-history-pump-count]');
  if (pumpCount) pumpCount.textContent = `${history.reduce((sum, sample) => sum + sample.activePumps, 0)} registros`;
  const alertCount = document.querySelector('[data-history-alert-count]');
  if (alertCount) alertCount.textContent = String(getAlerts().length);
  renderHistoryTable(history);
}

function renderHistoryTable(history) {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody || !history.length) return;
  tbody.innerHTML = history.slice(-8).reverse().map(sample => {
    const date = new Date(sample.time);
    return `<tr><td>${date.toLocaleString('pt-BR')}</td><td><span class="pill pill--blue">${Math.round(sample.principal)}%</span></td><td><span class="pill pill--orange">${Math.round(sample.reserva)}%</span></td><td>${sample.activePumps} bomba(s) ativa(s)</td></tr>`;
  }).join('');
}

function exportHistory() {
  const rows = [['Data e hora', 'Reservatório Principal', 'Reservatório Reserva', 'Bombas ativas']];
  state.samples.forEach(s => rows.push([new Date(s.time).toLocaleString('pt-BR'), `${s.principal}%`, `${s.reserva}%`, s.activePumps]));
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(';')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'aquaflow-historico.csv';
  link.click();
  URL.revokeObjectURL(url);
}

// -----------------------------------------------------------------------------
// ALERTAS
// -----------------------------------------------------------------------------
// Dados de demonstração para a página de alertas no modo mock.
const MOCK_ALERTS = [
  {
    id: 'mock-1', severity: 'critical', label: 'Crítico', title: 'Reservatório reserva com nível baixo',
    description: 'Nível atual: 28% (560 de 2.000 L). Verifique o abastecimento do reservatório reserva.',
    component: 'Reservatório reserva', date: '26/05/2025', time: '10:18', relative: 'Há 6 minutos', status: 'ativo',
    currentValue: '28% (560 de 2.000 litros)', limit: 'Abaixo de 30%', origin: 'Sensor de nível (automático)', alertId: '#ALR-20250526-01',
    recommendations: [
      'Verificar o abastecimento do reservatório reserva.',
      'Confirmar se as bombas de transferência estão operacionais.',
      'Monitorar o nível nas próximas leituras.'
    ]
  },
  {
    id: 'mock-2', severity: 'warning', label: 'Atenção', title: 'Falha na comunicação do sensor',
    description: 'Sem comunicação com o sensor de nível há mais de 5 minutos.',
    component: 'Reservatório principal', date: '26/05/2025', time: '09:47', status: 'ativo',
    currentValue: 'Sem resposta do sensor', limit: 'Máx. 5 min sem leitura', origin: 'Sensor de nível', alertId: '#ALR-20250526-02'
  },
  {
    id: 'mock-3', severity: 'info', label: 'Informativo', title: 'Bomba B2 desligada',
    description: 'Bomba B2 foi desligada manualmente para manutenção programada.',
    component: 'B2 - Reforço', date: '26/05/2025', time: '08:32', status: 'resolvido',
    currentValue: 'B2 desligada', limit: 'Operação normal', origin: 'Painel de controle', alertId: '#ALR-20250526-03'
  },
  {
    id: 'mock-4', severity: 'warning', label: 'Atenção', title: 'Consumo acima da média',
    description: 'Consumo de água 20% acima da média das últimas 24 horas.',
    component: 'Sistema geral', date: '26/05/2025', time: '06:21', status: 'resolvido',
    currentValue: '20% acima da média', limit: 'Até 10% acima da média', origin: 'Análise histórica', alertId: '#ALR-20250526-04'
  },
  {
    id: 'mock-5', severity: 'info', label: 'Informativo', title: 'Retorno da comunicação',
    description: 'Comunicação com o sensor restabelecida.',
    component: 'Reservatório principal', date: '26/05/2025', time: '05:14', status: 'resolvido',
    currentValue: 'Leitura normalizada', limit: 'Comunicação estável', origin: 'Sensor de nível', alertId: '#ALR-20250526-05'
  },
  {
    id: 'mock-6', severity: 'warning', label: 'Atenção', title: 'Nível do reservatório principal em queda',
    description: 'Nível atual: 65%. Monitorar o consumo.',
    component: 'Reservatório principal', date: '26/05/2025', time: '04:12', status: 'resolvido',
    currentValue: '65% (3.250 de 5.000 litros)', limit: 'Abaixo de 60%', origin: 'Sensor de nível', alertId: '#ALR-20250526-06'
  },
  {
    id: 'mock-7', severity: 'info', label: 'Informativo', title: 'Rotina de verificação concluída',
    description: 'Verificação automática do sistema realizada com sucesso.',
    component: 'Sistema', date: '26/05/2025', time: '02:03', status: 'resolvido',
    currentValue: 'Sem inconsistências', limit: '—', origin: 'Rotina automática', alertId: '#ALR-20250526-07'
  },
  { id: 'mock-8', severity: 'success', label: 'Resolvido', title: 'Nível do reservatório reserva normalizado', description: 'O nível retornou à faixa ideal após reabastecimento.', component: 'Reservatório reserva', date: '25/05/2025', time: '21:40', status: 'resolvido', currentValue: '71%', limit: 'Acima de 30%', origin: 'Sensor de nível', alertId: '#ALR-20250525-08' },
  { id: 'mock-9', severity: 'info', label: 'Informativo', title: 'Teste de alarme executado', description: 'Teste manual do sistema de alertas concluído.', component: 'Sistema', date: '25/05/2025', time: '20:15', status: 'resolvido', currentValue: 'Teste concluído', limit: '—', origin: 'Administrador', alertId: '#ALR-20250525-09' },
  { id: 'mock-10', severity: 'success', label: 'Resolvido', title: 'Sensor B1 recalibrado', description: 'Calibração concluída sem intercorrências.', component: 'B1 - Fonte', date: '25/05/2025', time: '18:54', status: 'resolvido', currentValue: 'Leitura estável', limit: '—', origin: 'Manutenção', alertId: '#ALR-20250525-10' },
  { id: 'mock-11', severity: 'info', label: 'Informativo', title: 'Bomba B4 religada', description: 'Retomada do abastecimento para o condomínio.', component: 'B4 - Condomínio', date: '25/05/2025', time: '17:22', status: 'resolvido', currentValue: 'B4 ligada', limit: '—', origin: 'Painel de controle', alertId: '#ALR-20250525-11' },
  { id: 'mock-12', severity: 'warning', label: 'Atenção', title: 'Oscilação no fluxo da fonte', description: 'Variação temporária detectada na captação.', component: 'Fonte', date: '25/05/2025', time: '16:40', status: 'ativo', currentValue: 'Fluxo instável', limit: 'Fluxo constante', origin: 'Sensor de vazão', alertId: '#ALR-20250525-12' },
  { id: 'mock-13', severity: 'success', label: 'Resolvido', title: 'Conectividade do ESP32 restabelecida', description: 'O dispositivo voltou a responder normalmente.', component: 'ESP32', date: '25/05/2025', time: '15:03', status: 'resolvido', currentValue: 'Conectado', limit: '—', origin: 'Módulo de comunicação', alertId: '#ALR-20250525-13' },
  { id: 'mock-14', severity: 'info', label: 'Informativo', title: 'Sincronização de dados concluída', description: 'Os dados históricos foram atualizados.', component: 'Sistema', date: '25/05/2025', time: '13:48', status: 'resolvido', currentValue: 'Sincronizado', limit: '—', origin: 'Servidor local', alertId: '#ALR-20250525-14' },
  { id: 'mock-15', severity: 'success', label: 'Resolvido', title: 'Verificação de bombas concluída', description: 'Todas as bombas responderam corretamente ao autoteste.', component: 'Bombas', date: '25/05/2025', time: '12:12', status: 'resolvido', currentValue: '4 de 4 ok', limit: '—', origin: 'Rotina automática', alertId: '#ALR-20250525-15' }
];

function normalizeAlerts(items) {
  return items.map((a, index) => ({
    id: firstDefined(a.id, index + 1),
    severity: String(firstDefined(a.severity, a.nivel, 'info')).toLowerCase().replace('critico', 'critical').replace('atenção', 'warning').replace('atencao', 'warning').replace('informativo', 'info'),
    label: firstDefined(a.label, a.tipo, 'Informativo'),
    title: firstDefined(a.title, a.titulo, 'Alerta do sistema'),
    description: firstDefined(a.description, a.descricao, ''),
    component: firstDefined(a.component, a.componente, 'Sistema'),
    date: firstDefined(a.date, a.data, ''),
    time: firstDefined(a.time, a.hora, nowTime()),
    relative: firstDefined(a.relative, a.relativo, ''),
    status: firstDefined(a.status, 'ativo'),
    currentValue: firstDefined(a.currentValue, a.valorAtual, '—'),
    limit: firstDefined(a.limit, a.limite, '—'),
    origin: firstDefined(a.origin, a.origem, 'ESP32'),
    alertId: firstDefined(a.alertId, a.codigo, `#ALR-${index + 1}`),
    recommendations: Array.isArray(a.recommendations) ? a.recommendations : undefined
  }));
}

function deriveAlerts() {
  const result = [];
  const add = (severity, title, description, component) => result.push({
    id: `${component}-${severity}`,
    severity,
    label: severity === 'critical' ? 'Crítico' : severity === 'warning' ? 'Atenção' : 'Informativo',
    title, description, component, time: nowTime(), status: 'ativo', currentValue: description,
    limit: severity === 'critical' ? 'Abaixo de 20%' : 'Abaixo de 35%', origin: 'Regra local da interface', alertId: `#AUTO-${component}`
  });
  if (state.reservoirs.principal.level <= 20) add('critical', 'Reservatório principal em nível crítico', `${Math.round(state.reservoirs.principal.level)}%`, 'Reservatório principal');
  else if (state.reservoirs.principal.level <= 35) add('warning', 'Reservatório principal com nível baixo', `${Math.round(state.reservoirs.principal.level)}%`, 'Reservatório principal');
  if (state.reservoirs.reserva.level <= 20) add('critical', 'Reservatório reserva em nível crítico', `${Math.round(state.reservoirs.reserva.level)}%`, 'Reservatório reserva');
  else if (state.reservoirs.reserva.level <= 35) add('warning', 'Reservatório reserva com nível baixo', `${Math.round(state.reservoirs.reserva.level)}%`, 'Reservatório reserva');
  if (!state.connected && state.source !== 'mock') add('warning', 'ESP32 sem comunicação', 'Sem resposta do dispositivo', 'Comunicação');
  return result;
}

let mockAlertsState = null;

function getMockAlerts() {
  if (!mockAlertsState) mockAlertsState = normalizeAlerts(MOCK_ALERTS);
  return mockAlertsState;
}

function getAlerts() {
  if (state.alerts.length) return state.alerts;
  if (state.source === 'mock') return getMockAlerts();
  return deriveAlerts();
}

function getMutableSelectedAlert() {
  const sourceList = (state.source === 'mock' && !state.alerts.length) ? getMockAlerts() : state.alerts;
  return sourceList.find(a => String(a.id) === String(state.selectedAlertId)) || sourceList[0] || null;
}

async function resolveSelectedAlert() {
  const alert = getMutableSelectedAlert();
  if (!alert) {
    showToast('Nenhum alerta selecionado.');
    return;
  }

  if (alert.status === 'resolvido') {
    showToast('Este alerta já está resolvido.');
    return;
  }

  alert.status = 'resolvido';
  alert.resolvedAt = new Date().toISOString();
  renderAlerts();

  if (state.source === 'mock') {
    showToast('Alerta marcado como resolvido na simulação.');
    return;
  }

  try {
    await gateway.sendCommand({ type: 'alert', action: 'resolve', id: alert.id });
    showToast('Resolução enviada ao ESP32.');
  } catch (error) {
    console.error(error);
    showToast('O alerta foi atualizado na tela, mas o ESP32 não confirmou a ação.');
  }
}

let observationDialogAlert = null;

function openObservationDialog() {
  const alert = getMutableSelectedAlert();
  if (!alert) {
    showToast('Nenhum alerta selecionado.');
    return;
  }

  const dialog = document.getElementById('observationDialog');
  const textarea = document.getElementById('observationText');
  if (!dialog || !textarea) return;

  observationDialogAlert = alert;
  const ui = getAlertSeverityUi(alert.severity);
  const statusLabel = alert.status === 'resolvido' ? 'Resolvido' : 'Ativo';

  const iconHost = document.getElementById('observationSeverityIcon');
  if (iconHost) iconHost.innerHTML = `<img src="${ui.icon}" alt="" aria-hidden="true">`;

  const title = document.getElementById('observationAlertTitle');
  const component = document.getElementById('observationAlertComponent');
  const value = document.getElementById('observationAlertValue');
  const status = document.getElementById('observationAlertStatus');
  if (title) title.textContent = alert.title || 'Alerta do sistema';
  if (component) component.textContent = alert.component || 'Sistema';
  if (value) value.textContent = alert.currentValue || '—';
  if (status) status.textContent = statusLabel;

  textarea.value = '';
  const counter = document.getElementById('observationCounter');
  if (counter) counter.textContent = '0';

  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute('open', '');

  requestAnimationFrame(() => textarea.focus());
}

function closeObservationDialog() {
  const dialog = document.getElementById('observationDialog');
  if (!dialog) return;
  if (dialog.open && dialog.close) dialog.close();
  else dialog.removeAttribute('open');
  observationDialogAlert = null;
}

async function saveObservationFromDialog() {
  const alert = observationDialogAlert || getMutableSelectedAlert();
  const textarea = document.getElementById('observationText');
  const note = textarea?.value.trim() || '';

  if (!alert) {
    showToast('Nenhum alerta selecionado.');
    closeObservationDialog();
    return;
  }

  if (!note) {
    textarea?.focus();
    showToast('Escreva uma observação antes de salvar.');
    return;
  }

  alert.observations ??= [];
  alert.observations.push({ text: note, time: nowTime() });
  renderAlertDetail();
  closeObservationDialog();

  if (state.source === 'mock') {
    showToast('Observação adicionada na simulação.');
    return;
  }

  try {
    await gateway.sendCommand({ type: 'alert', action: 'note', id: alert.id, note });
    showToast('Observação enviada ao ESP32.');
  } catch (error) {
    console.error(error);
    showToast('Observação salva na tela; o ESP32 não confirmou o envio.');
  }
}

function getAlertSeverityUi(severity = 'info') {
  const map = {
    critical: {
      icon: 'assets/alert-critical-red.png',
      iconClass: 'alert-severity-icon--critical',
      pillClass: 'alert-severity--critical',
      cardClass: 'alert-item is-critical',
      statusClass: 'alert-status--active',
      detailClass: 'alert-detail__critical',
      recommendationTitle: 'Ações recomendadas'
    },
    warning: {
      icon: 'assets/alert-warning-orange.png',
      iconClass: 'alert-severity-icon--warning',
      pillClass: 'alert-severity--warning',
      cardClass: 'alert-item',
      statusClass: 'alert-status--active',
      detailClass: 'alert-detail__critical alert-detail__warning',
      recommendationTitle: 'Ações recomendadas'
    },
    info: {
      icon: 'assets/alert-info-blue.png',
      iconClass: 'alert-severity-icon--info',
      pillClass: 'alert-severity--info',
      cardClass: 'alert-item',
      statusClass: '',
      detailClass: 'alert-detail__critical alert-detail__info',
      recommendationTitle: 'Informações adicionais'
    },
    success: {
      icon: 'assets/alert-success-green.png',
      iconClass: 'alert-severity-icon--success',
      pillClass: 'alert-severity--success',
      cardClass: 'alert-item',
      statusClass: '',
      detailClass: 'alert-detail__critical alert-detail__success',
      recommendationTitle: 'Confirmações'
    }
  };
  return map[severity] || map.info;
}

function formatAlertRelative(timeLabel) {
  if (!timeLabel || timeLabel === '—') return 'Sem ocorrências';
  return `Registrado às ${timeLabel}`;
}

function renderAlerts() {
  const alerts = getAlerts();
  const active = alerts.filter(a => a.status !== 'resolvido');
  const resolved = alerts.filter(a => a.status === 'resolvido');
  const critical = alerts.filter(a => a.severity === 'critical' && a.status !== 'resolvido');

  document.querySelectorAll('[data-alerts-active]').forEach(el => el.textContent = active.length);
  document.querySelectorAll('[data-alerts-resolved]').forEach(el => el.textContent = resolved.length);
  document.querySelectorAll('[data-alerts-critical]').forEach(el => el.textContent = critical.length);
  document.querySelectorAll('[data-alerts-last-time]').forEach(el => el.textContent = alerts[0]?.time || '—');
  document.querySelectorAll('[data-alerts-last-relative]').forEach(el => el.textContent = alerts[0]?.relative || formatAlertRelative(alerts[0]?.time || '—'));

  document.querySelectorAll('[data-alert-filter-count="todos"]').forEach(el => el.textContent = `(${alerts.length})`);
  document.querySelectorAll('[data-alert-filter-count="ativo"]').forEach(el => el.textContent = `(${active.length})`);
  document.querySelectorAll('[data-alert-filter-count="resolvido"]').forEach(el => el.textContent = `(${resolved.length})`);
  document.querySelectorAll('[data-alert-filter-count="critico"]').forEach(el => el.textContent = `(${critical.length})`);

  const list = document.getElementById('alertList');
  if (!list) return;
  const search = document.getElementById('alertSearch')?.value.trim().toLowerCase() || '';
  const filtered = alerts.filter(a => {
    const filterOk = state.alertFilter === 'todos'
      || (state.alertFilter === 'critico' && a.severity === 'critical')
      || a.status === state.alertFilter;
    const searchOk = !search || `${a.title} ${a.description} ${a.component}`.toLowerCase().includes(search);
    return filterOk && searchOk;
  });

  if (!filtered.some(a => String(a.id) === String(state.selectedAlertId))) {
    state.selectedAlertId = filtered[0]?.id ?? null;
  }

  list.innerHTML = filtered.length
    ? filtered.map(a => {
        const ui = getAlertSeverityUi(a.severity);
        const statusLabel = a.status === 'resolvido' ? 'Resolvido' : 'Ativo';
        const statusClass = a.status === 'resolvido' ? '' : ui.statusClass;
        return `<button class="${ui.cardClass} ${String(a.id) === String(state.selectedAlertId) ? 'is-selected' : ''}" type="button" data-alert-id="${a.id}">
          <span class="alert-severity-icon ${ui.iconClass}"><img src="${ui.icon}" alt="" aria-hidden="true" class="icon-image"></span>
          <span class="alert-severity ${ui.pillClass}">${a.label}</span>
          <span class="alert-item__copy"><strong>${a.title}</strong><small>${a.description}</small></span>
          <span class="alert-meta">${a.component}</span>
          <time class="alert-meta">${a.time}</time>
          <span class="alert-status ${statusClass}">${statusLabel}</span>
        </button>`;
      }).join('')
    : '<p class="empty-state">Nenhum alerta encontrado.</p>';

  renderAlertDetail();
}

function renderAlertDetail() {
  const target = document.getElementById('alertDetail');
  if (!target) return;
  const alert = getAlerts().find(a => String(a.id) === String(state.selectedAlertId)) || getAlerts()[0];
  if (!alert) {
    target.innerHTML = '<div class="empty-state"><strong>Sem alertas ativos</strong><p>O sistema não identificou ocorrências no momento.</p></div>';
    return;
  }

  const ui = getAlertSeverityUi(alert.severity);
  const statusLabel = alert.status === 'resolvido' ? 'Resolvido' : 'Ativo';
  const recommendations = Array.isArray(alert.recommendations) && alert.recommendations.length
    ? alert.recommendations
    : [
        'Verificar o componente afetado e confirmar a leitura recebida.',
        'Monitorar o nível dos reservatórios e o estado das bombas envolvidas.',
        'Registrar a ação executada antes de confirmar a resolução.'
      ];

  target.innerHTML = `
    <div class="alert-detail__title">
      <span class="alert-severity-icon ${ui.iconClass}"><img src="${ui.icon}" alt="" aria-hidden="true" class="icon-image"></span>
      <div>
        <h2>Detalhes do alerta</h2>
        <p>Visualize as informações completas e acompanhe o tratamento da ocorrência.</p>
      </div>
    </div>
    <div class="${ui.detailClass}">
      <div class="top">
        <span class="alert-severity ${ui.pillClass}">${alert.label}</span>
        <span class="alert-status ${alert.status === 'resolvido' ? '' : ui.statusClass}">${statusLabel}</span>
      </div>
      <strong>${alert.title}</strong>
      <p>${alert.description}</p>
    </div>
    <dl class="detail-list">
      <div><dt>Data e hora</dt><dd>${alert.date || '--/--/---- às ' + alert.time}</dd></div>
      <div><dt>Componente afetado</dt><dd>${alert.component}</dd></div>
      <div><dt>Valor atual</dt><dd>${alert.currentValue}</dd></div>
      <div><dt>Limite configurado</dt><dd>${alert.limit}</dd></div>
      <div><dt>Origem do alerta</dt><dd>${alert.origin}</dd></div>
      <div><dt>ID do alerta</dt><dd>${alert.alertId}</dd></div>
    </dl>
    <div class="recommendations">
      <h3>${ui.recommendationTitle}</h3>
      <ol>${recommendations.map(item => `<li>${item}</li>`).join('')}</ol>
    </div>
    ${Array.isArray(alert.observations) && alert.observations.length ? `
      <div class="alert-observations">
        <h3>Observações</h3>
        <ul>${alert.observations.map(item => `<li>${item.text} <small>(${item.time})</small></li>`).join('')}</ul>
      </div>` : ''}
    <div class="detail-actions">
      <button class="button button--primary" data-action="resolve-alert" type="button">Confirmar resolução</button>
      <button class="button button--secondary" data-action="note-alert" type="button">Adicionar observação</button>
    </div>`;
}

// -----------------------------------------------------------------------------
// RENDERIZAÇÃO GERAL
// -----------------------------------------------------------------------------
function renderAll() {
  renderReservoirs();
  renderSummaries();
  renderOperationalStates();
  renderReadings();
  renderControlMessages();
  renderPumpTables();
  renderCommandTimeline();
  renderCharts();
  renderAlerts();

  document.querySelectorAll('[data-mode]').forEach(button => {
    const selected = button.dataset.mode === state.mode;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
}

// -----------------------------------------------------------------------------
// EVENTOS DE INTERFACE
// -----------------------------------------------------------------------------
function bindEvents() {
  const mobileMenuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mainNav');
  const setMobileNavOpen = open => {
    mobileNav?.classList.toggle('is-open', Boolean(open));
    document.body.classList.toggle('nav-open', Boolean(open));
    mobileMenuToggle?.setAttribute('aria-expanded', String(Boolean(open)));
  };

  mobileMenuToggle?.addEventListener('click', event => {
    event.stopPropagation();
    setMobileNavOpen(!mobileNav?.classList.contains('is-open'));
  });

  mobileNav?.querySelectorAll('.nav-item').forEach(item => item.addEventListener('click', () => setMobileNavOpen(false)));

  document.addEventListener('click', event => {
    if (!mobileNav?.classList.contains('is-open')) return;
    if (event.target.closest('#mainNav') || event.target.closest('#menuToggle')) return;
    setMobileNavOpen(false);
  });

  document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => navigateTo(button.dataset.go)));

  document.addEventListener('click', event => {
    const pumpButton = event.target.closest('[data-pump-toggle]');
    if (pumpButton) {
      const id = pumpButton.dataset.pumpToggle;
      const pump = state.pumps.find(p => p.id === id);
      const action = pump?.on ? 'off' : 'on';
      requestConfirmation({
        title: `${action === 'on' ? 'Ligar' : 'Desligar'} ${id}`,
        message: `Confirma ${action === 'on' ? 'o acionamento' : 'o desligamento'} da bomba ${id}?`,
        onConfirm: () => sendUiCommand({ type: 'pump', id, action })
      });
    }

    const alertButton = event.target.closest('[data-alert-id]');
    if (alertButton) {
      state.selectedAlertId = alertButton.dataset.alertId;
      renderAlerts();
    }

    const alertAction = event.target.closest('[data-action]');
    if (alertAction?.dataset.action === 'resolve-alert') {
      resolveSelectedAlert();
    }
    if (alertAction?.dataset.action === 'note-alert') {
      openObservationDialog();
    }
  });

  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    sendUiCommand({ type: 'mode', value: button.dataset.mode });
  }));

  document.querySelectorAll('[data-system-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.systemAction;
    requestConfirmation({
      title: action === 'start' ? 'Iniciar abastecimento' : 'Parar abastecimento',
      message: action === 'start' ? 'Confirma o início do abastecimento?' : 'Confirma a parada das bombas em operação?',
      onConfirm: () => sendUiCommand({ type: 'system', action })
    });
  }));

  document.getElementById('confirmDialog')?.addEventListener('close', event => {
    const dialog = event.currentTarget;
    if (dialog.returnValue === 'confirm' && typeof pendingAction === 'function') pendingAction();
    pendingAction = null;
  });


  const observationDialog = document.getElementById('observationDialog');
  document.getElementById('observationClose')?.addEventListener('click', closeObservationDialog);
  document.getElementById('observationCancel')?.addEventListener('click', closeObservationDialog);
  document.getElementById('observationText')?.addEventListener('input', event => {
    const counter = document.getElementById('observationCounter');
    if (counter) counter.textContent = String(event.target.value.length);
  });
  document.getElementById('observationForm')?.addEventListener('submit', event => {
    event.preventDefault();
    saveObservationFromDialog();
  });
  observationDialog?.addEventListener('click', event => {
    if (event.target === observationDialog) closeObservationDialog();
  });
  observationDialog?.addEventListener('cancel', event => {
    event.preventDefault();
    closeObservationDialog();
  });

  // Navegação do gráfico de monitoramento. Cada clique move uma janela inteira
  // de leituras para facilitar a consulta de valores anteriores.
  document.querySelector('[data-live-chart-prev]')?.addEventListener('click', () => {
    const { start } = getLiveChartWindow();
    if (start === 0) return;
    liveChartOffset = Math.min(liveChartOffset + LIVE_CHART_WINDOW, Math.max(0, liveChartSamples().length - LIVE_CHART_WINDOW));
    hideLiveChartTooltip(true);
    renderMonitorChart();
  });

  document.querySelector('[data-live-chart-next]')?.addEventListener('click', () => {
    liveChartOffset = Math.max(0, liveChartOffset - LIVE_CHART_WINDOW);
    hideLiveChartTooltip(true);
    renderMonitorChart();
  });

  document.querySelector('[data-live-chart-now]')?.addEventListener('click', () => {
    liveChartOffset = 0;
    hideLiveChartTooltip(true);
    renderMonitorChart();
  });

  const liveChart = document.querySelector('[data-live-chart]');
  liveChart?.addEventListener('pointermove', event => {
    const point = event.target.closest?.('[data-chart-point]');
    if (point) showLiveChartTooltip(point, event.clientX, event.clientY, false);
    else hideLiveChartTooltip();
  });
  liveChart?.addEventListener('pointerleave', () => hideLiveChartTooltip());
  liveChart?.addEventListener('click', event => {
    const point = event.target.closest?.('[data-chart-point]');
    if (!point) {
      hideLiveChartTooltip(true);
      return;
    }
    showLiveChartTooltip(point, event.clientX, event.clientY, true);
  });
  liveChart?.addEventListener('focusin', event => {
    const point = event.target.closest?.('[data-chart-point]');
    if (!point) return;
    const rect = point.getBoundingClientRect();
    showLiveChartTooltip(point, rect.left + rect.width / 2, rect.top, true);
  });
  liveChart?.addEventListener('focusout', () => hideLiveChartTooltip(true));

  // Navegação do histórico de níveis. As duas séries avançam juntas para
  // manter a comparação entre os reservatórios no mesmo intervalo de tempo.
  document.querySelectorAll('[data-history-chart-prev]').forEach(button => button.addEventListener('click', () => {
    const { start } = getHistoryChartWindow();
    if (start === 0) return;
    historyChartOffset = Math.min(
      historyChartOffset + HISTORY_CHART_WINDOW,
      Math.max(0, liveChartSamples().length - HISTORY_CHART_WINDOW)
    );
    document.querySelectorAll('[data-history-chart-tooltip]').forEach(tooltip => { tooltip.hidden = true; });
    historyChartTooltipPinned = null;
    renderHistoryCharts();
  }));

  document.querySelectorAll('[data-history-chart-next]').forEach(button => button.addEventListener('click', () => {
    historyChartOffset = Math.max(0, historyChartOffset - HISTORY_CHART_WINDOW);
    document.querySelectorAll('[data-history-chart-tooltip]').forEach(tooltip => { tooltip.hidden = true; });
    historyChartTooltipPinned = null;
    renderHistoryCharts();
  }));

  document.querySelectorAll('[data-history-chart-now]').forEach(button => button.addEventListener('click', () => {
    historyChartOffset = 0;
    document.querySelectorAll('[data-history-chart-tooltip]').forEach(tooltip => { tooltip.hidden = true; });
    historyChartTooltipPinned = null;
    renderHistoryCharts();
  }));

  document.querySelectorAll('[data-history-chart]').forEach(chart => {
    const key = chart.dataset.historyChart;

    chart.addEventListener('pointermove', event => {
      const point = event.target.closest?.('[data-history-chart-point]');
      if (point) showHistoryChartTooltip(chart, point, event.clientX, event.clientY, false);
      else hideHistoryChartTooltip(key);
    });

    chart.addEventListener('pointerleave', () => hideHistoryChartTooltip(key));

    chart.addEventListener('click', event => {
      const point = event.target.closest?.('[data-history-chart-point]');
      if (!point) {
        hideHistoryChartTooltip(key, true);
        return;
      }
      showHistoryChartTooltip(chart, point, event.clientX, event.clientY, true);
    });

    chart.addEventListener('focusin', event => {
      const point = event.target.closest?.('[data-history-chart-point]');
      if (!point) return;
      const rect = point.getBoundingClientRect();
      showHistoryChartTooltip(chart, point, rect.left + rect.width / 2, rect.top, true);
    });

    chart.addEventListener('focusout', () => hideHistoryChartTooltip(key, true));
  });

  document.querySelectorAll('[data-alert-filter]').forEach(button => button.addEventListener('click', () => {
    state.alertFilter = button.dataset.alertFilter;
    document.querySelectorAll('[data-alert-filter]').forEach(b => b.classList.toggle('is-active', b === button));
    renderAlerts();
  }));
  document.getElementById('alertSearch')?.addEventListener('input', renderAlerts);

  document.getElementById('exportHistory')?.addEventListener('click', exportHistory);
  const pumpRuntimeChart = document.querySelector('[data-pump-runtime-chart]');
  if (pumpRuntimeChart) {
    pumpRuntimeChart.addEventListener('pointermove', event => {
      const bar = event.target.closest?.('[data-pump-runtime-bar]');
      if (bar) showPumpRuntimeTooltip(bar, event.clientX, event.clientY, false);
    });
    pumpRuntimeChart.addEventListener('pointerleave', () => hidePumpRuntimeTooltip());
    pumpRuntimeChart.addEventListener('click', event => {
      const bar = event.target.closest?.('[data-pump-runtime-bar]');
      if (!bar) { hidePumpRuntimeTooltip(true); return; }
      showPumpRuntimeTooltip(bar, event.clientX, event.clientY, true);
    });
    pumpRuntimeChart.addEventListener('focusin', event => {
      const bar = event.target.closest?.('[data-pump-runtime-bar]');
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      showPumpRuntimeTooltip(bar, rect.left + rect.width / 2, rect.top, true);
    });
    pumpRuntimeChart.addEventListener('focusout', () => hidePumpRuntimeTooltip(true));
  }

  document.getElementById('applyPeriod')?.addEventListener('click', () => showToast('Período aplicado ao histórico local.'));
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('is-active', b === button));
  }));
}



// -----------------------------------------------------------------------------
// CABEÇALHO — notificações e menu do usuário
// -----------------------------------------------------------------------------
function setupTopBarInteractions() {
  const notificationToggle = document.getElementById('notificationToggle');
  const notificationPanel = document.getElementById('notificationPanel');
  const notificationDot = notificationToggle?.querySelector('.notification-dot');
  const userMenuToggle = document.getElementById('userMenuToggle');
  const userPanel = document.getElementById('userPanel');

  const NOTIFICATIONS_READ_KEY = 'aquaflow.notificationsRead';
  const notificationsAlreadyRead = localStorage.getItem(NOTIFICATIONS_READ_KEY) === 'true';
  notificationDot?.classList.toggle('is-read', notificationsAlreadyRead);

  const closePanel = (toggle, panel) => {
    if (!toggle || !panel) return;
    toggle.setAttribute('aria-expanded', 'false');
    panel.hidden = true;
  };

  const openPanel = (toggle, panel) => {
    if (!toggle || !panel) return;
    toggle.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
  };

  const closeAllPanels = () => {
    closePanel(notificationToggle, notificationPanel);
    closePanel(userMenuToggle, userPanel);
  };

  notificationToggle?.addEventListener('click', event => {
    event.stopPropagation();

    // Ao abrir as notificações, elas passam a ser consideradas visualizadas.
    // O estado fica salvo entre páginas/recarregamentos até surgirem novas notificações.
    notificationDot?.classList.add('is-read');
    localStorage.setItem(NOTIFICATIONS_READ_KEY, 'true');

    const shouldOpen = notificationPanel?.hidden;
    closeAllPanels();
    if (shouldOpen) openPanel(notificationToggle, notificationPanel);
  });

  userMenuToggle?.addEventListener('click', event => {
    event.stopPropagation();
    const shouldOpen = userPanel?.hidden;
    closeAllPanels();
    if (shouldOpen) openPanel(userMenuToggle, userPanel);
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.header-action')) closeAllPanels();

    const logoutButton = event.target.closest('[data-action="logout"]');
    if (logoutButton) {
      closeAllPanels();
      logoutButton.disabled = true;
      localStorage.removeItem('aquaflow_demo_session');
      const target = location.protocol === 'file:' ? 'login.html' : '/login.html';
      fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
        .catch(() => null)
        .finally(() => { window.location.href = target; });
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAllPanels();
  });
}

// -----------------------------------------------------------------------------
// INICIALIZAÇÃO
// -----------------------------------------------------------------------------
function boot() {
  bindEvents();
  setupTopBarInteractions();
  state.alerts = deriveAlerts();
  recordSample();
  renderAll();
  gateway.start();
}

document.addEventListener('DOMContentLoaded', boot);
