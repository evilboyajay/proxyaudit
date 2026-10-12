# Contributing to ProxyAudit

Thanks for helping out! Bug reports, features, plugins and docs are all welcome.

## Getting started

You need Node.js 24 LTS or newer. With [nvm](https://github.com/nvm-sh/nvm),
`nvm use` picks the right version from `.nvmrc`.

```bash
git clone https://github.com/<you>/proxyaudit.git
cd proxyaudit
nvm use
npm install
npm start        # or: npm run dev
```

## Before you open a pull request

- Run `npm run qa` and make sure everything passes.
- Keep the renderer sandboxed. New main-process features go through
  `src/preload/preload.js`; never enable `nodeIntegration`.
- Match the existing style: plain JavaScript, no framework, small focused modules.
- One logical change per PR, with a description of what changed and why.
- For large changes, open an issue first so we can agree on the approach.

## Good first contributions

- Windows / Linux support
- HTTP/2 in the proxy engine
- Example plugins (see the template in `src/main/plugins.js`)
- Docs, screenshots and bug reports with reproduction steps

## Reporting security issues

Please don't file public issues for vulnerabilities in ProxyAudit itself.
Use [GitHub Security Advisories](https://github.com/evilboyajay/proxyaudit/security/advisories/new).

## Responsible use

ProxyAudit is for authorized security testing only. Contributions whose main
purpose is to attack systems without permission won't be accepted.

By contributing, you agree that your contributions are licensed under the MIT License.
