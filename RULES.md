# Repository Rules

This document describes the basic rules for working in this repository.

## 1. Branch Rules

- Keep `main` as the stable branch.
- Do not commit experimental or unfinished work directly to `main`.
- Use feature branches for changes, for example `feature/add-login` or `fix/upload-error`.
- Delete merged branches when they are no longer needed.

## 2. Commit Rules

- Make commits small and focused.
- Use clear commit messages, for example:
  - `Add initial project rules`
  - `Fix upload path handling`
  - `Update README setup steps`
- Do not commit temporary files, build output, secrets, passwords, tokens, or private keys.

## 3. Pull Request Rules

- Use pull requests for non-trivial changes.
- Explain what changed and why.
- Link related issues when possible.
- Make sure the project still builds or runs before merging.
- Prefer review before merging important changes.

## 4. Issue Rules

- Use issues to track bugs, tasks, ideas, and feature requests.
- Include enough context to reproduce bugs:
  - What happened
  - What you expected
  - Steps to reproduce
  - Screenshots or logs when useful
- Keep issue titles short and specific.

## 5. File And Code Rules

- Keep file names readable and consistent.
- Avoid large binary files unless they are necessary.
- Add a `.gitignore` before committing generated files or local-only files.
- Keep code and documentation in sync.
- Prefer simple, maintainable changes over unnecessary complexity.

## 6. Security Rules

- Never commit credentials, API keys, tokens, `.env` files, private keys, or account passwords.
- If a secret is committed by mistake, rotate or revoke it immediately.
- Report security-sensitive problems privately instead of opening a public issue.
- Review third-party dependencies before adding them.

## 7. Recommended GitHub Settings

These rules are configured in GitHub repository settings, not only in files:

- Protect the `main` branch.
- Require pull requests before merging into `main`.
- Require status checks to pass before merging when CI is available.
- Require at least one approving review for important projects.
- Enable secret scanning and Dependabot alerts.
- Use repository visibility carefully: private by default, public only when ready.

## 8. Recommended Repository Files

Common GitHub repositories usually include some of these files:

- `README.md`: project introduction, setup, and usage.
- `.gitignore`: files Git should not track.
- `LICENSE`: open-source license, if the repository is public.
- `CONTRIBUTING.md`: contribution process and development workflow.
- `CODE_OF_CONDUCT.md`: community behavior rules for public projects.
- `SECURITY.md`: how to report security issues.
- `.github/CODEOWNERS`: default reviewers or owners for files.
- `.github/pull_request_template.md`: pull request checklist.
- `.github/ISSUE_TEMPLATE/`: bug report and feature request templates.
- `.github/workflows/`: GitHub Actions automation.
