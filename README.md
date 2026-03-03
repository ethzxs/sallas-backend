# sallas-wpp-service

Microserviço simples para conectar ao WhatsApp via whatsapp-web.js.

Como usar:

1. Instalar dependências: `npm install`
2. Rodar em desenvolvimento: `npm run dev`
3. Acessar `http://localhost:3333/qr` para obter o QR (imagem PNG).

Arquivos importantes:
- `index.js` — servidor Express e integração com WhatsApp
- `.env` — configurações

OBS: O WhatsApp Web pode abrir uma instância do Chromium para autenticação. Salvará sessão em `./.local-auth`.

Node (versão)
----------------

Use **Node.js 20 (LTS)**. Não use Node 22 — detectamos instabilidade com `whatsapp-web.js` e Node 22 (erro: "Protocol error (Runtime.callFunctionOn): Execution context was destroyed").

Verifique a versão instalada com:

```powershell
node -v
```

Se necessário, instale ou troque para Node 20 (por exemplo usando nvm-windows).

Limpeza e reinstalação de dependências (PowerShell)
-------------------------------------------------

Execute os comandos abaixo na pasta do projeto para forçar reinstalação das dependências:

```powershell
Remove-Item -Recurse -Force .\node_modules
Remove-Item -Force .\package-lock.json
npm i
```

Observações:
- Mantenha `type": "module"` em `package.json` e os scripts `dev`/`start` (o projeto depende disso).
- Não altere `index.js` quando seguir essas etapas.
