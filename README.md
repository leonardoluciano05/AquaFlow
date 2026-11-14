# AquaFlow — Front-end Web preparado para ESP32

Este diretório usa **um HTML por página**, mas compartilha um único `styles.css` e um único `script.js`.

## Estrutura

- `index.html` — Início / dashboard
- `monitoramento.html` — Monitoramento em tempo real
- `controle.html` — Controle das bombas e modo do sistema
- `historico.html` — Histórico local das leituras
- `alertas.html` — Lista e detalhes de alertas
- `styles.css` — Estilos compartilhados entre todas as páginas
- `script.js` — Estado, integração com ESP32, atualização da interface e comandos

## Onde configurar o ESP32

No início de `script.js` existe o objeto `AQUAFLOW_CONFIG`:

```js
const AQUAFLOW_CONFIG = {
  transport: 'auto',
  espBaseUrl: 'http://192.168.4.1',
  statusPath: '/api/status',
  commandPath: '/api/command',
  websocketPath: '/ws',
  pollIntervalMs: 2000
};
```

Se o ESP32 estiver conectado ao roteador, altere `espBaseUrl` para o IP dele, por exemplo:

```js
espBaseUrl: 'http://192.168.0.120'
```

Também é possível testar sem editar o arquivo:

```text
http://localhost:5500/index.html?esp=192.168.0.120
```

O endereço informado na URL fica salvo no navegador.

## JSON esperado em `GET /api/status`

```json
{
  "online": true,
  "mode": "automatico",
  "supplyRunning": true,
  "reservoirs": {
    "principal": {
      "level": 78,
      "liters": 3900,
      "capacity": 5000
    },
    "reserva": {
      "level": 55,
      "liters": 1100,
      "capacity": 2000
    }
  },
  "pumps": {
    "B1": true,
    "B2": false,
    "B3": false,
    "B4": true
  },
  "sensors": {
    "online": 4,
    "total": 4
  },
  "alerts": []
}
```

`level` deve ficar entre `0` e `100`. O JavaScript usa esse valor para subir/descer o preenchimento de água dentro do indicador circular.

## Comandos enviados ao ESP32

A interface envia `POST /api/command` com JSON.

Ligar uma bomba:

```json
{ "type": "pump", "id": "B1", "action": "on" }
```

Desligar:

```json
{ "type": "pump", "id": "B1", "action": "off" }
```

Mudar o modo:

```json
{ "type": "mode", "value": "automatico" }
```

Iniciar/parar o abastecimento:

```json
{ "type": "system", "action": "start" }
```

## Modo de simulação

Enquanto o ESP32 não responde, `transport: 'auto'` mantém uma simulação visual para o site continuar demonstrável. O navegador continua tentando conectar ao ESP; quando ele começa a responder, os dados reais substituem automaticamente a simulação.

Se quiser desativar a simulação e mostrar somente dados reais, altere:

```js
fallbackToMock: false
```

## CORS

Se o site estiver rodando no computador e o ESP32 estiver em outro endereço IP, o servidor HTTP do ESP32 deve permitir CORS, por exemplo:

```text
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

Outra opção é servir estes arquivos diretamente pelo próprio ESP32, eliminando a diferença de origem.

## Gráfico de monitoramento em tempo real

A página `monitoramento.html` registra uma amostra a cada checagem do ESP32 e mantém essas leituras no navegador (`localStorage`). Com a configuração padrão de 2 segundos, o histórico local armazena aproximadamente 30 minutos.

Cada leitura gera um ponto no gráfico para o Reservatório Principal e para o Reservatório Reserva. Ao passar o mouse, tocar ou focar um ponto, a interface mostra:

- reservatório da leitura;
- nível em porcentagem;
- data e hora da coleta.

Os botões de seta acima do gráfico navegam pelas janelas anteriores de leitura. O botão `Agora` retorna imediatamente para os dados mais recentes. Enquanto o usuário consulta uma janela antiga, novas leituras continuam sendo recebidas sem puxar o gráfico de volta para o presente.

O intervalo do histórico pode ser alterado em `AQUAFLOW_CONFIG`:

```js
pollIntervalMs: 2000,   // consulta ao ESP a cada 2 segundos
sampleIntervalMs: 2000, // cria um ponto a cada consulta
historyLimit: 900       // quantidade máxima de pontos mantidos
```

## Gráficos do histórico de níveis

A página `historico.html` usa as mesmas leituras armazenadas pelo monitoramento e exibe os dois reservatórios em gráficos separados.

Cada leitura é desenhada como um ponto interativo. Ao passar o mouse, tocar ou focar um ponto, o site mostra:

- qual reservatório gerou a leitura;
- nível em porcentagem;
- data e hora exatas da coleta.

As setas acima dos gráficos permitem voltar para janelas anteriores e depois avançar novamente. O botão `Mais recentes` retorna para as últimas leituras recebidas. Os dois gráficos navegam juntos para manter a comparação entre os reservatórios no mesmo intervalo.

No momento, esse histórico usa as amostras mantidas no `localStorage`. Para consultar dias ou semanas mesmo depois de limpar o navegador ou acessar por outro computador, o próximo passo é salvar as leituras em um backend/banco de dados e carregar o período solicitado pela página de Histórico.

### Tempo de funcionamento das bombas

A página `historico.html` calcula o tempo diário de funcionamento de B1–B4 a partir do estado ligado/desligado recebido em cada telemetria. O acumulado é salvo em `localStorage` e alimenta o gráfico de barras agrupadas por data.

Para um histórico mais preciso (inclusive quando o navegador estiver fechado), o ESP32 também pode enviar o acumulado do dia. São aceitos, por exemplo:

```json
{
  "pumpRuntimeSeconds": { "B1": 3600, "B2": 1800, "B3": 900, "B4": 1200 }
}
```

ou `pumpRuntimeMs` com valores em milissegundos. Também são aceitos `runtimeSecondsToday` dentro de cada bomba quando `pumps.B1`, `pumps.B2` etc. forem objetos.


## Logo do AquaFlow

A logo padrão do cabeçalho está em `assets/logo-aquaflow-official.png`. Todos os cinco HTMLs usam esse mesmo arquivo.

Para trocar a logo no futuro, substitua apenas `assets/logo-aquaflow-official.png` por outra imagem mantendo o mesmo nome. O tamanho visual é controlado pela classe `.brand__logo` no `styles.css`.


## Ícones personalizados adicionados
Os PNGs enviados foram organizados em `assets/` com nomes fáceis de localizar.
Principais arquivos:
- `icon-tank-primary-blue.png`
- `icon-tank-reserve-orange.png`
- `icon-wifi-green.png`
- `icon-pump-purple.png`
- `icon-building-purple.png`
- `icon-wave-blue.png`
- `icon-gear-blue.png`
- `icon-drop-green.png`
- `icon-building-green.png`
- `icon-esp32-gray.png`
- `nav-inicio-final.png`
- `nav-monitoramento-final.png`
- `nav-controle-final.png`
- `nav-historico-final.png`
- `nav-alertas-final.png`

Se quiser trocar alguma imagem depois, basta substituir o arquivo correspondente dentro da pasta `assets/`.


## Ajuste v10 — Controle
- Tela de Controle refinada visualmente com base no protótipo do Figma.
- Ícones de modo automático/manual corrigidos e padronizados.
- Mensagens de segurança não são mais influenciadas pelos alertas demonstrativos da página de Alertas.
- Tabela de bombas ganhou indicadores visuais de estado e melhor legibilidade.
- Histórico de comandos exibe dados demonstrativos apenas enquanto o sistema está em modo simulação.


### Ajuste v15
- Ícone do modo manual redesenhado com a mão completa e sem recortes nos dedos.

## Autenticação, banco de dados e login

O projeto agora inclui um servidor Node.js com autenticação e banco SQLite.

### Requisitos

- Node.js 18 ou superior
- npm

### Instalação

1. Abra o terminal na pasta do projeto.
2. Rode `npm install`.
3. Copie `.env.example` para `.env`.
4. Defina uma `SESSION_SECRET` forte.
5. Rode `npm start`.
6. Acesse `http://localhost:3000`.

### Cadastro e verificação de e-mail

O cadastro grava as contas em `data/aquaflow.sqlite`. O sistema cria um código de 6 dígitos com validade de 10 minutos.

- Em desenvolvimento, se SMTP não estiver configurado, o código aparece no terminal e também na interface para facilitar testes locais.
- Em produção, configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e `SMTP_FROM` no `.env`. O código deixa de ser exposto na interface quando `NODE_ENV=production`.

### Login com Google

Crie um OAuth Client ID do tipo Web no Google Cloud Console e coloque o valor em `GOOGLE_CLIENT_ID` no `.env`. A origem autorizada do ambiente local deve incluir `http://localhost:3000`.

### Sessão e proteção do painel

As páginas `index.html`, `monitoramento.html`, `controle.html`, `historico.html` e `alertas.html` são servidas pelo backend somente para usuários autenticados. O botão **Sair** encerra a sessão e retorna ao login.

### Observação de produção

Antes de publicar, use HTTPS, uma `SESSION_SECRET` longa e aleatória, SMTP real e configure corretamente o OAuth do Google para o domínio final.
