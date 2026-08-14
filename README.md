# Topologia NOC — Cloudflare Worker + D1

## Binding que você mostrou no Cloudflare

Seu print mostra:

- Assets: `ASSETS`
- D1 database binding: `bd`

O `src/worker.js` já aceita exatamente `env.bd`.

## Login inicial

```text
Usuário: admin
Senha: admin
```

O Worker cria automaticamente o usuário administrador na primeira chamada da API.

## Publicação

1. Coloque `src/worker.js` no projeto.
2. Garanta que os arquivos do site estejam em `public/`.
3. Configure o D1 no Worker.
4. O binding precisa ser:

```text
Variable name: bd
D1 database: seu banco
```

5. O Assets binding precisa ser:

```text
Variable name: ASSETS
Directory: public
```

6. Faça o deploy.

## Testar

Abra:

```text
https://SEU-WORKER.workers.dev/api/health
```

Deve retornar algo parecido com:

```json
{
  "ok": true,
  "service": "topologia-noc",
  "database": "D1",
  "binding": "bd"
}
```

Depois abra a tela de login.

O navegador fará:

```http
POST /api/auth/login
```

e o Worker responderá diretamente.

## Se o seu banco tiver outro nome

O nome visível do banco não é o mais importante. O importante é o **Variable name** do binding.

Se estiver:

```text
bd
```

não altere o código.

Se você mudar para:

```text
DB
```

o Worker também aceita `env.DB`.

## Importante

O código cria as tabelas automaticamente com `CREATE TABLE IF NOT EXISTS`, portanto você não precisa executar manualmente o SQL apenas para testar o login.

O arquivo `migrations/0001_initial.sql` fica disponível para uma implantação organizada por migrations.

## Segurança

A senha não é armazenada em texto puro. O Worker usa PBKDF2-SHA-256 com salt.

A sessão utiliza cookie:

- HttpOnly
- Secure
- SameSite=Lax

Os eventos de login, login inválido e logout são registrados em `audit_logs`.

Depois que o login estiver funcionando, o próximo passo é migrar as APIs de usuários, perfis, permissões, telas, auditoria e topologia para o mesmo Worker/D1.
